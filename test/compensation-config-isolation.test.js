import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A business operation that stays pending until the test releases it, plus a
// promise that fires once the engine has actually invoked it (and is therefore
// parked on its await). The eventual success value is chosen by the caller.
function gatedOperation(operationName, resultValue) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let invocations = 0;
  return {
    release,
    started,
    invocations: () => invocations,
    operations: {
      [operationName]: () => {
        invocations += 1;
        markStarted();
        return gate.then(() => resultValue);
      },
    },
  };
}

const FAST_RETRY = { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };

// start -> a (business "opA", compensable) -> b (business "opB", fails) -> done
function workflowWithCompensation(compensation) {
  return {
    id: 'comp-config-isolation',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        ...(compensation === undefined ? {} : { compensation }),
        next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', retry: FAST_RETRY, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

const ORIGINAL_COMP = {
  operation: 'undoA',
  retry: { attempts: 3, initialDelayMs: 10, backoffFactor: 1, maxDelayMs: 10 },
};
const RENAMED_COMP = {
  operation: 'undoA2',
  retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
};

// Compensation that fails its first attempt and succeeds on the second; it
// records every invocation so a test can inspect what actually ran.
function failOnceCompensation(name, successValue) {
  const calls = [];
  return {
    calls,
    implementation: (input, output, result, nodeId, attempt) => {
      calls.push({ nodeId, attempt, result: structuredClone(result) });
      if (attempt < 2) throw new Error(`${name} fail ${attempt}`);
      return successValue;
    },
  };
}

test('a run parked on the action keeps the compensation name and retries validated at its own start', async () => {
  const workflow = workflowWithCompensation(ORIGINAL_COMP);
  const gated = gatedOperation('opA', { charged: 42 });
  const oldComp = failOnceCompensation('undoA', { refunded: 42 });
  let renamedCalls = 0;

  const runPromise = executeWorkflowAsync(workflow, { amount: 5 }, {
    ...gated.operations,
    opB: () => { throw new Error('b-boom'); },
    undoA: oldComp.implementation,
    undoA2: () => { renamedCalls += 1; return 'new'; },
  });
  await gated.started;
  await sleep(5);

  // The action has not succeeded yet (it is still in flight). Rename the
  // compensation and shrink its retries on the very same definition, then
  // independently validate the edited definition.
  workflow.nodes[1].compensation = structuredClone(RENAMED_COMP);
  validateWorkflow(workflow);

  gated.release();
  const result = await runPromise;

  // The run still ends with the original business failure; editing the
  // definition is not a new business failure and adds no attempt record.
  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'b');
  assert.equal(result.error, 'b-boom');
  assert.deepEqual(result.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, true],
    ['b', 1, false],
  ]);
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'a', 'b']);

  // The start-time compensation name ran under the start-time retry budget:
  // fail then success, continuous attempt numbers, original node id.
  assert.equal(renamedCalls, 0);
  assert.deepEqual(oldComp.calls.map(c => [c.nodeId, c.attempt]), [['a', 1], ['a', 2]]);
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.error, r.nextDelayMs, r.result]),
    [
      ['a', 'undoA', 1, false, 'undoA fail 1', 10, null],
      ['a', 'undoA', 2, true, null, 0, { refunded: 42 }],
    ],
  );
  assert.equal(result.compensationStatus, 'completed');

  // The renamed operation never enters this run's records, and the saved
  // business output is not overwritten by the compensation return value.
  assert.ok(result.compensationAttempts.every(r => r.operation === 'undoA'));
  assert.deepEqual(result.context.output.a, { charged: 42 });
  assert.deepEqual(result.context.input, { amount: 5 });
});

test('editing the compensation retry numbers while the action is in flight cannot change its attempts or waits', async () => {
  const workflow = workflowWithCompensation({
    operation: 'undoA',
    retry: { attempts: 3, initialDelayMs: 20, backoffFactor: 2, maxDelayMs: 30 },
  });
  const gated = gatedOperation('opA', 'A');
  const gaps = [];
  let last = Date.now();
  let renamedCalls = 0;

  const runPromise = executeWorkflowAsync(workflow, {}, {
    ...gated.operations,
    opB: () => { throw new Error('b-boom'); },
    undoA: () => {
      gaps.push(Date.now() - last);
      last = Date.now();
      throw new Error('always fails');
    },
    undoA2: () => { renamedCalls += 1; },
  });
  await gated.started;
  await sleep(5);

  // Replace the retry block with a single zero-delay attempt and revalidate.
  workflow.nodes[1].compensation = {
    operation: 'undoA2',
    retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  };
  validateWorkflow(workflow);

  gated.release();
  const result = await runPromise;

  // Three attempts with the original 20 / capped-30 delays, not one.
  assert.equal(renamedCalls, 0);
  assert.deepEqual(result.compensationAttempts.map(r => [r.operation, r.attempt, r.ok, r.nextDelayMs]), [
    ['undoA', 1, false, 20],
    ['undoA', 2, false, 30],
    ['undoA', 3, false, 0],
  ]);
  assert.ok(gaps[1] >= 18, `expected the original 20ms wait, got ${gaps[1]}`);
  assert.ok(gaps[2] >= 28, `expected the original 30ms cap, got ${gaps[2]}`);
  assert.equal(result.compensationStatus, 'failed');
  assert.equal(result.status, 'action_failed');
});

