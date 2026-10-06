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

// start -> wait (business operation "hold") -> check (condition) -> ends.
// The condition node and its expression object are returned so tests can mutate
// the very definition the parked run started from.
function approvalWorkflow(condition, { compensable = false, extraNodes = [] } = {}) {
  const waitNode = { id: 'wait', type: 'action', operation: 'hold', next: 'check' };
  if (compensable) waitNode.compensation = { operation: 'undo' };
  const conditionNode = {
    id: 'check', type: 'condition',
    condition, then: 'approved', else: 'rejected',
  };
  return {
    workflow: {
      id: 'condition-rule-isolation', entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'wait' },
        waitNode,
        conditionNode,
        { id: 'approved', type: 'end', result: 'approved' },
        { id: 'rejected', type: 'end', result: 'rejected' },
        ...extraNodes,
      ],
    },
    waitNode,
    conditionNode,
  };
}

// Park the run inside "hold", run `mutate` while it is waiting, then resume.
async function parkMutateAndResume(workflow, input, operations, mutate, result = 'held') {
  const hold = gatedHold(result);
  const merged = { ...hold.operations, ...operations };
  const runPromise = executeWorkflowAsync(workflow, input, merged);
  await hold.started;
  // Let the engine settle onto its await of the pending operation.
  await sleep(5);
  mutate();
  hold.release();
  return runPromise;
}

test('a run parked on a business action keeps the threshold accepted at its own start', async () => {
  const { workflow, conditionNode } = approvalWorkflow(
    { field: 'amount', operator: 'gte', value: 80 });

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    // While the earlier run waits: move the threshold past its amount and
    // independently re-validate the very same definition.
    conditionNode.condition.value = 100;
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // 90 passed the start-time threshold of 80 even though 90 < 100 now.
  assert.equal(result.result, 'approved');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'check', 'approved']);

  // A new run against the re-validated definition is held to the new rule.
  const immediate = { hold: async () => 'held-2' };

  const rejected = await executeWorkflowAsync(workflow, { amount: 90 }, immediate);
  assert.equal(rejected.status, 'completed');
  assert.equal(rejected.result, 'rejected');
  assert.deepEqual(rejected.context.output, { wait: 'held-2' });
  assert.deepEqual(rejected.trace.map(node => node.nodeId),
    ['start', 'wait', 'check', 'rejected']);

  const approved = await executeWorkflowAsync(workflow, { amount: 105 }, immediate);
  assert.equal(approved.result, 'approved');
});

test('two runs sharing the same condition stay isolated regardless of which finishes first', async () => {
  const { workflow, conditionNode } = approvalWorkflow(
    { field: 'amount', operator: 'gte', value: 80 });

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

  // Run A starts under the original threshold (80) and parks.
  const runA = executeWorkflowAsync(workflow, { amount: 90 }, operations);
  while (gates.length < 1) await sleep(1);
  await sleep(5);

  // The shared definition changes and is independently re-validated.
  conditionNode.condition.value = 100;
  validateWorkflow(workflow);

  // Run B starts under the new threshold (100) and parks too.
  const runB = executeWorkflowAsync(workflow, { amount: 90 }, operations);
  while (gates.length < 2) await sleep(1);
  await sleep(5);

  // The newer run finishes first; ordering must not swap either run's rules.
  gates[1].release();
  gates[0].release();

  const [a, b] = await Promise.all([runA, runB]);

  assert.equal(a.result, 'approved');
  assert.equal(b.result, 'rejected');
});

test('changing the expression without re-validating never reaches the parked run', async () => {
  const { workflow, conditionNode } = approvalWorkflow(
    { field: 'amount', operator: 'gte', value: 80 });

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    // No validateWorkflow call: the live node must not be re-read either.
    conditionNode.condition.value = 100;
  });

  assert.equal(result.result, 'approved');
});

test('a later validation that fails on a node compiled after the condition keeps the parked rules', async () => {
  // "ghost" is a legal but entry-unreachable node at start, declared after the
  // condition. While the earlier run waits, the threshold changes and ghost is
  // broken; re-validation then compiles the condition first and only afterwards
  // fails on ghost's unknown successor. Even that partial recompile must not
  // reach the parked run, and the failure is reported normally.
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'approved' };
  const { workflow, conditionNode } = approvalWorkflow(
    { field: 'amount', operator: 'gte', value: 80 }, { extraNodes: [ghostNode] });

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, { amount: 90 }, hold.operations);
  await hold.started;
  await sleep(5);

  conditionNode.condition.value = 100;
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
    ['start', 'wait', 'check', 'approved']);
});

