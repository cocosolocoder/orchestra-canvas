import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A business operation that stays pending until the test releases it, plus a
// promise that fires once the engine has actually invoked it (and is therefore
// parked on its await).
function gatedHold(name = 'hold', result = 'held') {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let invocations = 0;
  const operations = {
    [name]: () => {
      invocations += 1;
      markStarted();
      return gate.then(() => result);
    },
  };
  return { release, started, operations, invocationCount: () => invocations };
}

// start -> wait (business operation "hold") -> gate (condition)
//        -> approved / rejected (two ends)
function thresholdWorkflow(condition, { compensable = false, extraNodes = [] } = {}) {
  const gateNode = {
    id: 'gate', type: 'condition', condition, then: 'approved', else: 'rejected',
  };
  const waitNode = { id: 'wait', type: 'action', operation: 'hold', next: 'gate' };
  if (compensable) waitNode.compensation = { operation: 'undo' };
  const workflow = {
    id: 'condition-rule-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'wait' },
      waitNode,
      gateNode,
      { id: 'approved', type: 'end', result: 'approved' },
      { id: 'rejected', type: 'end', result: 'rejected' },
      ...extraNodes,
    ],
  };
  return { workflow, gateNode, waitNode };
}

// Park the run inside "hold", run `mutate` while it waits, then resume.
async function parkMutateAndResume(workflow, input, operations, mutate) {
  const hold = gatedHold();
  const merged = { ...hold.operations, ...operations };
  const runPromise = executeWorkflowAsync(workflow, input, merged);
  await hold.started;
  // Let the engine settle onto its await of the pending operation.
  await sleep(5);
  mutate();
  hold.release();
  return runPromise;
}

test('a run parked on a business action keeps the condition validated at its own start', async () => {
  const condition = { field: 'amount', operator: 'gte', value: 80 };
  const { workflow, gateNode } = thresholdWorkflow(condition);

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    // While the earlier run waits: raise the threshold and independently
    // re-validate the very same definition.
    gateNode.condition = { field: 'amount', operator: 'gte', value: 100 };
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // amount 90 passes the start-time threshold of 80, even though it is 100 now.
  assert.equal(result.result, 'approved');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'gate', 'approved']);

  // A new run against the re-validated definition is held to the new threshold.
  const immediate = { hold: async () => 'held-2' };
  assert.equal((await executeWorkflowAsync(workflow, { amount: 90 }, immediate)).result, 'rejected');
  assert.equal((await executeWorkflowAsync(workflow, { amount: 100 }, immediate)).result, 'approved');
});

test('a revalidation that compiles the new condition but fails on a later node still reports the error and keeps the parked rule', async () => {
  // "ghost" is declared after gate: this pass compiles gate's new condition
  // first and only then fails on ghost's unknown successor. That partial
  // recompile must neither be swallowed nor reach the parked run.
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'approved' };
  const { workflow, gateNode } = thresholdWorkflow(
    { field: 'amount', operator: 'gte', value: 80 }, { extraNodes: [ghostNode] });

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, { amount: 90 }, hold.operations);
  await hold.started;
  await sleep(5);

  gateNode.condition = { field: 'amount', operator: 'gte', value: 100 };
  ghostNode.next = 'nowhere';
  assert.throws(
    () => validateWorkflow(workflow),
    /node ghost points to an unknown destination/,
  );

  hold.release();
  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'approved');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'gate', 'approved']);
});

test('mutating the parked condition node directly without revalidating never reaches the run', async () => {
  const { workflow, gateNode } = thresholdWorkflow(
    { field: 'amount', operator: 'gte', value: 80 });

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    // No validateWorkflow call at all: the run must not re-read the live node.
    gateNode.condition = { field: 'amount', operator: 'gte', value: 100 };
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'approved');
});