test('in-place edits to the compensation objects without revalidation never reach a parked run', async () => {
  const workflow = workflowWithCompensation(structuredClone(ORIGINAL_COMP));
  const gated = gatedOperation('opA', 'A');
  let renamedCalls = 0;
  const seenAttempts = [];

  const runPromise = executeWorkflowAsync(workflow, {}, {
    ...gated.operations,
    opB: () => { throw new Error('b-boom'); },
    undoA: (input, output, result, nodeId, attempt) => {
      seenAttempts.push(attempt);
      if (attempt < 2) throw new Error('undo fail');
      return 'ok';
    },
    undoA2: () => { renamedCalls += 1; },
  });
  await gated.started;
  await sleep(5);

  // Mutate the very objects the run started from, with no validateWorkflow
  // call at all: the compiled binding copied the name and retry block.
  workflow.nodes[1].compensation.operation = 'undoA2';
  workflow.nodes[1].compensation.retry.attempts = 1;
  workflow.nodes[1].compensation.retry.initialDelayMs = 0;

  gated.release();
  const result = await runPromise;

  assert.equal(renamedCalls, 0);
  assert.deepEqual(seenAttempts, [1, 2]);
  assert.deepEqual(result.compensationAttempts.map(r => [r.operation, r.attempt]), [
    ['undoA', 1],
    ['undoA', 2],
  ]);
  assert.equal(result.compensationStatus, 'completed');
});

test('editing a not-yet-executed action compensation while an earlier operation waits cannot reach the run', async () => {
  const workflow = {
    id: 'future-action-comp',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      { id: 'hold', type: 'action', operation: 'hold', next: 'b' },
      {
        id: 'b', type: 'action', operation: 'opB',
        compensation: {
          operation: 'undoB',
          retry: { attempts: 3, initialDelayMs: 10, backoffFactor: 1, maxDelayMs: 10 },
        },
        next: 'c',
      },
      { id: 'c', type: 'action', operation: 'opC', retry: FAST_RETRY, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const gated = gatedOperation('hold', 'held');
  const oldComp = failOnceCompensation('undoB', 'undone-b');
  let renamedCalls = 0;

  const runPromise = executeWorkflowAsync(workflow, {}, {
    ...gated.operations,
    opB: () => 'B',
    opC: () => { throw new Error('c-boom'); },
    undoB: oldComp.implementation,
    undoB2: () => { renamedCalls += 1; },
  });
  await gated.started;
  await sleep(5);

  // b has not run yet. Rename its compensation and rewrite the retry object
  // in place while the earlier "hold" operation is still pending.
  workflow.nodes[2].compensation.operation = 'undoB2';
  workflow.nodes[2].compensation.retry.attempts = 1;
  workflow.nodes[2].compensation.retry.initialDelayMs = 0;
  validateWorkflow(workflow);

  gated.release();
  const result = await runPromise;

  assert.equal(result.status, 'action_failed');
  assert.equal(renamedCalls, 0);
  assert.deepEqual(oldComp.calls.map(c => [c.nodeId, c.attempt]), [['b', 1], ['b', 2]]);
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.nextDelayMs]), [
    ['b', 'undoB', 1, false, 10],
    ['b', 'undoB', 2, true, 0],
  ]);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.context.output.b, 'B');

  // A new run against the same (edited, revalidated) definition uses the new
  // legal configuration: one undoB2 call, no undoB, its own records.
  const fresh = await executeWorkflowAsync(workflow, {}, {
    hold: async () => 'held-2',
    opB: () => 'B-2',
    opC: () => { throw new Error('c-boom'); },
    undoB2: () => 'renamed-undone',
    undoB: () => { throw new Error('undoB must not run for the new definition'); },
  });
  assert.equal(fresh.status, 'action_failed');
  assert.equal(oldComp.calls.length, 2, 'the earlier run\'s compensation is not invoked again');
  assert.deepEqual(fresh.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['b', 'undoB2', 1, true, 'renamed-undone'],
  ]);
  assert.equal(fresh.compensationStatus, 'completed');
});

