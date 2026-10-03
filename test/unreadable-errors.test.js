import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

const UNREADABLE = '无法读取异常信息';

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

function revokedProxy() {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

test('a thrown revoked Proxy fails the attempt with the fixed unreadable-error text', async () => {
  let calls = 0;
  const execution = await executeWorkflowAsync(linearWorkflow({ operation: 'charge' }), {}, {
    charge: () => { calls += 1; throw revokedProxy(); },
  });
  assert.equal(calls, 1);
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.equal(execution.attempts, 1);
  assert.equal(execution.error, UNREADABLE);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: UNREADABLE, nextDelayMs: 0 },
  ]);
  // Prior successful output and the trace survive; the failed node stores
  // nothing and its successor never runs.
  assert.deepEqual(execution.context.output, { prep: 'prepared' });
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'work']);
});

test('a Promise rejected with a revoked Proxy is handled exactly like a throw', async () => {
  let calls = 0;
  const execution = await executeWorkflowAsync(linearWorkflow({ operation: 'charge' }), {}, {
    charge: () => { calls += 1; return Promise.reject(revokedProxy()); },
  });
  assert.equal(calls, 1);
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.error, UNREADABLE);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: UNREADABLE, nextDelayMs: 0 },
  ]);
});

test('a proxy whose prototype read throws also yields the fixed text', async () => {
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('trap boom'); } });
  const execution = await executeWorkflowAsync(linearWorkflow({ operation: 'charge' }), {}, {
    charge: () => { throw hostile; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.error, UNREADABLE);
  assert.deepEqual(execution.actionAttempts.map(a => a.error), [UNREADABLE]);
});

test('hostile exception values respect the node retry config: one record per actual invocation', async () => {
  let calls = 0;
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 3, initialDelayMs: 2, backoffFactor: 2, maxDelayMs: 10 },
  });
  const started = Date.now();
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: () => { calls += 1; throw revokedProxy(); },
  });
  assert.equal(calls, 3);
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.attempts, 3);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: UNREADABLE, nextDelayMs: 2 },
    { nodeId: 'work', attempt: 2, ok: false, error: UNREADABLE, nextDelayMs: 4 },
    { nodeId: 'work', attempt: 3, ok: false, error: UNREADABLE, nextDelayMs: 0 },
  ]);
  assert.ok(Date.now() - started >= 5, 'retry waits still happen');
});

test('a later success after a hostile-value failure saves the output and continues', async () => {
  let calls = 0;
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: () => {
      calls += 1;
      if (calls === 1) throw revokedProxy();
      return 'charged';
    },
  });
  assert.equal(calls, 2);
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'finished');
  assert.equal(execution.context.output.work, 'charged');
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: UNREADABLE, nextDelayMs: 0 },
    { nodeId: 'work', attempt: 2, ok: true, error: null, nextDelayMs: 0 },
  ]);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'work', 'done']);
});

test('ordinary Error messages, empty messages and primitive thrown values keep their text', async () => {
  const cases = [
    [() => { throw new Error('card declined'); }, 'card declined'],
    [() => { throw new Error(''); }, ''],
    [() => { throw 'plain string'; }, 'plain string'],
    [() => { throw 42; }, '42'],
    [() => { throw true; }, 'true'],
    [() => { throw null; }, 'null'],
    [() => { throw undefined; }, 'undefined'],
    [() => Promise.reject('rejected string'), 'rejected string'],
  ];
  for (const [impl, expected] of cases) {
    const execution = await executeWorkflowAsync(linearWorkflow({ operation: 'charge' }), {}, { charge: impl });
    assert.equal(execution.status, 'action_failed');
    assert.equal(execution.error, expected);
    assert.deepEqual(execution.actionAttempts, [
      { nodeId: 'work', attempt: 1, ok: false, error: expected, nextDelayMs: 0 },
    ]);
  }
});

test('unreadable messages and unconvertible objects use the fixed text without being mutated', async () => {
  const withGetter = new Error('x');
  Object.defineProperty(withGetter, 'message', {
    get() { throw new Error('getter boom'); },
  });
  const nonStringMessage = new Error('x');
  nonStringMessage.message = { not: 'a string' };
  const noToString = Object.create(null);
  noToString.marker = 'kept';

  for (const thrown of [withGetter, nonStringMessage, noToString]) {
    const execution = await executeWorkflowAsync(linearWorkflow({ operation: 'charge' }), {}, {
      charge: () => { throw thrown; },
    });
    assert.equal(execution.status, 'action_failed');
    assert.equal(execution.error, UNREADABLE);
  }
  assert.equal(noToString.marker, 'kept');
  assert.equal(nonStringMessage.message.not, 'a string');
});

test('compensation throwing a hostile value records the fixed text and later compensations still run', async () => {
  const calls = [];
  const workflow = {
    id: 'chain', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      {
        id: 'b', type: 'action', operation: 'opB',
        compensation: {
          operation: 'undoB',
          retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        },
        next: 'c',
      },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: () => { throw new Error('c-boom'); },
    undoA: () => { calls.push('undoA'); return 'ua'; },
    undoB: () => { calls.push('undoB'); throw revokedProxy(); },
  });
  // The run keeps its original failure shape; the hostile compensation value
  // neither rejects the promise nor hides the result.
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.error, 'c-boom');
  assert.equal(execution.compensationStatus, 'failed');
  // undoB fails with the fixed text on each of its own retry attempts, then
  // the earlier undoA still runs and succeeds.
  assert.deepEqual(calls, ['undoB', 'undoB', 'undoA']);
  assert.deepEqual(execution.compensationAttempts, [
    { nodeId: 'b', operation: 'undoB', attempt: 1, ok: false, error: UNREADABLE, nextDelayMs: 0, result: null },
    { nodeId: 'b', operation: 'undoB', attempt: 2, ok: false, error: UNREADABLE, nextDelayMs: 0, result: null },
    { nodeId: 'a', operation: 'undoA', attempt: 1, ok: true, error: null, nextDelayMs: 0, result: 'ua' },
  ]);
  assert.deepEqual(execution.context.output, { a: 'A', b: 'B' });
});

test('a compensation rejecting with a hostile value behaves like a throw', async () => {
  const workflow = {
    id: 'comps', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('trap boom'); } });
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => { throw new Error('b-boom'); },
    undoA: () => Promise.reject(hostile),
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts, [
    { nodeId: 'a', operation: 'undoA', attempt: 1, ok: false, error: UNREADABLE, nextDelayMs: 0, result: null },
  ]);
});
