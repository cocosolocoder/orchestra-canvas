import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A business operation that stays pending until the test releases it, plus a
// promise that fires once the engine has actually invoked it (and is therefore
// parked on its await) — the same pattern condition-rule-isolation uses.
function gatedHold(name = 'hold', result = 'held') {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const operations = {
    [name]: () => {
      markStarted();
      return gate.then(() => result);
    },
  };
  return { release, started, operations };
}

// start -> wait (business operation "hold", parks the run) -> a (business,
// compensable) -> b (business, fails) -> done
//
// The run is parked inside "hold" — before `a` has executed — while the test
// edits `a`'s compensation config. Whatever the run then does about
// compensation must come from the configuration its own start-time validation
// accepted, never from the edited definition.
function compensationWorkflow({ compOnA = true, compRetry = undefined } = {}) {
  const aNode = { id: 'a', type: 'action', operation: 'opA', next: 'b' };
  if (compOnA) {
    aNode.compensation = { operation: 'undoA', ...(compRetry ? { retry: compRetry } : {}) };
  }
  const workflow = {
    id: 'comp-config-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'wait' },
      { id: 'wait', type: 'action', operation: 'hold', next: 'a' },
      aNode,
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  return { workflow, aNode };
}

const failingOpB = () => { throw new Error('b-boom'); };

// Park the run inside "hold", run `mutate` while it waits, then resume and
// return the run's promise.
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

test('a compensation renamed and re-validated mid-run still runs under the start-time name and retry', async () => {
  const { workflow, aNode } = compensationWorkflow({
    compRetry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });

  const calls = [];
  const compArgs = [];
  const undoA = (input, output, result, nodeId, attempt) => {
    calls.push('undoA');
    compArgs.push({
      input: structuredClone(input),
      output: structuredClone(output),
      result: structuredClone(result),
      nodeId,
      attempt,
    });
    if (attempt < 3) throw new Error(`undo ${attempt}`);
    return { refunded: true };
  };
  const undoRenamed = () => { calls.push('undoRenamed'); return 'new-undo'; };

  const runPromise = parkMutateAndResume(
    workflow,
    { amount: 5 },
    { opA: () => 'A', opB: failingOpB, undoA, undoRenamed },
    () => {
      // While the run is parked: rename the compensation and replace its
      // retry budget. The edited definition passes standalone validation.
      aNode.compensation = {
        operation: 'undoRenamed',
        retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
      };
      validateWorkflow(workflow);
    },
  );
  const result = await runPromise;

  // The original failure shape is preserved: the config edit is not a new
  // business failure.
  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'b');
  assert.equal(result.attempts, 1);
  assert.equal(result.error, 'b-boom');
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'wait', 'a', 'b']);
  assert.deepEqual(result.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['wait', 1, true], ['a', 1, true], ['b', 1, false],
  ]);

  // The renamed operation never runs for this run; the start-time operation
  // is retried under the start-time budget until it succeeds.
  assert.deepEqual(calls, ['undoA', 'undoA', 'undoA']);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.error, r.nextDelayMs, r.result]),
    [
      ['a', 'undoA', 1, false, 'undo 1', 0, null],
      ['a', 'undoA', 2, false, 'undo 2', 0, null],
      ['a', 'undoA', 3, true, null, 0, { refunded: true }],
    ],
  );

  // Only the compensation *rules* are pinned to the run start: the
  // compensation's input, earlier outputs and the business return value still
  // come from the snapshots saved when `a` succeeded this run.
  assert.equal(compArgs.length, 3);
  for (const args of compArgs) {
    assert.deepEqual(args.input, { amount: 5 });
    assert.deepEqual(args.output, { wait: 'held' });
    assert.deepEqual(args.result, 'A');
    assert.equal(args.nodeId, 'a');
  }
  assert.deepEqual(compArgs.map(args => args.attempt), [1, 2, 3]);

  // The saved success output is never overwritten by the compensation.
  assert.equal(result.context.output.a, 'A');
  assert.equal(result.context.output.wait, 'held');
  assert.equal(result.context.output.b, undefined);

  // A new run started from the modified definition uses the new legal
  // configuration: one attempt of the renamed operation.
  calls.length = 0;
  const second = await executeWorkflowAsync(workflow, { amount: 5 }, {
    hold: async () => 'held-2',
    opA: () => 'A2',
    opB: failingOpB,
    undoA,
    undoRenamed,
  });
  assert.equal(second.status, 'action_failed');
  assert.deepEqual(calls, ['undoRenamed']);
  assert.equal(second.compensationStatus, 'completed');
  assert.deepEqual(
    second.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['a', 'undoRenamed', 1, true, 'new-undo']],
  );
  assert.equal(second.context.output.a, 'A2');
});

