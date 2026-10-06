import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A business operation that stays pending until the test releases it, plus a
// signal that fires once the engine has actually invoked it (and is therefore
// parked on its await).
function gatedHold(result = 'held') {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const operations = {
    hold: () => {
      markStarted();
      return gate.then(() => result);
    },
  };
  return { release, started, operations };
}

// start -> wait (business operation "hold") -> collect (form) -> after (end)
//
// The start-time form rules require amount to be a number >= 10 and default a
// missing channel to "web".
function workflowWith(extraNodes = [], { compensable = false } = {}) {
  const formNode = {
    id: 'collect', type: 'form', next: 'after',
    schema: { fields: [
      { path: 'amount', type: 'number', min: 10 },
      { path: 'channel', type: 'string', default: 'web' },
    ] },
  };
  const waitNode = {
    id: 'wait', type: 'action', operation: 'hold', next: 'collect',
  };
  if (compensable) waitNode.compensation = { operation: 'undo' };
  return {
    workflow: {
      id: 'form-rule-isolation', entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'wait' },
        waitNode,
        formNode,
        { id: 'after', type: 'end', result: 'done' },
        ...extraNodes,
      ],
    },
    formNode,
  };
}

// Park the run inside "hold", run `mutate` while it is waiting, then resume.
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

test('a run parked on a business action keeps using the form rules accepted at its own start', async () => {
  const { workflow, formNode } = workflowWith();

  const result = await parkMutateAndResume(workflow, { amount: 15 }, {}, () => {
    // While the earlier run waits: tighten the bound and change the default,
    // then independently re-validate the very same definition.
    formNode.schema.fields[0].min = 20;
    formNode.schema.fields[1].default = 'api';
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'done');
  // amount 15 passes the start-time minimum of 10, and the missing channel is
  // still defaulted to the start-time "web".
  assert.deepEqual(result.context.input, { amount: 15, channel: 'web' });
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'collect', 'after']);

  // A new run against the re-validated definition is held to the new rules.
  const immediate = { hold: async () => 'held-2' };

  const rejected = await executeWorkflowAsync(workflow, { amount: 15 }, immediate);
  assert.equal(rejected.status, 'invalid_input');
  assert.deepEqual(rejected.errors, [
    { nodeId: 'collect', path: 'amount', code: 'range' },
  ]);
  // The default the failed form wrote ("api") is rolled back again.
  assert.equal(Object.hasOwn(rejected.context.input, 'channel'), false);
  assert.deepEqual(rejected.context.input, { amount: 15 });
  // Records produced before the failing form are preserved.
  assert.deepEqual(rejected.context.output, { wait: 'held-2' });
  assert.deepEqual(rejected.trace.map(node => node.nodeId),
    ['start', 'wait', 'collect']);
  assert.equal(rejected.trace.some(node => node.nodeId === 'after'), false);

  const accepted = await executeWorkflowAsync(workflow, { amount: 25 }, immediate);
  assert.equal(accepted.status, 'completed');
  assert.deepEqual(accepted.context.input, { amount: 25, channel: 'api' });
});

test('a later validation that fails on a node checked after the form does not change the parked run rules', async () => {
  // "ghost" is a legal but entry-unreachable node at start. While the earlier
  // run waits, the form rules change and ghost is broken; re-validation then
  // compiles the form first (declaration order puts the form before ghost) and
  // only afterwards fails on ghost's unknown successor. Even that partial
  // recompile must not reach the parked run. ghost stays unreachable, so the
  // run never executes it.
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'after' };
  const { workflow, formNode } = workflowWith([ghostNode]);

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, { amount: 15 }, hold.operations);
  await hold.started;
  await sleep(5);

  formNode.schema.fields[0].min = 20;
  formNode.schema.fields[1].default = 'api';
  ghostNode.next = 'nowhere';
  assert.throws(
    () => validateWorkflow(workflow),
    /node ghost points to an unknown destination/,
  );

  hold.release();
  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.context.input, { amount: 15, channel: 'web' });
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'collect', 'after']);
});

test('mutating the parked form node directly — constraints, defaults or the field list — never reaches the run', async () => {
  const { workflow, formNode } = workflowWith();

  const result = await parkMutateAndResume(workflow, { amount: 15 }, {}, () => {
    // No validateWorkflow call at all: the run must not read the live node
    // either. A newly added required field would fail validation had the run
    // picked it up; the changed bound and default would change the outcome.
    formNode.schema.fields[0].min = 20;
    formNode.schema.fields[1].default = 'api';
    formNode.schema.fields.push({ path: 'extra', type: 'string', required: true });
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.context.input, { amount: 15, channel: 'web' });
  assert.equal(Object.hasOwn(result.context.input, 'extra'), false);
});

test('field error order, run stop and compensation follow the start-time declaration', async () => {
  const formNode = {
    id: 'collect', type: 'form', next: 'after',
    schema: { fields: [
      { path: 'a', type: 'string', required: true },
      { path: 'b', type: 'string', required: true },
    ] },
  };
  const workflow = {
    id: 'form-rule-order', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'wait' },
      {
        id: 'wait', type: 'action', operation: 'hold',
        compensation: { operation: 'undo' }, next: 'collect',
      },
      formNode,
      { id: 'after', type: 'end', result: 'done' },
    ],
  };

  const result = await parkMutateAndResume(
    workflow, {}, { undo: () => 'undone' },
    () => {
      // Reverse the declaration order and re-validate while the run is parked.
      formNode.schema.fields.reverse();
      validateWorkflow(workflow);
    },
  );

  assert.equal(result.status, 'invalid_input');
  // Errors keep the field order this run started with.
  assert.deepEqual(result.errors, [
    { nodeId: 'collect', path: 'a', code: 'required' },
    { nodeId: 'collect', path: 'b', code: 'required' },
  ]);
  // Execution stops at the form; the earlier business record is preserved and
  // compensated exactly as before.
  assert.deepEqual(result.context.output, { wait: 'held' });
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'collect']);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['wait', 'undo', 1, true, 'undone']],
  );
});

test('two runs sharing the same node objects but started around a revalidation stay mutually isolated', async () => {
  const { workflow, formNode } = workflowWith();

  // Each invocation of "hold" gets its own independent gate, in start order.
  const gates = [];
  let nextGate = 0;
  const operations = {
    hold: () => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      gates.push({ release, gate });
      const index = nextGate;
      nextGate += 1;
      return gate.then(() => `held-${index}`);
    },
  };

  // Run A starts under the original rules (min 10, default "web") and parks.
  const runA = executeWorkflowAsync(workflow, { amount: 15 }, operations);
  while (gates.length < 1) await sleep(1);
  await sleep(5);

  // The shared definition changes and is independently re-validated.
  formNode.schema.fields[0].min = 20;
  formNode.schema.fields[1].default = 'api';
  validateWorkflow(workflow);

  // Run B starts under the new rules (min 20, default "api") and parks too.
  const runB = executeWorkflowAsync(workflow, { amount: 25 }, operations);
  while (gates.length < 2) await sleep(1);
  await sleep(5);

  gates[1].release();
  gates[0].release();

  const [a, b] = await Promise.all([runA, runB]);

  assert.equal(a.status, 'completed');
  assert.deepEqual(a.context.input, { amount: 15, channel: 'web' });
  assert.equal(b.status, 'completed');
  assert.deepEqual(b.context.input, { amount: 25, channel: 'api' });
});
