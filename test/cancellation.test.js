import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// trigger -> work (business) -> done
function linearWorkflow(actionProps = {}) {
  return {
    id: 'cancellable',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', ...actionProps, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

test('omitted, undefined or signal-less options keep the existing behavior', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  const operations = { echo: () => 'ok' };
  for (const options of [undefined, {}, { signal: undefined }]) {
    const execution = options === undefined
      ? await executeWorkflowAsync(workflow, {}, operations)
      : await executeWorkflowAsync(workflow, {}, operations, options);
    assert.equal(execution.status, 'completed');
    assert.equal(execution.result, 'finished');
    assert.equal(execution.context.output.work, 'ok');
    assert.equal(execution.compensationStatus, 'not_needed');
  }
});

test('options of any other type are rejected before any node executes', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  let called = 0;
  const operations = { echo: () => { called += 1; return 'ok'; } };
  const badOptions = [
    null, 0, 'signal', true, [], () => {},
    { signal: null }, { signal: {} }, { signal: 'abort' }, { signal: new AbortController() },
  ];
  for (const options of badOptions) {
    await assert.rejects(
      () => executeWorkflowAsync(workflow, {}, operations, options),
      /signal|options/
    );
  }
  assert.equal(called, 0);
});

test('a signal aborted before the start returns an empty cancelled run and invokes nothing', async () => {
  const workflow = linearWorkflow({
    operation: 'echo',
    compensation: { operation: 'undo' },
  });
  let businessCalls = 0;
  let compensationCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const callerInput = { amount: 5 };
  const execution = await executeWorkflowAsync(workflow, callerInput, {
    echo: () => { businessCalls += 1; return 'ok'; },
    undo: () => { compensationCalls += 1; },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  assert.deepEqual(execution.trace, []);
  assert.deepEqual(execution.actionAttempts, []);
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
  assert.deepEqual(execution.context.input, { amount: 5 });
  assert.deepEqual(execution.context.output, {});
  assert.equal(businessCalls, 0);
  assert.equal(compensationCalls, 0);
  // The reported input is an independent copy.
  execution.context.input.amount = 999;
  assert.deepEqual(callerInput, { amount: 5 });
});

test('a pre-aborted signal still runs definition and registration checks first', async () => {
  const controller = new AbortController();
  controller.abort();
  const { signal } = controller;

  const invalid = {
    id: 'bad', entry: 'start',
    nodes: [{ id: 'start', type: 'trigger', next: 'ghost' }],
  };
  await assert.rejects(
    () => executeWorkflowAsync(invalid, {}, {}, { signal }),
    /unknown destination/
  );

  const missingOperation = linearWorkflow({ operation: 'echo' });
  await assert.rejects(
    () => executeWorkflowAsync(missingOperation, {}, {}, { signal }),
    /action node work/
  );

  const missingCompensation = linearWorkflow({
    operation: 'echo',
    compensation: { operation: 'undo' },
  });
  await assert.rejects(
    () => executeWorkflowAsync(missingCompensation, {}, { echo: () => 'ok' }, { signal }),
    /compensation operation "undo"/
  );
});

test('cancellation between nodes stops scheduling and compensates earlier successes', async () => {
  const controller = new AbortController();
  const calls = [];
  const workflow = {
    id: 'two-step', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => { controller.abort(); return 'A'; },
    opB: () => { calls.push('opB'); return 'B'; },
    undoA: () => { calls.push('undoA'); return 'ua'; },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  // b never ran; a's success is recorded, stored and compensated.
  assert.deepEqual(calls, ['undoA']);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a']);
  assert.deepEqual(execution.context.output, { a: 'A' });
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'a', attempt: 1, ok: true, error: null, nextDelayMs: 0 },
  ]);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.ok]), [
    ['a', 'undoA', true],
  ]);
});

test('cancellation during a retry wait ends the wait immediately and stops retrying', async () => {
  const controller = new AbortController();
  const workflow = linearWorkflow({
    operation: 'flaky',
    retry: { attempts: 5, initialDelayMs: 30000, backoffFactor: 1, maxDelayMs: 30000 },
  });
  let calls = 0;
  const started = Date.now();
  const execution = await executeWorkflowAsync(workflow, {}, {
    flaky: () => {
      calls += 1;
      setTimeout(() => controller.abort(), 20);
      throw new Error('boom');
    },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal(calls, 1);
  // The 30s wait was cut short.
  assert.ok(Date.now() - started < 5000);
  // The failed attempt keeps its error but its promised delay is gone.
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: 'boom', nextDelayMs: 0 },
  ]);
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
});