test('two runs sharing one edited action each keep their start-time compensation, whichever finishes first', async () => {
  async function scenario(releaseOrder) {
    const workflow = workflowWithCompensation({
      operation: 'undoA',
      retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    });

    const gateA = gatedOperation('opA', 'A');
    const oldA = failOnceCompensation('undoA', 'undone-a');
    let renamedSeenByA = 0;
    const runA = executeWorkflowAsync(workflow, { tag: 'A' }, {
      ...gateA.operations,
      opB: () => { throw new Error('b-boom'); },
      undoA: oldA.implementation,
      undoA2: () => { renamedSeenByA += 1; return 'new'; },
    });
    await gateA.started;
    await sleep(5);

    // The shared definition changes and is independently re-validated while
    // run A is parked.
    workflow.nodes[1].compensation = structuredClone(RENAMED_COMP);
    validateWorkflow(workflow);

    // Run B starts under the edited definition and parks too.
    const gateB = gatedOperation('opA', 'B');
    let oldSeenByB = 0;
    const renamedB = [];
    const runB = executeWorkflowAsync(workflow, { tag: 'B' }, {
      ...gateB.operations,
      opB: () => { throw new Error('b-boom'); },
      undoA2: (input, output, result, nodeId, attempt) => {
        renamedB.push({ nodeId, attempt, result: structuredClone(result) });
        return 'undone-a2';
      },
      undoA: () => { oldSeenByB += 1; throw new Error('undoA must not run for run B'); },
    });
    await gateB.started;
    await sleep(5);

    if (releaseOrder === 'B-first') {
      gateB.release();
      gateA.release();
    } else {
      gateA.release();
      gateB.release();
    }

    const [a, b] = await Promise.all([runA, runB]);
    return { a, b, oldA, renamedSeenByA, oldSeenByB, renamedB };
  }

  for (const order of ['A-first', 'B-first']) {
    const { a, b, oldA, renamedSeenByA, oldSeenByB, renamedB } = await scenario(order);

    assert.equal(a.status, 'action_failed', `A keeps its terminal status (${order})`);
    assert.equal(a.compensationStatus, 'completed', `A completes its old compensation (${order})`);
    assert.deepEqual(
      a.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]),
      [['a', 'undoA', 1, false], ['a', 'undoA', 2, true]],
      `A uses its start-time name and retries (${order})`,
    );
    assert.equal(renamedSeenByA, 0, `the renamed op never runs for A (${order})`);
    assert.deepEqual(a.context.output.a, 'A');

    assert.equal(b.status, 'action_failed', `B keeps its terminal status (${order})`);
    assert.equal(b.compensationStatus, 'completed', `B completes the new compensation (${order})`);
    assert.deepEqual(
      b.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
      [['a', 'undoA2', 1, true, 'undone-a2']],
      `B uses the new name and a single attempt (${order})`,
    );
    assert.equal(oldSeenByB, 0, `the old op never runs for B (${order})`);
    assert.deepEqual(renamedB.map(c => [c.nodeId, c.attempt, c.result]), [['a', 1, 'B']]);
    assert.deepEqual(b.context.output.a, 'B');
    assert.equal(oldA.calls.length, 2);
  }
});

test('a compensation added after the run started never causes a compensation call in that run', async () => {
  const workflow = workflowWithCompensation(undefined);
  const gated = gatedOperation('opA', 'A');
  let undoCalls = 0;

  const runPromise = executeWorkflowAsync(workflow, {}, {
    ...gated.operations,
    opB: () => { throw new Error('b-boom'); },
    undoA: () => { undoCalls += 1; return 'too late'; },
  });
  await gated.started;
  await sleep(5);

  // Add a compensation while the action itself is still in flight (it only
  // succeeds after this edit) and revalidate the edited definition.
  workflow.nodes[1].compensation = { operation: 'undoA' };
  validateWorkflow(workflow);

  gated.release();
  const result = await runPromise;

  assert.equal(result.status, 'action_failed');
  assert.equal(undoCalls, 0);
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
  // The successful output still stands; only compensation was absent.
  assert.equal(result.context.output.a, 'A');

  // A later run of the edited definition does compensate.
  const fresh = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A-2',
    opB: () => { throw new Error('b-boom'); },
    undoA: () => 'fresh-undone',
  });
  assert.equal(fresh.compensationStatus, 'completed');
  assert.deepEqual(fresh.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]), [
    ['a', 'undoA', 1, true],
  ]);
});

