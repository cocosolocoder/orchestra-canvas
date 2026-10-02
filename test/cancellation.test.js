import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function linearWorkflow(actionProps = {}) {
  return {
    id: 'ops',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'work' },
      { id: 'work', type: 'action', ...actionProps, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

test('omitting signal or passing undefined keeps the existing behavior', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  const a = await executeWorkflowAsync(workflow, {}, { echo: () => 'A' });
  assert.equal(a.status, 'completed');
  const b = await executeWorkflowAsync(workflow, {}, { echo: () => 'B' }, undefined);
  assert.equal(b.status, 'completed');
  const c = await executeWorkflowAsync(workflow, {}, { echo: () => 'C' }, {});
  assert.equal(c.status, 'completed');
  const d = await executeWorkflowAsync(workflow, {}, { echo: () => 'D' }, { signal: undefined });
  assert.equal(d.status, 'completed');
});

test('non-AbortSignal signal values are rejected before any node runs', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  let calls = 0;
  const ops = { echo: () => { calls += 1; return 'x'; } };
  for (const bad of ['abort', 42, null, {}, [], true]) {
    await assert.rejects(
      () => executeWorkflowAsync(workflow, {}, ops, { signal: bad }),
      /options\.signal/,
    );
  }
  assert.equal(calls, 0);
});

test('a non-object options argument is rejected', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { echo: () => 'x' }, 'nope'),
    /options/,
  );
});

test('a pre-aborted signal still runs definition and operation checks first', async () => {
  // Definition error is reported even with an already-aborted signal.
  const badDefinition = {
    id: 'bad', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'missing' },
      { id: 'ghost', type: 'end', result: 'x' },
    ],
  };
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => executeWorkflowAsync(badDefinition, {}, {}, { signal: ac.signal }),
    /unknown destination/,
  );

  // Missing operation implementation is reported even with an aborted signal.
  const workflow = linearWorkflow({ operation: 'echo' });
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {}, { signal: ac.signal }),
    /action node work/,
  );
});

test('a pre-aborted signal returns an empty trace and attempts with no operations invoked', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  let calls = 0;
  const ac = new AbortController();
  ac.abort();
  const input = { amount: 5, nested: { v: 1 } };
  const execution = await executeWorkflowAsync(workflow, input, {
    echo: () => { calls += 1; return 'x'; },
  }, { signal: ac.signal });
  assert.equal(execution.status, 'cancelled');
  assert.deepEqual(execution.trace, []);
  assert.deepEqual(execution.actionAttempts, []);
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
  assert.equal('result' in execution, false);
  assert.deepEqual(execution.context.input, { amount: 5, nested: { v: 1 } });
  // The input is an independent copy.
  assert.notEqual(execution.context.input, input);
  assert.equal(calls, 0);
});

test('cancellation before the next node stops normal nodes and keeps the gathered state', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  const ac = new AbortController();
  let resolveOp;
  const executionPromise = executeWorkflowAsync(workflow, { amount: 5 }, {
    echo: () => new Promise(resolve => { resolveOp = resolve; }),
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  resolveOp('done');
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  // start, prep and work were traced; the end node never runs.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'work']);
  assert.deepEqual(execution.context.input, { amount: 5 });
  assert.equal(execution.compensationStatus, 'not_needed');
});

test('cancellation during a retry wait ends the wait immediately and zeroes the delay', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 3, initialDelayMs: 500, backoffFactor: 1, maxDelayMs: 500 },
  });
  const ac = new AbortController();
  let calls = 0;
  const started = Date.now();
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    charge: () => { calls += 1; throw new Error(`fail ${calls}`); },
  }, { signal: ac.signal });
  await sleep(30);
  ac.abort();
  const execution = await executionPromise;
  const elapsed = Date.now() - started;
  assert.equal(execution.status, 'cancelled');
  assert.equal(calls, 1);
  assert.ok(elapsed < 300, `wait should have been cut short, took ${elapsed}ms`);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: 'fail 1', nextDelayMs: 0 },
  ]);
});