test('no new attempt starts after cancellation even with a zero retry delay', async () => {
  const controller = new AbortController();
  const workflow = linearWorkflow({
    operation: 'flaky',
    retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  let calls = 0;
  const execution = await executeWorkflowAsync(workflow, {}, {
    flaky: () => {
      calls += 1;
      controller.abort();
      throw new Error(`boom ${calls}`);
    },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal(calls, 1);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: 'boom 1', nextDelayMs: 0 },
  ]);
});

test('cancellation while an operation is in flight waits for it and keeps its success', async () => {
  const controller = new AbortController();
  const compensated = [];
  const workflow = linearWorkflow({
    operation: 'slow',
    compensation: { operation: 'undoSlow' },
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async (input, output, nodeId, attempt) => {
      assert.equal(nodeId, 'work');
      assert.equal(attempt, 1);
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      return 'slow-result';
    },
    undoSlow: (input, output, result, nodeId) => {
      compensated.push({ result, nodeId });
      return 'undone';
    },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  // The in-flight operation finished untouched: its output, success record
  // and compensation scheduling all reflect the success.
  assert.equal(execution.context.output.work, 'slow-result');
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: true, error: null, nextDelayMs: 0 },
  ]);
  assert.deepEqual(compensated, [{ result: 'slow-result', nodeId: 'work' }]);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'work']);
});

test('cancellation while an operation is in flight keeps its failure and skips retries', async () => {
  const controller = new AbortController();
  const workflow = linearWorkflow({
    operation: 'slow',
    retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  let calls = 0;
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      calls += 1;
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      throw new Error('late failure');
    },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(execution.context.output.work, undefined);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: 'late failure', nextDelayMs: 0 },
  ]);
});

test('a cancelled last failed attempt ends cancelled, not action_failed', async () => {
  const controller = new AbortController();
  const workflow = linearWorkflow({ operation: 'doomed' });
  const execution = await executeWorkflowAsync(workflow, {}, {
    doomed: async () => {
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      throw new Error('final boom');
    },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal('nodeId' in execution, false);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: 'final boom', nextDelayMs: 0 },
  ]);
});

test('a run that already visited end but has unfinished branches can still be cancelled', async () => {
  const controller = new AbortController();
  const workflow = {
    id: 'early-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: 'early' },
      { id: 'work', type: 'action', operation: 'slow', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      return 'done';
    },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'finish', 'work']);
  assert.equal(execution.context.output.work, 'done');
});

test('cancellation affects only the run that carries the signal', async () => {
  const controller = new AbortController();
  const workflow = {
    id: 'parallel', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'slow', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const operations = {
    slow: async () => {
      await sleep(30);
      return 'done';
    },
  };
  const [cancelled, untouched] = await Promise.all([
    executeWorkflowAsync(workflow, { run: 1 }, operations, { signal: controller.signal }),
    executeWorkflowAsync(workflow, { run: 2 }, operations),
    (async () => { await sleep(10); controller.abort(); })(),
  ]).then(([a, b]) => [a, b]);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(untouched.status, 'completed');
  assert.equal(untouched.result, 'finished');
  assert.equal(untouched.context.output.work, 'done');
});

test('cancellation during compensation of an already-failed run cannot rewrite the result', async () => {
  const controller = new AbortController();
  const calls = [];
  const workflow = {
    id: 'fail-then-compensate', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => { throw new Error('b-boom'); },
    undoA: async () => {
      calls.push('undoA:start');
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      calls.push('undoA:end');
      return 'undone';
    },
  }, { signal: controller.signal });

  // The terminal state was already action_failed when the signal fired.
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'b');
  assert.deepEqual(calls, ['undoA:start', 'undoA:end']);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.ok, r.result]), [
    ['a', true, 'undone'],
  ]);
});

test('compensation after cancellation follows the usual reverse order and failure rules', async () => {
  const controller = new AbortController();
  const calls = [];
  const workflow = {
    id: 'chain', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'undoB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: () => { controller.abort(); return 'C'; },
    undoA: () => { calls.push('undoA'); return 'ua'; },
    undoB: () => { calls.push('undoB'); throw new Error('undo failed'); },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  // c succeeded too, but declared no compensation; b's compensation fails
  // without stopping a's, and the failure is reflected in the status.
  assert.deepEqual(calls, ['undoB', 'undoA']);
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.ok]), [
    ['b', false], ['a', true],
  ]);
  // Successful outputs are never deleted by compensation.
  assert.deepEqual(execution.context.output, { a: 'A', b: 'B', c: 'C' });
});

test('cancelling a run with nothing to compensate reports not_needed', async () => {
  const controller = new AbortController();
  const workflow = {
    id: 'plain', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    op: () => { controller.abort(); return 'ok'; },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
});

test('the synchronous entry and uncancelled runs are untouched by the new parameter', async () => {
  const syncWorkflow = {
    id: 'sync', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', message: 'legacy', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const execution = executeWorkflow(syncWorkflow, {});
  assert.equal(execution.status, 'completed');
  assert.equal(execution.context.output.work, 'legacy');

  const controller = new AbortController();
  const asyncExecution = await executeWorkflowAsync(
    linearWorkflow({ operation: 'echo' }), {}, { echo: () => 'ok' }, { signal: controller.signal });
  assert.equal(asyncExecution.status, 'completed');
  controller.abort();
  assert.equal(asyncExecution.status, 'completed');
});
