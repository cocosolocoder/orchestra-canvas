import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

const PLACEHOLDER = '无法读取异常信息';

// A Proxy revoked before it is thrown: merely running `value instanceof
// Error` (the prototype-walk the engine does while describing the failure)
// throws a TypeError, and so does reading the value for String().
function revokedProxy() {
  const handle = Proxy.revocable({}, {});
  handle.revoke();
  return handle.proxy;
}

// A Proxy whose getPrototypeOf trap throws. The same `instanceof` walk the
// engine performs on a caught value triggers the trap.
function throwingPrototypeProxy() {
  return new Proxy({}, {
    getPrototypeOf() { throw new Error('prototype trap boom'); },
  });
}

function failingWorkflow(retry = { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }, { withSuccessor = false } = {}) {
  return {
    id: 'unreadable',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'boom', retry, next: withSuccessor ? 'after' : 'done' },
      ...(withSuccessor ? [{ id: 'after', type: 'action', operation: 'afterOp', next: 'done' }] : []),
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

for (const [label, makeValue] of [
  ['a revoked Proxy', revokedProxy],
  ['a proxy whose prototype read throws', throwingPrototypeProxy],
]) {
  test(`a synchronously thrown ${label} is recorded as a failure, not a rejection`, async () => {
    const value = makeValue();
    let calls = 0;
    const execution = await executeWorkflowAsync(failingWorkflow(), {}, {
      boom: () => { calls += 1; throw value; },
      afterOp: () => assert.fail('successors of a failed node must not run'),
    });
    assert.equal(execution.status, 'action_failed');
    assert.equal(execution.nodeId, 'work');
    assert.equal(execution.attempts, 2);
    assert.equal(calls, 2); // exactly one invocation per configured attempt
    assert.equal(execution.error, PLACEHOLDER);
    assert.deepEqual(execution.actionAttempts, [
      { nodeId: 'work', attempt: 1, ok: false, error: PLACEHOLDER, nextDelayMs: 0 },
      { nodeId: 'work', attempt: 2, ok: false, error: PLACEHOLDER, nextDelayMs: 0 },
    ]);
    // The failed node saves no output and its successors never execute.
    assert.equal(Object.hasOwn(execution.context.output, 'work'), false);
    assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'work']);
  });

  test(`a Promise rejected with ${label} gives the same result as a synchronous throw`, async () => {
    const value = makeValue();
    const execution = await executeWorkflowAsync(failingWorkflow(), {}, {
      boom: () => Promise.reject(value),
    });
    assert.equal(execution.status, 'action_failed');
    assert.equal(execution.error, PLACEHOLDER);
    assert.deepEqual(execution.actionAttempts.map(a => [a.attempt, a.ok, a.error]),
      [[1, false, PLACEHOLDER], [2, false, PLACEHOLDER]]);
  });

  test(`an async function rejecting with ${label} gives the same result as a synchronous throw`, async () => {
    const value = makeValue();
    const execution = await executeWorkflowAsync(failingWorkflow(), {}, {
      boom: async () => { throw value; },
    });
    assert.equal(execution.status, 'action_failed');
    assert.equal(execution.error, PLACEHOLDER);
    assert.equal(execution.actionAttempts.length, 2);
  });
}

test('unreadable failure attempts keep the node retry count and configured delays', async () => {
  const workflow = {
    id: 'delays',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'boom',
        retry: { attempts: 3, initialDelayMs: 10, backoffFactor: 2, maxDelayMs: 100 }, next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, { boom: () => { throw revokedProxy(); } });
  assert.equal(execution.status, 'action_failed');
  assert.deepEqual(execution.actionAttempts.map(a => [a.attempt, a.ok, a.error, a.nextDelayMs]), [
    [1, false, PLACEHOLDER, 10],
    [2, false, PLACEHOLDER, 20],
    [3, false, PLACEHOLDER, 0],
  ]);
});

