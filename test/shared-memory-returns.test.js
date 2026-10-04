import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// trigger -> work(business op) -> done
function singleActionWorkflow(retry, compensation) {
  return {
    id: 'shared-memory',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      {
        id: 'work', type: 'action', operation: 'op',
        ...(retry ? { retry } : {}),
        ...(compensation ? { compensation } : {}),
        next: 'after',
      },
      { id: 'after', type: 'action', message: 'never-runs-on-failure', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

const ZERO_RETRY = { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };

async function runWithSharedReturn(returnValue, { workflow = singleActionWorkflow(), operations } = {}) {
  return executeWorkflowAsync(workflow, {}, operations ?? { op: () => returnValue });
}

test('a bare SharedArrayBuffer return fails the attempt with an isolation error', async () => {
  const execution = await runWithSharedReturn(new SharedArrayBuffer(8));
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.equal(execution.attempts, 1);
  assert.match(execution.error, /shared memory/);
  assert.match(execution.error, /isolation/);
  assert.equal(Object.hasOwn(execution.context.output, 'work'), false);
  assert.equal(Object.hasOwn(execution.context.output, 'after'), false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'work']);
  assert.equal(execution.actionAttempts.length, 1);
  assert.equal(execution.actionAttempts[0].ok, false);
  assert.equal(execution.actionAttempts[0].error, execution.error);
});

test('every typed-array kind and DataView over a SharedArrayBuffer fails', async () => {
  const sab = new SharedArrayBuffer(16);
  const views = [
    new Int8Array(sab),
    new Uint8Array(sab),
    new Uint8ClampedArray(sab),
    new Int16Array(sab),
    new Uint16Array(sab),
    new Int32Array(sab),
    new Uint32Array(sab),
    new Float32Array(sab),
    new Float64Array(sab),
    new BigInt64Array(sab),
    new BigUint64Array(sab),
    new DataView(sab),
  ];
  for (const view of views) {
    const execution = await runWithSharedReturn(view);
    assert.equal(execution.status, 'action_failed', `${view.constructor.name} must be rejected`);
    assert.match(execution.error, /shared memory/);
  }
});

test('shared memory nested in objects, arrays, Map keys/values and Set members fails consistently', async () => {
  const sab = new SharedArrayBuffer(8);
  const sharedBytes = new Uint8Array(sab);
  const badValues = [
    { bytes: sharedBytes },
    [sharedBytes],
    { deep: { table: new Map([['k', sharedBytes]]) } },
    { keyed: new Map([[sharedBytes, 'v']]) },
    { members: new Set([sharedBytes]) },
    { members: new Set([sab]) },
    { mixed: [new Map([['x', new Set([new DataView(sab)])]])] },
  ];
  for (const badValue of badValues) {
    const execution = await runWithSharedReturn(badValue);
    assert.equal(execution.status, 'action_failed');
    assert.match(execution.error, /shared memory/);
    assert.equal(Object.hasOwn(execution.context.output, 'work'), false);
  }
});

test('a Promise resolving to shared memory is rejected exactly like a synchronous return', async () => {
  const execution = await executeWorkflowAsync(singleActionWorkflow(), {}, {
    op: async () => {
      await sleep(1);
      return { bytes: new Uint8Array(new SharedArrayBuffer(4)) };
    },
  });
  assert.equal(execution.status, 'action_failed');
  assert.match(execution.error, /shared memory/);
  assert.equal(execution.actionAttempts[0].attempt, 1);
  assert.equal(execution.actionAttempts[0].ok, false);
});

test('each shared-memory attempt leaves a record and follows the configured retry and delay rules', async () => {
  const workflow = singleActionWorkflow({
    attempts: 3, initialDelayMs: 10, backoffFactor: 2, maxDelayMs: 15,
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    op: () => new Uint8Array(new SharedArrayBuffer(4)),
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.attempts, 3);
  assert.deepEqual(execution.actionAttempts.map(a => [a.attempt, a.ok, a.nextDelayMs]), [
    [1, false, 10],
    [2, false, 15],
    [3, false, 0],
  ]);
  for (const record of execution.actionAttempts) {
    assert.match(record.error, /shared memory/);
  }
  // Exhaustion leaves no output for this node and no successor execution.
  assert.deepEqual(Object.keys(execution.context.output), []);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'work']);
});

test('a later attempt returning a normal cloneable value succeeds and only that return is saved', async () => {
  const workflow = singleActionWorkflow(ZERO_RETRY);
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  const execution = await executeWorkflowAsync(workflow, {}, {
    op: (input, output, nodeId, attempt) => (attempt === 1 ? { bytes: shared } : { ok: true, when: new Date(0) }),
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.actionAttempts.map(a => [a.attempt, a.ok]), [[1, false], [2, true]]);
  assert.match(execution.actionAttempts[0].error, /shared memory/);
  // The output comes solely from the successful second return.
  assert.deepEqual(execution.context.output.work, { ok: true, when: new Date(0) });
  assert.equal(Object.hasOwn(execution.context.output.work, 'bytes'), false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'work', 'after', 'done']);
});

test('plain ArrayBuffers and their views are still accepted, including inside containers', async () => {
  const buffer = new ArrayBuffer(8);
  const execution = await runWithSharedReturn({
    buffer,
    bytes: new Uint8Array(buffer),
    view: new DataView(new ArrayBuffer(4)),
    loose: new Uint8Array([1, 2, 3]),
    table: new Map([['view', new Int16Array(new ArrayBuffer(4))]]),
    bag: new Set([new Float64Array(new ArrayBuffer(8))]),
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.work;
  assert.ok(saved.buffer instanceof ArrayBuffer);
  assert.ok(saved.bytes instanceof Uint8Array);
  assert.equal(saved.bytes.buffer, saved.buffer);
  assert.ok(saved.view instanceof DataView);
  assert.ok(saved.loose instanceof Uint8Array);
  assert.deepEqual([...saved.loose], [1, 2, 3]);
  assert.ok(saved.table.get('view') instanceof Int16Array);
  assert.ok([...saved.bag][0] instanceof Float64Array);
});

test('cycles, repeated references, Date, Map and Set keep their existing behavior alongside byte arrays', async () => {
  const detail = { id: 'd' };
  const root = {
    when: new Date('2019-03-03T00:00:00.000Z'),
    bytes: new Uint8Array([5, 6]),
    a: detail,
    b: detail,
    table: new Map([['d', detail]]),
    members: new Set([detail]),
  };
  root.self = root;
  const execution = await runWithSharedReturn(root);
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.work;
  assert.equal(saved.self, saved);
  assert.equal(saved.a, saved.b);
  assert.equal(saved.table.get('d'), saved.a);
  assert.equal(saved.members.has(saved.a), true);
  assert.ok(saved.when instanceof Date);
  assert.ok(saved.bytes instanceof Uint8Array);
  assert.deepEqual([...saved.bytes], [5, 6]);
});

// trigger -> a(ok, compensable) -> b(ok, compensable) -> c(fails) -> done
function compensationChain(compA, compB) {
  return {
    id: 'comp-chain',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: compA, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: compB, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

const noWait = { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };
const failC = () => { throw new Error('c-boom'); };

test('a compensation returning shared memory fails on its own retry config and never saves the return', async () => {
  const workflow = compensationChain(
    { operation: 'undoA', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
    undefined,
  );
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: failC,
    undoA: () => new Uint8Array(new SharedArrayBuffer(4)),
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.error, 'c-boom');
  assert.equal(execution.compensationStatus, 'failed');
  assert.equal(execution.compensationAttempts.length, 2);
  assert.deepEqual(execution.compensationAttempts.map(r => [r.attempt, r.ok, r.result, r.nextDelayMs]), [
    [1, false, null, 0],
    [2, false, null, 0],
  ]);
  assert.match(execution.compensationAttempts[0].error, /shared memory/);
  // Successful outputs and the original failure details are preserved.
  assert.equal(execution.context.output.a, 'A');
  assert.equal(execution.context.output.b, 'B');
});

test('a failed shared-memory compensation still lets earlier successful actions compensate', async () => {
  const workflow = compensationChain(
    { operation: 'undoA', retry: noWait },
    { operation: 'undoB', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
  );
  const calls = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: failC,
    undoA: () => { calls.push('undoA'); return 'undone-a'; },
    undoB: () => { calls.push('undoB'); return new SharedArrayBuffer(4); },
  });
  // b is undone first and exhausts its two attempts; a is still compensated.
  assert.deepEqual(calls, ['undoB', 'undoB', 'undoA']);
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['b', 1, false],
    ['b', 2, false],
    ['a', 1, true],
  ]);
  // The shared-memory return is never recorded as a result; a's normal one is.
  assert.equal(execution.compensationAttempts[0].result, null);
  assert.equal(execution.compensationAttempts[2].result, 'undone-a');
});

test('a compensation that returns shared memory then a normal value succeeds on retry and records the normal result', async () => {
  const workflow = compensationChain(
    { operation: 'undoA', retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
    undefined,
  );
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: failC,
    undoA: (input, output, result, nodeId, attempt) =>
      (attempt < 3 ? new DataView(new SharedArrayBuffer(4)) : { refunded: true }),
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.attempt, r.ok, r.result]), [
    [1, false, null],
    [2, false, null],
    [3, true, { refunded: true }],
  ]);
});

test('a compensation Promise resolving to shared memory fails just like a synchronous return', async () => {
  const workflow = compensationChain({ operation: 'undoA', retry: noWait }, undefined);
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: failC,
    undoA: async () => {
      await sleep(1);
      return new SharedArrayBuffer(4);
    },
  });
  assert.equal(execution.compensationStatus, 'failed');
  assert.equal(execution.compensationAttempts.length, 1);
  assert.match(execution.compensationAttempts[0].error, /shared memory/);
  assert.equal(execution.compensationAttempts[0].result, null);
});

test('a shared-memory return observed while already cancelled keeps the failure record and ends cancelled', async () => {
  const controller = new AbortController();
  const workflow = singleActionWorkflow(ZERO_RETRY);
  const execution = await executeWorkflowAsync(workflow, {}, {
    op: async () => {
      controller.abort();
      await sleep(1);
      return new Uint8Array(new SharedArrayBuffer(4));
    },
  }, { signal: controller.signal });
  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.actionAttempts.length, 1);
  assert.equal(execution.actionAttempts[0].ok, false);
  assert.match(execution.actionAttempts[0].error, /shared memory/);
  assert.equal(Object.hasOwn(execution.context.output, 'work'), false);
});