test('in-place edits to the original retry object mid-run cannot alias into the run', async () => {
  const { workflow, aNode } = compensationWorkflow({
    compRetry: { attempts: 3, initialDelayMs: 10, backoffFactor: 2, maxDelayMs: 25 },
  });

  const calls = [];
  const result = await parkMutateAndResume(
    workflow,
    {},
    {
      opA: () => 'A',
      opB: failingOpB,
      undoA: (input, output, result2, nodeId, attempt) => {
        calls.push(attempt);
        if (attempt < 3) throw new Error(`undo ${attempt}`);
        return 'refunded';
      },
      undoShrunk: () => { calls.push('shrunk'); },
    },
    () => {
      // Mutate the very retry object the run started from — shrink the budget
      // and zero the waits — then rename the operation, and revalidate.
      aNode.compensation.retry.attempts = 1;
      aNode.compensation.retry.initialDelayMs = 0;
      aNode.compensation.retry.maxDelayMs = 0;
      aNode.compensation.operation = 'undoShrunk';
      validateWorkflow(workflow);
    },
  );

  assert.equal(result.status, 'action_failed');
  // The start-time retry object decides the attempt count and the waits:
  // three attempts with the original 10ms/20ms backoff, not the edited
  // single zero-delay attempt of a different operation.
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.operation, r.attempt, r.ok, r.nextDelayMs]),
    [['undoA', 1, false, 10], ['undoA', 2, false, 20], ['undoA', 3, true, 0]],
  );

  // A new run adopts the shrunk single-attempt budget of the renamed
  // operation, and its record shows the new rule.
  calls.length = 0;
  const second = await executeWorkflowAsync(workflow, {}, {
    hold: async () => 'held-2',
    opA: () => 'A',
    opB: failingOpB,
    undoA: () => { calls.push('old'); },
    undoShrunk: () => { calls.push('shrunk'); throw new Error('stuck'); },
  });
  assert.deepEqual(calls, ['shrunk']);
  assert.equal(second.compensationStatus, 'failed');
  assert.deepEqual(
    second.compensationAttempts.map(r => [r.operation, r.attempt, r.ok, r.nextDelayMs]),
    [['undoShrunk', 1, false, 0]],
  );
});

test('the config is fixed at run start, not when the action succeeds or compensation is prepared', async () => {
  // Park the run inside opB — after `a` has already succeeded and its
  // compensation snapshots were taken, but before any compensation is
  // prepared. Editing a's compensation at that point still changes nothing.
  const { workflow, aNode } = compensationWorkflow({
    compRetry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });

  let releaseB;
  const gateB = new Promise(resolve => { releaseB = resolve; });
  let markBStarted;
  const bStarted = new Promise(resolve => { markBStarted = resolve; });

  const calls = [];
  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, {}, {
    ...hold.operations,
    opA: () => 'A',
    opB: async () => {
      markBStarted();
      await gateB;
      throw new Error('b-boom');
    },
    undoA: (input, output, result, nodeId, attempt) => {
      calls.push(['undoA', attempt]);
      if (attempt < 2) throw new Error('undo 1');
      return 'refunded';
    },
    undoLate: () => { calls.push(['undoLate', 1]); },
  });
  await hold.started;
  await sleep(5);
  hold.release();
  // Wait until the run is parked inside the failing opB: `a` has succeeded.
  await bStarted;
  await sleep(5);

  aNode.compensation = { operation: 'undoLate' };
  validateWorkflow(workflow);
  releaseB();

  const result = await runPromise;
  assert.equal(result.status, 'action_failed');
  assert.deepEqual(calls, [['undoA', 1], ['undoA', 2]]);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]),
    [['a', 'undoA', 1, false], ['a', 'undoA', 2, true]],
  );
});

test('adding a compensation mid-run to an action that had none produces no compensation for the current run', async () => {
  const { workflow, aNode } = compensationWorkflow({ compOnA: false });

  const calls = [];
  const result = await parkMutateAndResume(
    workflow,
    {},
    {
      opA: () => 'A',
      opB: failingOpB,
      undoAdded: () => { calls.push('undoAdded'); },
    },
    () => {
      // The action had no compensation when the run started; adding one now
      // (a legal edit that re-validates) must not reach this run.
      aNode.compensation = { operation: 'undoAdded' };
      validateWorkflow(workflow);
    },
  );

  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'b');
  assert.deepEqual(calls, []);
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
  assert.equal(result.context.output.a, 'A');

  // A new run started from the modified definition does compensate.
  const second = await executeWorkflowAsync(workflow, {}, {
    hold: async () => 'held-2',
    opA: () => 'A',
    opB: failingOpB,
    undoAdded: () => { calls.push('undoAdded'); return 'undone'; },
  });
  assert.equal(second.status, 'action_failed');
  assert.deepEqual(calls, ['undoAdded']);
  assert.equal(second.compensationStatus, 'completed');
  assert.deepEqual(
    second.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]),
    [['a', 'undoAdded', 1, true]],
  );
});