test('even with a zero retry interval no new attempt starts after cancellation', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const ac = new AbortController();
  let calls = 0;
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: () => {
      calls += 1;
      // Abort while the first attempt is in flight; it then fails. Even with
      // a zero retry interval, no second attempt may start.
      if (calls === 1) {
        ac.abort();
        throw new Error('nope');
      }
      return 'ok';
    },
  }, { signal: ac.signal });
  assert.equal(execution.status, 'cancelled');
  assert.equal(calls, 1);
  assert.deepEqual(execution.actionAttempts.map(r => [r.attempt, r.ok]), [[1, false]]);
});

test('cancellation while an operation is in flight waits for it and stores a success', async () => {
  const workflow = linearWorkflow({ operation: 'charge' });
  const ac = new AbortController();
  let resolveOp;
  const calls = [];
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    charge: (input, output, nodeId, attempt) => {
      calls.push({ nodeId, attempt });
      return new Promise(resolve => { resolveOp = resolve; });
    },
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  // The operation is not interrupted: it settles after the abort.
  await sleep(20);
  assert.equal(calls.length, 1);
  resolveOp('charged');
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.context.output.work, 'charged');
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: true, error: null, nextDelayMs: 0 },
  ]);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'work']);
});

test('cancellation while an operation is in flight keeps a failure with no retry', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const ac = new AbortController();
  let rejectOp;
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    charge: () => new Promise((_, reject) => { rejectOp = reject; }),
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  rejectOp(new Error('late failure'));
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.context.output.work, undefined);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: 'late failure', nextDelayMs: 0 },
  ]);
});

test('cancellation before processing the last failed attempt still yields cancelled', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const ac = new AbortController();
  let calls = 0;
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: () => {
      calls += 1;
      if (calls === 1) throw new Error('first');
      // Abort while the second attempt is in flight; it then fails.
      if (calls === 2) {
        ac.abort();
        throw new Error('second');
      }
      return 'ok';
    },
  }, { signal: ac.signal });
  assert.equal(execution.status, 'cancelled');
  assert.equal(calls, 2);
  assert.deepEqual(execution.actionAttempts.map(r => [r.attempt, r.ok, r.error]), [
    [1, false, 'first'],
    [2, false, 'second'],
  ]);
});

test('a successful operation after cancellation is compensated in reverse order', async () => {
  const calls = [];
  const workflow = {
    id: 'chain', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'undoB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const ac = new AbortController();
  let resolveC;
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: () => new Promise(resolve => { resolveC = resolve; }),
    undoA: () => { calls.push('undoA'); return 'ua'; },
    undoB: () => { calls.push('undoB'); return 'ub'; },
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  resolveC('C');
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.deepEqual(calls, ['undoB', 'undoA']);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.ok]), [
    ['b', 'undoB', true],
    ['a', 'undoA', true],
  ]);
  assert.equal(execution.context.output.a, 'A');
  assert.equal(execution.context.output.b, 'B');
});

test('compensation failure during a cancelled run still processes earlier actions', async () => {
  const calls = [];
  const workflow = {
    id: 'chain', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'undoB' }, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const ac = new AbortController();
  let resolveB;
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => new Promise(resolve => { resolveB = resolve; }),
    undoA: () => { calls.push('undoA'); return 'ua'; },
    undoB: () => { calls.push('undoB'); throw new Error('stuck'); },
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  resolveB('B');
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.deepEqual(calls, ['undoB', 'undoA']);
  assert.equal(execution.compensationStatus, 'failed');
});

test('cancellation during compensation does not interrupt or repeat it', async () => {
  const workflow = {
    id: 'comp-wait', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const ac = new AbortController();
  let resolveOp;
  let undoCalls = 0;
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    opA: () => new Promise(resolve => { resolveOp = resolve; }),
    undoA: async () => {
      undoCalls += 1;
      await sleep(80);
      return 'undone';
    },
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  resolveOp('A');
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.equal(undoCalls, 1);
  assert.equal(execution.compensationStatus, 'completed');
});

test('a cancelled run with no compensable action reports not_needed', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  const ac = new AbortController();
  let resolveOp;
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    echo: () => new Promise(resolve => { resolveOp = resolve; }),
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  resolveOp('done');
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
});