test('a later attempt succeeding after unreadable failures saves the output and continues', async () => {
  let calls = 0;
  const execution = await executeWorkflowAsync(
    failingWorkflow({ attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }, { withSuccessor: true }), {}, {
    boom: () => {
      calls += 1;
      if (calls < 3) throw revokedProxy();
      return 'recovered';
    },
    afterOp: () => 'after-value',
  });
  assert.equal(execution.status, 'completed');
  assert.equal(calls, 3);
  assert.equal(execution.context.output.work, 'recovered');
  assert.equal(execution.context.output.after, 'after-value');
  assert.deepEqual(execution.actionAttempts.filter(a => a.nodeId === 'work').map(a => [a.nodeId, a.attempt, a.ok, a.error, a.nextDelayMs]), [
    ['work', 1, false, PLACEHOLDER, 0],
    ['work', 2, false, PLACEHOLDER, 0],
    ['work', 3, true, null, 0],
  ]);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'work', 'after', 'done']);
});

test('ordinary thrown values keep their existing text representations', async () => {
  const cases = [
    [new Error('card declined'), 'card declined'],
    [new Error(''), ''], // an empty message still records a failure
    ['string failure', 'string failure'],
    [42, '42'],
    [0, '0'],
    [true, 'true'],
    [false, 'false'],
    [null, 'null'],
    [undefined, 'undefined'],
  ];
  for (const [thrown, expectedText] of cases) {
    const execution = await executeWorkflowAsync(failingWorkflow({ attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }), {}, {
      boom: () => { throw thrown; },
      afterOp: () => assert.fail('successors of a failed node must not run'),
    });
    assert.equal(execution.status, 'action_failed', `status for ${String(thrown)}`);
    assert.equal(execution.error, expectedText, `error text for ${String(thrown)}`);
    assert.equal(execution.actionAttempts.length, 1, `record count for ${String(thrown)}`);
    assert.equal(execution.actionAttempts[0].error, expectedText);
  }
});

test('describing an unreadable failure does not mutate the thrown value', async () => {
  const value = { kept: true };
  const execution = await executeWorkflowAsync(
    failingWorkflow({ attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }), {},
    {
      boom: () => { throw value; },
      afterOp: () => assert.fail('successors of a failed node must not run'),
    });
  assert.equal(execution.status, 'action_failed');
  assert.deepEqual(value, { kept: true });
});

test('an unreadable compensation failure uses its own retries and keeps the original run failure', async () => {
  const workflow = {
    id: 'comp-unreadable',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: {
          operation: 'undoA',
          retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        },
        next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };

  for (const [label, reject] of [
    ['sync throw', () => { throw revokedProxy(); }],
    ['rejected promise', () => Promise.reject(throwingPrototypeProxy())],
  ]) {
    let undoCalls = 0;
    const execution = await executeWorkflowAsync(workflow, {}, {
      opA: () => 'A-result',
      opB: () => { throw new Error('b-boom'); },
      undoA: () => { undoCalls += 1; return reject(); },
    });
    assert.equal(execution.status, 'action_failed', label);
    assert.equal(execution.nodeId, 'b', label);
    assert.equal(execution.error, 'b-boom', label);
    assert.equal(undoCalls, 2, label); // compensation retries on its own configuration
    assert.equal(execution.compensationStatus, 'failed', label);
    assert.deepEqual(
      execution.compensationAttempts.map(a => [a.nodeId, a.operation, a.attempt, a.ok, a.error, a.result]),
      [
        ['a', 'undoA', 1, false, PLACEHOLDER, null],
        ['a', 'undoA', 2, false, PLACEHOLDER, null],
      ],
      label,
    );
    // The successful business output and the run trace survive.
    assert.equal(execution.context.output.a, 'A-result', label);
    assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b'], label);
    assert.deepEqual(execution.actionAttempts.map(a => [a.nodeId, a.ok]),
      [['a', true], ['b', false]], label);
  }
});

test('a failed unreadable compensation does not stop compensation of earlier actions', async () => {
  const workflow = {
    id: 'comp-chain',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB',
        compensation: { operation: 'undoB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
  const order = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: () => { throw new Error('c-boom'); },
    undoB: () => { order.push('undoB'); throw revokedProxy(); },
    undoA: () => { order.push('undoA'); return 'undone-a'; },
  });
  assert.deepEqual(order, ['undoB', 'undoA']); // reverse success order, earlier action still handled
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(a => [a.nodeId, a.ok, a.error, a.result]), [
    ['b', false, PLACEHOLDER, null],
    ['a', true, null, 'undone-a'],
  ]);
  // Successful outputs are never deleted by compensation.
  assert.deepEqual({ a: execution.context.output.a, b: execution.context.output.b }, { a: 'A', b: 'B' });
});