test('deleting the compensation mid-run does not cancel the compensation the run started with', async () => {
  const { workflow, aNode } = compensationWorkflow({
    compRetry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });

  const calls = [];
  const result = await parkMutateAndResume(
    workflow,
    {},
    {
      opA: () => 'A',
      opB: failingOpB,
      undoA: (input, output, result2, nodeId, attempt) => {
        calls.push(attempt);
        if (attempt < 2) throw new Error('undo 1');
        return 'refunded';
      },
    },
    () => {
      // Remove the whole compensation block while the run is parked; the
      // edited definition is legal and re-validates.
      delete aNode.compensation;
      validateWorkflow(workflow);
    },
  );

  assert.equal(result.status, 'action_failed');
  // The start-time compensation still runs, under its start-time retry.
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['a', 'undoA', 1, false, null], ['a', 'undoA', 2, true, 'refunded']],
  );

  // A new run started from the modified definition has nothing to compensate.
  calls.length = 0;
  const second = await executeWorkflowAsync(workflow, {}, {
    hold: async () => 'held-2',
    opA: () => 'A',
    opB: failingOpB,
    undoA: () => { calls.push('undoA'); },
  });
  assert.equal(second.status, 'action_failed');
  assert.deepEqual(calls, []);
  assert.equal(second.compensationStatus, 'not_needed');
  assert.deepEqual(second.compensationAttempts, []);
});

test('an illegal edited compensation fails validation with node and reason while the parked run keeps its legal config', async () => {
  const { workflow, aNode } = compensationWorkflow({
    compRetry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });

  const calls = [];
  const hold = gatedHold();
  const operations = {
    ...hold.operations,
    opA: () => 'A',
    opB: failingOpB,
    undoA: (input, output, result, nodeId, attempt) => {
      calls.push(['undoA', attempt]);
      return 'refunded';
    },
  };
  const runPromise = executeWorkflowAsync(workflow, {}, operations);
  await hold.started;
  await sleep(5);

  // Make the definition illegal: a zero-attempt compensation retry.
  aNode.compensation = {
    operation: 'undoA',
    retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  };
  assert.throws(
    () => validateWorkflow(workflow),
    error => /action node a compensation/.test(error.message)
      && /retry\.attempts must be an integer between 1 and 10/.test(error.message),
  );

  // A new run from the illegal definition is rejected before any business
  // operation or compensation is invoked.
  const spy = { opA: 0, opB: 0, undoA: 0 };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      hold: async () => 'never',
      opA: () => { spy.opA += 1; return 'A'; },
      opB: () => { spy.opB += 1; return 'B'; },
      undoA: () => { spy.undoA += 1; },
    }),
    /action node a compensation: retry\.attempts must be an integer between 1 and 10/,
  );
  assert.deepEqual(spy, { opA: 0, opB: 0, undoA: 0 });

  // The already-started legal run is untouched by the illegal edit and
  // finishes under the configuration its own start accepted.
  hold.release();
  const result = await runPromise;
  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'b');
  assert.deepEqual(calls, [['undoA', 1]]);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['a', 'undoA', 1, true, 'refunded']],
  );
});

test('two runs sharing one definition each keep the compensation rule their own start adopted', async () => {
  const { workflow, aNode } = compensationWorkflow({
    compRetry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });

  // Run A starts under the original config and parks.
  const holdA = gatedHold('hold', 'held-A');
  const callsA = [];
  const runA = executeWorkflowAsync(workflow, {}, {
    ...holdA.operations,
    opA: () => 'A',
    opB: failingOpB,
    undoA: (input, output, result, nodeId, attempt) => {
      callsA.push(attempt);
      if (attempt < 2) throw new Error('undo 1');
      return 'refunded-A';
    },
    undoNew: () => { callsA.push('new'); },
  });
  await holdA.started;
  await sleep(5);

  // The shared definition changes and is independently re-validated.
  aNode.compensation = { operation: 'undoNew' };
  validateWorkflow(workflow);

  // Run B starts under the new config and parks too.
  const holdB = gatedHold('hold', 'held-B');
  const callsB = [];
  const runB = executeWorkflowAsync(workflow, {}, {
    ...holdB.operations,
    opA: () => 'A',
    opB: failingOpB,
    undoA: () => { callsB.push('old'); },
    undoNew: () => { callsB.push('new'); return 'refunded-B'; },
  });
  await holdB.started;
  await sleep(5);

  // Finish B first: completion order must not matter.
  holdB.release();
  holdA.release();
  const [a, b] = await Promise.all([runA, runB]);

  // Run A: original operation, original two-attempt budget.
  assert.equal(a.status, 'action_failed');
  assert.deepEqual(callsA, [1, 2]);
  assert.equal(a.compensationStatus, 'completed');
  assert.deepEqual(
    a.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['a', 'undoA', 1, false, null], ['a', 'undoA', 2, true, 'refunded-A']],
  );

  // Run B: the renamed operation, attempted exactly once.
  assert.equal(b.status, 'action_failed');
  assert.deepEqual(callsB, ['new']);
  assert.equal(b.compensationStatus, 'completed');
  assert.deepEqual(
    b.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['a', 'undoNew', 1, true, 'refunded-B']],
  );
});