test('in-place edits to the compiled tree — constant, field path, child order — cannot alias into a parked run', async () => {
  const condition = { all: [
    { field: 'amount', operator: 'gte', value: 80 },
    { field: 'ok', operator: 'eq', value: true },
  ] };
  const { workflow, gateNode } = thresholdWorkflow(condition);

  const result = await parkMutateAndResume(workflow, { amount: 90, ok: true }, {}, () => {
    // Mutate the very objects/arrays the run started from, then revalidate.
    // The run's compiled tree copied the constant and the child list at its
    // own start, so none of these reach it.
    gateNode.condition.all[0].value = 100;
    gateNode.condition.all[0].field = 'missing-total';
    gateNode.condition.all.reverse();
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // Old tree, old order: amount 90 >= 80 and ok === true both hold.
  assert.equal(result.result, 'approved');
});

test('two runs sharing one condition node stay isolated whichever run finishes first', async () => {
  async function scenario(releaseOrder) {
    const { workflow, gateNode } = thresholdWorkflow(
      { field: 'amount', operator: 'gte', value: 80 });

    // Each invocation of "hold" gets its own independent gate, in start order.
    const gates = [];
    let nextGate = 0;
    const operations = {
      hold: () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const index = nextGate;
        nextGate += 1;
        gates.push({ release });
        return gate.then(() => `held-${index}`);
      },
    };

    // Run A starts under the original threshold (80) and parks.
    const runA = executeWorkflowAsync(workflow, { amount: 90 }, operations);
    while (gates.length < 1) await sleep(1);
    await sleep(5);

    // The shared definition changes and is independently re-validated.
    gateNode.condition = { field: 'amount', operator: 'gte', value: 100 };
    validateWorkflow(workflow);

    // Run B starts under the new threshold (100) and parks too.
    const runB = executeWorkflowAsync(workflow, { amount: 90 }, operations);
    while (gates.length < 2) await sleep(1);
    await sleep(5);

    if (releaseOrder === 'B-first') {
      gates[1].release();
      gates[0].release();
    } else {
      gates[0].release();
      gates[1].release();
    }

    const [a, b] = await Promise.all([runA, runB]);
    return { a, b };
  }

  for (const order of ['B-first', 'A-first']) {
    const { a, b } = await scenario(order);
    assert.equal(a.status, 'completed', `A completes (${order})`);
    assert.equal(a.result, 'approved', `A keeps its start-time >= 80 rule (${order})`);
    assert.equal(b.status, 'completed', `B completes (${order})`);
    assert.equal(b.result, 'rejected', `B uses the new >= 100 rule (${order})`);
  }
});

test('the whole pinned tree covers nested all/any/not, child order, constants, field paths and output references', async () => {
  // start -> wait (hold) -> fetch (business output { score }) -> gate -> high/low
  const condition = { all: [
    { any: [
      { outputField: { nodeId: 'fetch', path: 'score' }, operator: 'gte', value: 80 },
      { field: 'flag', operator: 'eq', value: true },
    ] },
    { not: { field: 'blocked', operator: 'eq', value: true } },
  ] };
  const gateNode = { id: 'gate', type: 'condition', condition, then: 'high', else: 'low' };
  const workflow = {
    id: 'compound-tree', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'wait' },
      { id: 'wait', type: 'action', operation: 'hold', next: 'fetch' },
      { id: 'fetch', type: 'action', operation: 'fetchScore', next: 'gate' },
      gateNode,
      { id: 'high', type: 'end', result: 'high' },
      { id: 'low', type: 'end', result: 'low' },
    ],
  };

  // The run parks on wait; fetch (and its output) only happens after resume,
  // proving the pinned expression still reads action data returned this run.
  const result = await parkMutateAndResume(
    workflow, { blocked: false }, { fetchScore: () => ({ score: 90 }) },
    () => {
      // New constant 100, output path renamed, not child field swapped: a
      // fully different valid tree.
      gateNode.condition = { all: [
        { any: [
          { outputField: { nodeId: 'fetch', path: 'level' }, operator: 'gte', value: 100 },
          { field: 'flag', operator: 'eq', value: true },
        ] },
        { not: { field: 'blocked', operator: 'eq', value: false } },
      ] };
      validateWorkflow(workflow);
    });

  assert.equal(result.status, 'completed');
  // Old tree: fetch.score 90 >= 80 short-circuits the any; not(blocked===true)
  // is true — so the run goes high even though the definition now says level/100.
  assert.equal(result.result, 'high');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'fetch', 'gate', 'high']);

  // A new run uses the new tree: fetch.level is missing, flag is missing, so
  // the any is false even though fetch still returns score 90.
  const fresh = { hold: async () => 'held-2', fetchScore: () => ({ score: 90 }) };
  assert.equal((await executeWorkflowAsync(workflow, { blocked: false }, fresh)).result, 'low');
});

test('changing the input field path of a parked comparison does not reroute it', async () => {
  const { workflow, gateNode } = thresholdWorkflow(
    { field: 'amount', operator: 'gte', value: 80 });

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    gateNode.condition = { field: 'total', operator: 'gte', value: 80 };
    validateWorkflow(workflow);
  });
  assert.equal(result.result, 'approved');

  // The new tree reads "total", which the same input does not carry.
  const immediate = { hold: async () => 'held-2' };
  assert.equal((await executeWorkflowAsync(workflow, { amount: 90 }, immediate)).result, 'rejected');
  assert.equal((await executeWorkflowAsync(workflow, { total: 90 }, immediate)).result, 'approved');
});

test('pinning the expression does not precompute the result: a form default applied this run still feeds the pinned comparison', async () => {
  // start -> wait (hold) -> collect (form defaults missing channel to "web")
  //       -> gate (channel eq "web") -> yes / no
  const gateNode = {
    id: 'gate', type: 'condition',
    condition: { field: 'channel', operator: 'eq', value: 'web' },
    then: 'yes', else: 'no',
  };
  const formNode = {
    id: 'collect', type: 'form', next: 'gate',
    schema: { fields: [{ path: 'channel', type: 'string', default: 'web' }] },
  };
  const workflow = {
    id: 'live-input', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'wait' },
      { id: 'wait', type: 'action', operation: 'hold', next: 'collect' },
      formNode,
      gateNode,
      { id: 'yes', type: 'end', result: 'yes' },
      { id: 'no', type: 'end', result: 'no' },
    ],
  };

  const result = await parkMutateAndResume(workflow, {}, {}, () => {
    gateNode.condition = { field: 'channel', operator: 'eq', value: 'api' };
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // The form default written only after resume is still read live — through
  // the run's own start-time expression ("web"), so the branch is yes.
  assert.equal(result.result, 'yes');
  assert.deepEqual(result.context.input, { channel: 'web' });

  // A new run applies the same default but the current expression wants "api".
  const immediate = { hold: async () => 'held-2' };
  const later = await executeWorkflowAsync(workflow, {}, immediate);
  assert.equal(later.result, 'no');
  assert.deepEqual(later.context.input, { channel: 'web' });
});