test('a run that reached end with other active branches can still be cancelled', async () => {
  const workflow = {
    id: 'late-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: 'early' },
      { id: 'work', type: 'action', operation: 'op', next: 'finish' },
    ],
  };
  const ac = new AbortController();
  let resolveOp;
  const executionPromise = executeWorkflowAsync(workflow, {}, {
    op: () => new Promise(resolve => { resolveOp = resolve; }),
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  resolveOp('done');
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'finish', 'work']);
});

test('cancellation after terminal state is determined does not rewrite the result', async () => {
  const workflow = {
    id: 'action-fail', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const ac = new AbortController();
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => { throw new Error('boom'); },
    undoA: async () => {
      // The failure terminal state is already determined; aborting during
      // compensation must not rewrite it.
      ac.abort();
      await sleep(20);
      return 'undone';
    },
  }, { signal: ac.signal });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.error, 'boom');
  assert.equal(execution.compensationStatus, 'completed');
});

test('cancellation after a blocked terminal state does not rewrite the result', async () => {
  const workflow = {
    id: 'blocked', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'vip', operator: 'eq', value: true }, then: 'priority', else: 'standard' },
      { id: 'priority', type: 'action', operation: 'priority', compensation: { operation: 'undoPriority' }, next: 'wrap' },
      { id: 'standard', type: 'action', message: 'standard', next: 'wrap' },
      { id: 'wrap', type: 'action', dependsOn: ['standard', 'priority'], next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const ac = new AbortController();
  const execution = await executeWorkflowAsync(workflow, { vip: true }, {
    priority: () => 'p',
    undoPriority: async () => {
      // The blocked terminal state is already determined; aborting during
      // compensation must not rewrite it.
      ac.abort();
      await sleep(20);
      return 'up';
    },
  }, { signal: ac.signal });
  assert.equal(execution.status, 'blocked');
  assert.deepEqual(execution.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  assert.equal(execution.compensationStatus, 'completed');
});

test('cancellation of one run does not affect another run of the same workflow', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  let resolveFirst;
  const firstPromise = executeWorkflowAsync(workflow, {}, {
    echo: () => new Promise(resolve => { resolveFirst = resolve; }),
  }, { signal: ac1.signal });
  const secondPromise = executeWorkflowAsync(workflow, {}, {
    echo: () => 'second',
  }, { signal: ac2.signal });
  ac1.abort();
  resolveFirst('first');
  const first = await firstPromise;
  const second = await secondPromise;
  assert.equal(first.status, 'cancelled');
  assert.equal(second.status, 'completed');
  assert.equal(second.context.output.work, 'second');
});

test('cancellation of a run with a successful compensable action keeps the success record and snapshots', async () => {
  const seen = [];
  const workflow = {
    id: 'snapshot', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const ac = new AbortController();
  let resolveOp;
  const executionPromise = executeWorkflowAsync(workflow, { amount: 9 }, {
    opA: () => new Promise(resolve => { resolveOp = resolve; }),
    undoA: (input, output, result, nodeId, attempt) => {
      seen.push({ input: structuredClone(input), result: structuredClone(result), nodeId, attempt });
      return 'refunded';
    },
  }, { signal: ac.signal });
  await sleep(20);
  ac.abort();
  resolveOp({ charged: true });
  const execution = await executionPromise;
  assert.equal(execution.status, 'cancelled');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].input, { amount: 9 });
  assert.equal(seen[0].nodeId, 'a');
  assert.equal(seen[0].attempt, 1);
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.ok, r.result]), [
    ['a', 'undoA', true, 'refunded'],
  ]);
});

test('validateWorkflow still rejects bad definitions independently of signals', () => {
  assert.throws(() => validateWorkflow({
    id: 'x', entry: 'start',
    nodes: [{ id: 'start', type: 'trigger', next: 'nope' }],
  }), /unknown destination/);
});