test('compound short-circuit order and nested not/any positions stay frozen for the parked run', async () => {
  // Old expression:
  //   all[0]: flag === true
  //   all[1].not.any[0]: amount >= cap        (cap is unconvertible)
  //   all[1].not.any[1]: flag === false
  // The run evaluates in that order and reaches the bad numeric comparison at
  // the deep old position $.all[1].not.any[0].
  const { workflow, conditionNode } = approvalWorkflow({
    all: [
      { field: 'flag', operator: 'eq', value: true },
      { not: { any: [
        { field: 'amount', operator: 'gte', valueField: 'cap' },
        { field: 'flag', operator: 'eq', value: false },
      ] } },
    ],
  }, { compensable: true });

  const result = await parkMutateAndResume(
    workflow, { amount: 90, cap: 'not-a-number', flag: true },
    { undo: () => 'undone' },
    () => {
      // Replace the whole frozen subtree: the new expression has no bad
      // comparison anywhere and evaluates to true for the same input.
      conditionNode.condition = {
        all: [
          { field: 'flag', operator: 'eq', value: true },
          { not: { field: 'other', operator: 'exists' } },
        ],
      };
      validateWorkflow(workflow);
    },
  );

  assert.equal(result.status, 'invalid_condition');
  // The node and sub-condition position name the run's ORIGINAL expression.
  assert.match(result.error, /condition node check at \$\.all\[1\]\.not\.any\[0\]/);
  assert.match(result.error, /value at valueField cannot convert to a finite number/);
  // Context and trace up to the failed condition are preserved.
  assert.deepEqual(result.context.input, { amount: 90, cap: 'not-a-number', flag: true });
  assert.deepEqual(result.context.output, { wait: 'held' });
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'check']);
  // Earlier successful business actions are compensated under the usual rules.
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['wait', 'undo', 1, true, 'undone']],
  );

  // A new run uses the new tree: "other" is missing, not(exists) is true.
  const immediate = { hold: async () => 'held-2', undo: () => 'undone-2' };
  const rerun = await executeWorkflowAsync(
    workflow, { amount: 90, cap: 'not-a-number', flag: true }, immediate);
  assert.equal(rerun.result, 'approved');
});

test('the frozen tree still reads this run’s current form defaults and the output just returned', async () => {
  // start -> wait (hold returns { score }) -> collect (form defaulting cap) ->
  // check (wait.score >= cap) -> ends.
  const formNode = {
    id: 'collect', type: 'form', next: 'check',
    schema: { fields: [
      { path: 'cap', type: 'number', default: 80 },
    ] },
  };
  const condition = {
    outputField: { nodeId: 'wait', path: 'score' },
    operator: 'gte', valueField: 'cap',
  };
  const { workflow: base, conditionNode } = approvalWorkflow(condition);
  const workflow = base;
  // Insert the form between wait and the condition.
  workflow.nodes[1].next = 'collect';
  workflow.nodes.splice(2, 0, formNode);

  const result = await parkMutateAndResume(
    workflow, {}, {},
    () => {
      // While hold is in flight: tighten the form default and repoint the
      // condition's left side at an output path the action does not return.
      formNode.schema.fields[0].default = 1000;
      conditionNode.condition.outputField.path = 'moved';
      validateWorkflow(workflow);
    },
    { score: 90 },
  );

  assert.equal(result.status, 'completed');
  // The form that runs after resume still writes the start-time default 80,
  // and the condition's frozen reference reads the output hold only produced
  // on resume: 90 >= 80.
  assert.equal(result.result, 'approved');
  assert.deepEqual(result.context.input, { cap: 80 });
  assert.deepEqual(result.context.output, { wait: { score: 90 } });
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'wait', 'collect', 'check', 'approved']);

  // The new run uses both new rules: cap defaults to 1000 and wait.moved is
  // absent, so the comparison is false.
  const immediate = { hold: async () => ({ score: 90 }) };
  const rerun = await executeWorkflowAsync(workflow, {}, immediate);
  assert.equal(rerun.result, 'rejected');
  assert.deepEqual(rerun.context.input, { cap: 1000 });
});

test('a new run against an illegally changed condition fails before any node executes', async () => {
  const { workflow, conditionNode } = approvalWorkflow(
    { field: 'amount', operator: 'gte', value: 80 });

  // The old run parks under the legal start-time expression.
  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, { amount: 90 }, hold.operations);
  await hold.started;
  await sleep(5);

  // The shared definition becomes malformed; no validateWorkflow is needed —
  // the execution entry validates the current definition itself.
  conditionNode.condition = { field: 'amount', operator: 'gte' };

  let operationInvoked = false;
  const spyOperations = {
    hold: () => {
      operationInvoked = true;
      return Promise.resolve('must-not-run');
    },
  };
  await assert.rejects(
    executeWorkflowAsync(workflow, { amount: 90 }, spyOperations),
    /condition node check at \$: condition must specify exactly one of value or valueField \(or valueOutputField\)/,
  );
  assert.equal(operationInvoked, false);

  // The rejected compile did not touch the parked run's frozen tree.
  hold.release();
  const result = await runPromise;
  assert.equal(result.result, 'approved');
});