test('deleting a compensation after the run started never cancels a compensation that run owes', async () => {
  const workflow = workflowWithCompensation({ operation: 'undoA' });
  const gated = gatedOperation('opA', 'A');
  let undoCalls = 0;

  const runPromise = executeWorkflowAsync(workflow, {}, {
    ...gated.operations,
    opB: () => { throw new Error('b-boom'); },
    undoA: () => { undoCalls += 1; return 'undone'; },
  });
  await gated.started;
  await sleep(5);

  // Remove the compensation while the action is in flight and revalidate.
  delete workflow.nodes[1].compensation;
  validateWorkflow(workflow);

  gated.release();
  const result = await runPromise;

  assert.equal(result.status, 'action_failed');
  assert.equal(undoCalls, 1);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['a', 'undoA', 1, true, 'undone'],
  ]);
});

test('an invalid edited compensation still reports node and reason; the parked run ends under the old config; a new run is rejected before any call', async () => {
  const invalidEdits = [
    [
      { operation: '   ' },
      /action node a: compensation\.operation must be a non-empty string name/,
    ],
    [
      { operation: 'undoA', retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
      /action node a compensation: retry\.attempts must be an integer between 1 and 10/,
    ],
  ];

  for (const [invalidConfig, matcher] of invalidEdits) {
    const workflow = workflowWithCompensation({ operation: 'undoA' });
    const gated = gatedOperation('opA', 'A');
    let undoCalls = 0;

    const runPromise = executeWorkflowAsync(workflow, {}, {
      ...gated.operations,
      opB: () => { throw new Error('b-boom'); },
      undoA: () => { undoCalls += 1; return 'undone'; },
    });
    await gated.started;
    await sleep(5);

    // Make the edited definition invalid; standalone validation keeps naming
    // the node and reason.
    workflow.nodes[1].compensation = invalidConfig;
    assert.throws(() => validateWorkflow(workflow), matcher);

    // A new run from the illegal definition is rejected before any business
    // operation or compensation can run.
    let spyCalls = 0;
    await assert.rejects(
      () => executeWorkflowAsync(workflow, {}, {
        opA: () => { spyCalls += 1; return 'never'; },
        opB: () => { spyCalls += 1; throw new Error('never'); },
        undoA: () => { spyCalls += 1; return 'never'; },
      }),
      matcher,
    );
    assert.equal(spyCalls, 0);
    assert.equal(gated.invocations(), 1, 'the parked run is the only business invocation');

    // The already-started legal run still finishes under its start config.
    gated.release();
    const result = await runPromise;
    assert.equal(result.status, 'action_failed');
    assert.equal(undoCalls, 1);
    assert.equal(result.compensationStatus, 'completed');
    assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]), [
      ['a', 'undoA', 1, true],
    ]);
  }
});

test('pinning the compensation config does not pin its inputs: snapshots still come from the action success moment', async () => {
  // start -> prep (message action) -> a (gated business op, compensable)
  //       -> b (fails) -> done
  const workflow = {
    id: 'comp-snapshot-timing',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA' },
        next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', retry: FAST_RETRY, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const gated = gatedOperation('opA', { charged: 42 });
  const seen = [];
  let renamedCalls = 0;

  const runPromise = executeWorkflowAsync(workflow, { amount: 5 }, {
    ...gated.operations,
    opB: () => { throw new Error('b-boom'); },
    undoA: (input, output, result, nodeId, attempt) => {
      seen.push({
        input: structuredClone(input),
        output: structuredClone(output),
        result: structuredClone(result),
        nodeId, attempt,
      });
      // Mutating the copies must not reach the saved records.
      input.amount = 0;
      output.tampered = true;
      result.charged = -1;
      return { refunded: 42 };
    },
    undoA2: () => { renamedCalls += 1; },
  });
  await gated.started;
  await sleep(5);

  // Config fixed at start; rename it before the action succeeds.
  workflow.nodes[2].compensation = { operation: 'undoA2' };
  validateWorkflow(workflow);

  gated.release();
  const result = await runPromise;

  assert.equal(renamedCalls, 0);
  assert.equal(seen.length, 1);
  // The compensation arguments are the independent snapshots saved when a
  // succeeded — after the edit — not anything fixed at (or missing at) start.
  assert.deepEqual(seen[0].input, { amount: 5 });
  assert.deepEqual(seen[0].output, { prep: 'prepared' });
  assert.deepEqual(seen[0].result, { charged: 42 });
  assert.equal(seen[0].nodeId, 'a');
  assert.equal(seen[0].attempt, 1);
  // The saved success output survives the compensation's own mutations and
  // return value.
  assert.deepEqual(result.context.output.a, { charged: 42 });
  assert.deepEqual(result.context.output.prep, 'prepared');
  assert.deepEqual(result.context.input, { amount: 5 });
  assert.equal(result.compensationStatus, 'completed');
});