test('each run keeps its own child order: short-circuit skipping follows its adopted tree', async () => {
  // Old order: the safe eq child sits first and short-circuits, so the
  // non-numeric gte child (amount is an object in this input) is never read.
  const condition = { any: [
    { field: 'ok', operator: 'eq', value: true },
    { field: 'amount', operator: 'gte', value: 80 },
  ] };
  const { workflow, gateNode } = thresholdWorkflow(condition);

  const result = await parkMutateAndResume(
    workflow, { ok: true, amount: { weird: true } }, {},
    () => {
      // Swap the children and revalidate: under the new order the gte runs
      // first and would be invalid_condition.
      gateNode.condition = { any: [
        { field: 'amount', operator: 'gte', value: 80 },
        { field: 'ok', operator: 'eq', value: true },
      ] };
      validateWorkflow(workflow);
    });

  // The parked run keeps the old order: skips the bad child and passes.
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'approved');

  // A new run adopts the swapped order, evaluates the object first, and fails
  // at the new position $.any[0].
  const immediate = { hold: async () => 'held-2' };
  const later = await executeWorkflowAsync(
    workflow, { ok: true, amount: { weird: true } }, immediate);
  assert.equal(later.status, 'invalid_condition');
  assert.match(later.error, /condition node gate at \$\.any\[0\]/);
});

test('an invalid_condition in the resumed run reports the position of that run original expression and compensates', async () => {
  // Old expression wraps the comparison in a not; the run input makes that
  // old comparison unconvertible.
  const condition = { not: { field: 'amount', operator: 'gte', value: 80 } };
  const { workflow, gateNode } = thresholdWorkflow(condition, { compensable: true });

  const result = await parkMutateAndResume(
    workflow,
    { amount: { weird: true }, total: 90 },
    { undo: () => 'undone' },
    () => {
      // The new tree points at a perfectly numeric different field.
      gateNode.condition = { not: { field: 'total', operator: 'gte', value: 80 } };
      validateWorkflow(workflow);
    });

  // The resumed run evaluates ITS tree: the object reaches $.not and is an
  // invalid numeric comparison, named at the old position — context, trace
  // and earlier business output are preserved and the successful action is
  // compensated.
  assert.equal(result.status, 'invalid_condition');
  assert.match(result.error, /condition node gate at \$\.not/);
  assert.match(result.error, /field/);
  assert.deepEqual(result.context.input, { amount: { weird: true }, total: 90 });
  assert.deepEqual(result.context.output, { wait: 'held' });
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'wait', 'gate']);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['wait', 'undo', 1, true, 'undone']],
  );

  // A new run under the current tree evaluates total: 90 >= 80 is true, the
  // not flips it to false, so it takes else.
  const immediate = { hold: async () => 'held-2', undo: () => 'undone' };
  assert.equal(
    (await executeWorkflowAsync(workflow, { amount: { weird: true }, total: 90 }, immediate)).result,
    'rejected');
});

test('a new execution always checks the current definition: an illegal edited condition fails before any node runs', async () => {
  const { workflow, gateNode } = thresholdWorkflow(
    { field: 'amount', operator: 'gte', value: 80 });

  // The earlier run starts under the legal condition and parks.
  const hold = gatedHold();
  const runA = executeWorkflowAsync(workflow, { amount: 90 }, hold.operations);
  await hold.started;
  await sleep(5);

  // The definition is made invalid but never re-validated; the parked run
  // already holds its own legal tree.
  gateNode.condition = { field: 'amount', operator: 'bogus', value: 1 };

  // A new run reports the definition error before a single node executes —
  // its "hold" is never invoked — through the async entry, the synchronous
  // entry (its own fresh compile), and standalone validation alike.
  let spyInvocations = 0;
  const spying = { hold: async () => { spyInvocations += 1; return 'never'; } };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { amount: 90 }, spying),
    /condition node gate at \$: unknown condition operator: bogus/,
  );
  assert.equal(spyInvocations, 0);
  assert.throws(
    () => executeWorkflow(workflow, { amount: 90 }),
    /condition node gate at \$: unknown condition operator: bogus/,
  );
  assert.throws(() => validateWorkflow(workflow), /unknown condition operator: bogus/);

  // The parked run is untouched by the illegal edit and finishes normally.
  hold.release();
  const a = await runA;
  assert.equal(a.status, 'completed');
  assert.equal(a.result, 'approved');
});
