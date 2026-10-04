import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// trigger -> a (business, compensable) -> b (business under test) -> end
function workflow(bProps = {}, { aCompensation = { operation: 'undoA' }, bCompensation = undefined } = {}) {
  return {
    id: 'shared-memory',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        ...(aCompensation ? { compensation: aCompensation } : {}),
        next: 'b',
      },
      {
        id: 'b', type: 'action', operation: 'opB',
        ...(bProps ? { ...bProps } : {}),
        ...(bCompensation ? { compensation: bCompensation } : {}),
        next: 'after',
      },
      { id: 'after', type: 'action', message: 'never', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

const ZERO_DELAY_RETRY = { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };

function assertSharedMemoryError(text) {
  assert.match(text, /shared memory/);
  assert.match(text, /SharedArrayBuffer/);
  assert.match(text, /independent copies cannot be guaranteed/);
}

// ---------------------------------------------------------------------------
// Shared memory directly or through byte views
// ---------------------------------------------------------------------------

test('a directly returned SharedArrayBuffer fails the business attempt synchronously', async () => {
  const execution = await executeWorkflowAsync(workflow(), {}, {
    opA: () => 'A',
    opB: () => new SharedArrayBuffer(8),
    undoA: () => 'undone',
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'b');
  assert.equal(execution.attempts, 1);
  assertSharedMemoryError(execution.error);
  assert.equal(Object.hasOwn(execution.context.output, 'b'), false);
  assert.equal(Object.hasOwn(execution.context.output, 'after'), false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'a', 'b']);
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, true], ['b', 1, false],
  ]);
  assertSharedMemoryError(execution.actionAttempts[1].error);
  assert.equal(execution.actionAttempts[1].nextDelayMs, 0);
});

test('a Promise resolving to shared memory is rejected exactly like a synchronous return', async () => {
  const execution = await executeWorkflowAsync(workflow(), {}, {
    opA: () => 'A',
    opB: async () => {
      await sleep(2);
      return new Uint8Array(new SharedArrayBuffer(4));
    },
    undoA: () => 'undone',
  });
  assert.equal(execution.status, 'action_failed');
  assertSharedMemoryError(execution.error);
  assert.equal(Object.hasOwn(execution.context.output, 'b'), false);
});

test('every typed-array kind and DataView backed by shared memory fails', async () => {
  const sharedBacked = [
    () => new Int8Array(new SharedArrayBuffer(4)),
    () => new Uint8ClampedArray(new SharedArrayBuffer(4)),
    () => new Int16Array(new SharedArrayBuffer(4)),
    () => new Uint16Array(new SharedArrayBuffer(4)),
    () => new Int32Array(new SharedArrayBuffer(8)),
    () => new Uint32Array(new SharedArrayBuffer(8)),
    () => new Float32Array(new SharedArrayBuffer(8)),
    () => new Float64Array(new SharedArrayBuffer(8)),
    () => new BigInt64Array(new SharedArrayBuffer(8)),
    () => new BigUint64Array(new SharedArrayBuffer(8)),
    () => new DataView(new SharedArrayBuffer(4)),
    () => new Uint8Array(new SharedArrayBuffer(8), 2, 3),
  ];
  for (const impl of sharedBacked) {
    const execution = await executeWorkflowAsync(workflow(), {}, {
      opA: () => 'A',
      opB: impl,
      undoA: () => 'undone',
    });
    assert.equal(execution.status, 'action_failed', `expected failure for ${impl.toString()}`);
    assertSharedMemoryError(execution.error);
    assert.equal(Object.hasOwn(execution.context.output, 'b'), false);
  }
});

// ---------------------------------------------------------------------------
// Shared memory nested anywhere in the saved graph
// ---------------------------------------------------------------------------

test('shared memory nested in objects, arrays, Map keys/values and Set members all fail', async () => {
  const cases = [
    () => ({ inner: { bytes: new SharedArrayBuffer(4) } }),
    () => ({ list: [1, [2, new Uint8Array(new SharedArrayBuffer(4))]] }),
    () => new Map([['k', new SharedArrayBuffer(4)]]),
    () => new Map([[new SharedArrayBuffer(4), 'k']]),
    () => new Map([['k', { view: new DataView(new SharedArrayBuffer(4)) }]]),
    () => new Set([new SharedArrayBuffer(4)]),
    () => new Set([{ bytes: new Uint8Array(new SharedArrayBuffer(4)) }]),
    () => ({ table: new Map([[new Set([new SharedArrayBuffer(4)]), new DataView(new SharedArrayBuffer(4))]]) }),
  ];
  for (const impl of cases) {
    const execution = await executeWorkflowAsync(workflow(), {}, {
      opA: () => 'A',
      opB: impl,
      undoA: () => 'undone',
    });
    assert.equal(execution.status, 'action_failed', `expected failure for case ${cases.indexOf(impl)}`);
    assertSharedMemoryError(execution.error);
  }
});

test('shared memory carried through an Error cause (also deeply nested) fails', async () => {
  const execution = await executeWorkflowAsync(workflow(), {}, {
    opA: () => 'A',
    opB: () => new Error('wrap', {
      cause: { deep: new Map([['k', new Set([new Uint8Array(new SharedArrayBuffer(2))])]]) },
    }),
    undoA: () => 'undone',
  });
  assert.equal(execution.status, 'action_failed');
  assertSharedMemoryError(execution.error);
});

test('cyclic and repeated references containing shared memory are still detected', async () => {
  const cyclic = () => {
    const value = { label: 'self' };
    value.myself = value;
    value.shared = new SharedArrayBuffer(2);
    return value;
  };
  const aliased = () => {
    const shared = new SharedArrayBuffer(2);
    const holder = { buffer: shared };
    return { a: holder, b: holder, list: [shared] };
  };
  for (const impl of [cyclic, aliased]) {
    const execution = await executeWorkflowAsync(workflow(), {}, {
      opA: () => 'A',
      opB: impl,
      undoA: () => 'undone',
    });
    assert.equal(execution.status, 'action_failed');
    assertSharedMemoryError(execution.error);
  }
});

// ---------------------------------------------------------------------------
// Retry behavior: records, delays, recovery, exhaustion
// ---------------------------------------------------------------------------

test('a shared-memory return follows the node retry config and leaves a record per failed attempt', async () => {
  const workflowDelayed = workflow({
    retry: { attempts: 3, initialDelayMs: 20, backoffFactor: 2, maxDelayMs: 50 },
  });
  const execution = await executeWorkflowAsync(workflowDelayed, {}, {
    opA: () => 'A',
    opB: () => new SharedArrayBuffer(4),
    undoA: () => 'undone',
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.attempts, 3);
  assert.deepEqual(
    execution.actionAttempts.filter(r => r.nodeId === 'b')
      .map(r => [r.attempt, r.ok, r.nextDelayMs]),
    [[1, false, 20], [2, false, 40], [3, false, 0]],
  );
  for (const record of execution.actionAttempts.filter(r => r.nodeId === 'b')) {
    assertSharedMemoryError(record.error);
  }
});

test('a later attempt returning an ordinary cloneable value succeeds and only that return is saved', async () => {
  const heldShared = new Uint8Array(new SharedArrayBuffer(4));
  const execution = await executeWorkflowAsync(workflow({ retry: ZERO_DELAY_RETRY }), { amount: 3 }, {
    opA: () => 'A',
    opB: (input, output, nodeId, attempt) => {
      // Failed attempts still get the fresh argument copies; mutating them
      // must not reach the successful attempt.
      if (attempt === 1) {
        input.amount = 999;
        output.prep = 'tampered';
        return heldShared;
      }
      assert.deepEqual(input, { amount: 3 });
      assert.equal(output.prep, 'prepared');
      return { ok: true, seen: 'success-attempt' };
    },
    undoA: () => 'undone',
  });
  assert.equal(execution.status, 'completed');
  const bRecords = execution.actionAttempts.filter(r => r.nodeId === 'b');
  assert.equal(bRecords[0].ok, false);
  assertSharedMemoryError(bRecords[0].error);
  assert.equal(bRecords[1].ok, true);
  assert.equal(bRecords[1].error, null);
  assert.deepEqual(execution.context.output.b, { ok: true, seen: 'success-attempt' });
  assert.equal(execution.context.output.prep, 'prepared');
  assert.deepEqual(execution.context.input, { amount: 3 });
  // Mutating the rejected shared object after the run changes nothing saved.
  heldShared[0] = 123;
  assert.deepEqual(execution.context.output.b, { ok: true, seen: 'success-attempt' });
});

test('exhausted retries preserve prior input and successful outputs, leave no node output and run no successor', async () => {
  const execution = await executeWorkflowAsync(
    workflow({ retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }),
    { request: 7 },
    {
      opA: () => ({ charged: true }),
      opB: () => new DataView(new SharedArrayBuffer(4)),
      undoA: () => 'refunded',
    },
  );
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'b');
  assert.equal(execution.attempts, 2);
  assertSharedMemoryError(execution.error);
  assert.deepEqual(execution.context.input, { request: 7 });
  assert.deepEqual(execution.context.output.a, { charged: true });
  assert.equal(execution.context.output.prep, 'prepared');
  assert.equal(Object.hasOwn(execution.context.output, 'b'), false);
  assert.equal(Object.hasOwn(execution.context.output, 'after'), false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'a', 'b']);
  // The earlier successful, compensable action is compensated as usual.
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.ok, r.result]), [
    ['a', true, 'refunded'],
  ]);
});

// ---------------------------------------------------------------------------
// Plain ArrayBuffers and legal values keep working
// ---------------------------------------------------------------------------

test('a plain ArrayBuffer and views over it are accepted and saved independently', async () => {
  const buffer = new ArrayBuffer(4);
  new Uint8Array(buffer).set([9, 8, 7, 6]);
  const heldView = new Uint16Array(buffer);
  const heldDataView = new DataView(new ArrayBuffer(2));
  new Uint8Array(heldDataView.buffer).set([5, 6]);

  const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
    opA: () => 'A',
    opB: () => ({ buffer, view: heldView, dv: heldDataView }),
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.b;
  assert.ok(saved.buffer instanceof ArrayBuffer);
  assert.ok(!(saved.buffer instanceof SharedArrayBuffer));
  assert.ok(saved.view.buffer instanceof ArrayBuffer);
  assert.ok(saved.dv instanceof DataView);
  // The saved storage is disjoint from the implementation-held storage.
  assert.notEqual(saved.buffer, buffer);
  assert.notEqual(saved.view.buffer, buffer);
  assert.deepEqual([...new Uint8Array(saved.buffer)], [9, 8, 7, 6]);
  new Uint8Array(buffer)[0] = 99;
  new Uint8Array(heldDataView.buffer)[0] = 77;
  assert.deepEqual([...new Uint8Array(saved.buffer)], [9, 8, 7, 6]);
  assert.deepEqual([...new Uint8Array(saved.dv.buffer)], [5, 6]);
});

test('legal Date/Map/Set/object/array/primitive values with circular or repeated references keep their relationships', async () => {
  const detail = { id: 'detail' };
  const bytes = new Uint8Array([1, 2, 3]);
  const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
    opA: () => 'A',
    opB: () => {
      const root = {
        when: new Date('2021-06-07T08:09:10.000Z'),
        table: new Map([['row', detail]]),
        bag: new Set([detail]),
        detailA: detail,
        detailB: detail,
        bytes,
      };
      root.self = root;
      root.list = [bytes];
      return root;
    },
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.b;
  assert.equal(saved.self, saved);
  assert.equal(saved.detailA, saved.detailB);
  assert.equal(saved.table.get('row'), saved.detailA);
  assert.equal([...saved.bag][0], saved.detailA);
  assert.equal(saved.list[0], saved.bytes);
  assert.ok(saved.bytes instanceof Uint8Array);
  assert.ok(!(saved.bytes.buffer instanceof SharedArrayBuffer));
  assert.ok(saved.when instanceof Date);
  assert.deepEqual([...saved.bytes], [1, 2, 3]);
  // Alias survives as a real relationship.
  saved.detailA.id = 'edited';
  assert.equal(saved.table.get('row').id, 'edited');
});

test('shared bytes placed only where structured cloning drops them are not treated as saved content', async () => {
  // A custom own property on a typed array / plain ArrayBuffer, a
  // symbol-keyed property and a non-enumerable property are all discarded by
  // structured cloning — the saved value therefore contains no shared
  // memory, so the return is accepted.
  const symbolKey = Symbol('hidden');
  const view = new Uint8Array([4, 3, 2, 1]);
  view.dropped = new SharedArrayBuffer(2);
  const buffer = new ArrayBuffer(2);
  buffer.dropped = new SharedArrayBuffer(2);
  const plain = {};
  Object.defineProperty(plain, 'nonEnumerable', { value: new SharedArrayBuffer(2), enumerable: false });
  plain[symbolKey] = new SharedArrayBuffer(2);
  plain.kept = new Uint8Array([7]);

  const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
    opA: () => 'A',
    opB: () => ({ view, buffer, plain }),
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.b;
  assert.deepEqual([...saved.view], [4, 3, 2, 1]);
  assert.equal(saved.view.dropped, undefined);
  assert.equal(saved.buffer.dropped, undefined);
  assert.equal(Object.hasOwn(saved.plain, 'nonEnumerable'), false);
  assert.equal(Object.getOwnPropertySymbols(saved.plain).length, 0);
  assert.deepEqual([...saved.plain.kept], [7]);
});

// ---------------------------------------------------------------------------
// Compensation returns containing shared memory
// ---------------------------------------------------------------------------

function compensationFailureWorkflow() {
  // a succeeds (undoA), b succeeds (undoB returns shared memory), c throws.
  return {
    id: 'comp-shared',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      {
        id: 'b', type: 'action', operation: 'opB',
        compensation: { operation: 'undoB', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
        next: 'c',
      },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

test('a compensation returning shared memory retries on its own config, saves no result and still lets earlier compensations run', async () => {
  const calls = [];
  const execution = await executeWorkflowAsync(compensationFailureWorkflow(), {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: () => { throw new Error('c-boom'); },
    undoA: () => { calls.push('undoA'); return 'ua'; },
    undoB: () => { calls.push('undoB'); return new SharedArrayBuffer(4); },
  });
  // The original terminal state and failure reason survive unchanged.
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.error, 'c-boom');
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(calls, ['undoB', 'undoB', 'undoA']);
  assert.deepEqual(
    execution.compensationAttempts.map(r => [r.nodeId, r.attempt, r.ok, r.result, r.nextDelayMs]),
    [
      ['b', 1, false, null, 0],
      ['b', 2, false, null, 0],
      ['a', 1, true, 'ua', 0],
    ],
  );
  assertSharedMemoryError(execution.compensationAttempts[0].error);
  assertSharedMemoryError(execution.compensationAttempts[1].error);
  // Successful outputs survive the failed compensation.
  assert.deepEqual(execution.context.output.a, 'A');
  assert.deepEqual(execution.context.output.b, 'B');
});

test('a compensation whose retry returns an ordinary value succeeds and records only that value', async () => {
  const execution = await executeWorkflowAsync(compensationFailureWorkflow(), {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: () => { throw new Error('c-boom'); },
    undoA: () => 'ua',
    undoB: (input, output, result, nodeId, attempt) =>
      (attempt === 1 ? new Uint8Array(new SharedArrayBuffer(4)) : { refunded: true }),
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.error, 'c-boom');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(
    execution.compensationAttempts.map(r => [r.nodeId, r.attempt, r.ok, r.result]),
    [
      ['b', 1, false, null],
      ['b', 2, true, { refunded: true }],
      ['a', 1, true, 'ua'],
    ],
  );
});

test('a compensation Promise resolving to shared memory fails through the same path', async () => {
  const execution = await executeWorkflowAsync(compensationFailureWorkflow(), {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: () => { throw new Error('c-boom'); },
    undoA: () => 'ua',
    undoB: async () => {
      await sleep(2);
      return new Map([['k', new Set([new SharedArrayBuffer(2)])]]);
    },
  });
  assert.equal(execution.compensationStatus, 'failed');
  assert.equal(execution.compensationAttempts[0].ok, false);
  assertSharedMemoryError(execution.compensationAttempts[0].error);
  assert.equal(execution.compensationAttempts[0].result, null);
});

test('a shared-memory business failure still compensates earlier successful actions', async () => {
  let undone = 0;
  const execution = await executeWorkflowAsync(workflow({ retry: ZERO_DELAY_RETRY }), {}, {
    opA: () => 'A',
    opB: () => new SharedArrayBuffer(4),
    undoA: () => { undone += 1; return 'ua'; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(undone, 1);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.ok]), [['a', true]]);
});

// ---------------------------------------------------------------------------
// Robustness: cross-realm buffers, spoofed tags, hostile values, cancellation
// ---------------------------------------------------------------------------

test('shared buffers and views from another realm are still rejected', async () => {
  const vm = await import('node:vm');
  const realm = vm.createContext({});
  const remote = code => vm.runInContext(code, realm);
  const cases = [
    () => remote('new SharedArrayBuffer(4)'),
    () => remote('new Uint8Array(new SharedArrayBuffer(4))'),
    () => remote('new DataView(new SharedArrayBuffer(4))'),
    () => ({ bytes: remote('new Uint8Array(new SharedArrayBuffer(4))') }),
    () => new Map([['k', remote('new SharedArrayBuffer(4)')]]),
  ];
  for (const impl of cases) {
    const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
      opA: () => 'A',
      opB: impl,
    });
    assert.equal(execution.status, 'action_failed');
    assertSharedMemoryError(execution.error);
  }
  // A cross-realm plain ArrayBuffer view is accepted.
  const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
    opA: () => 'A',
    opB: () => ({ bytes: remote('new Uint8Array([1, 2, 3])') }),
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual([...execution.context.output.b.bytes], [1, 2, 3]);
});

test('objects merely faking SharedArrayBuffer/Map/Error tags stay accepted; nested real shared bytes are still caught', async () => {
  const accepted = [
    () => ({ [Symbol.toStringTag]: 'SharedArrayBuffer', x: 1 }),
    () => ({ [Symbol.toStringTag]: 'Map', entries: [1, 2] }),
    () => {
      const value = { [Symbol.toStringTag]: 'Error', note: 'fake' };
      value.self = value;
      return value;
    },
  ];
  for (const impl of accepted) {
    const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
      opA: () => 'A',
      opB: impl,
    });
    assert.equal(execution.status, 'completed', 'faked-tag plain object should be accepted');
  }

  const rejected = [
    // Own enumerable nesting inside the faked container.
    () => ({ [Symbol.toStringTag]: 'Map', x: new SharedArrayBuffer(2) }),
    // A Map subclass whose toStringTag differs; structured clone reads entries.
    () => {
      const Fake = class extends Map { get [Symbol.toStringTag]() { return 'NotMap'; } };
      return new Fake([['k', new SharedArrayBuffer(2)]]);
    },
    // An Error subclass with a custom tag and shared bytes in cause.
    () => {
      const Fake = class extends Error { get [Symbol.toStringTag]() { return 'MyError'; } };
      return new Fake('boom', { cause: new SharedArrayBuffer(2) });
    },
  ];
  for (const impl of rejected) {
    const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
      opA: () => 'A',
      opB: impl,
    });
    assert.equal(execution.status, 'action_failed', 'real shared memory in faked/subclass container must fail');
    assertSharedMemoryError(execution.error);
  }
});

test('hostile return values (throwing getters/proxies) fail the attempt without crashing the engine', async () => {
  const hostileList = [
    { get x() { throw new Error('getter-go-boom'); } },
    new Proxy({}, { get() { throw new Error('trap-go-boom'); } }),
    (() => { const handle = Proxy.revocable({ keep: 1 }, {}); handle.revoke(); return handle.proxy; })(),
  ];
  // The throwing getter surfaces as the standard uncloneable-return message;
  // the proxy traps propagate their own text through structuredClone.
  const expectedErrors = [/structured-cloned/, /trap-go-boom/, /proxy that has been revoked/];
  for (const [index, bad] of hostileList.entries()) {
    const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
      opA: () => 'A',
      opB: () => bad,
    });
    // The run returns a normal failure result rather than throwing out.
    assert.equal(execution.status, 'action_failed');
    assert.equal(typeof execution.error, 'string');
    assert.match(execution.error, expectedErrors[index]);
    assert.equal(Object.hasOwn(execution.context.output, 'b'), false);
  }
});

test('a shared-memory in-flight failure with the signal already fired ends cancelled, keeping the failure record', async () => {
  const controller = new AbortController();
  const execution = await executeWorkflowAsync(workflow({
    retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  }, { aCompensation: null }), {}, {
    opA: () => 'A',
    opB: async () => {
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      return new SharedArrayBuffer(4);
    },
  }, { signal: controller.signal });
  assert.equal(execution.status, 'cancelled');
  assert.equal(Object.hasOwn(execution.context.output, 'b'), false);
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok, r.nextDelayMs]), [
    ['a', 1, true, 0],
    ['b', 1, false, 0],
  ]);
  assertSharedMemoryError(execution.actionAttempts[1].error);
});

test('a shadowed own "buffer" property cannot hide a shared backing store', async () => {
  const sharedView = new Uint8Array(new SharedArrayBuffer(8));
  Object.defineProperty(sharedView, 'buffer', {
    value: new ArrayBuffer(8), configurable: true, enumerable: true,
  });
  const sharedDataView = new DataView(new SharedArrayBuffer(4));
  Object.defineProperty(sharedDataView, 'buffer', {
    value: new ArrayBuffer(4), configurable: true, enumerable: true,
  });
  for (const impl of [() => sharedView, () => sharedDataView, () => ({ nested: [new Map([['k', sharedView]])] })]) {
    const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
      opA: () => 'A',
      opB: impl,
    });
    assert.equal(execution.status, 'action_failed');
    assertSharedMemoryError(execution.error);
  }

  // The reverse spoof — a plain-backed view claiming a shared buffer — is a
  // legal value and completes.
  const plainView = new Uint8Array(new ArrayBuffer(4));
  Object.defineProperty(plainView, 'buffer', {
    value: new SharedArrayBuffer(4), configurable: true, enumerable: true,
  });
  const execution = await executeWorkflowAsync(workflow(null, { aCompensation: null }), {}, {
    opA: () => 'A',
    opB: () => plainView,
  });
  assert.equal(execution.status, 'completed');
  assert.ok(execution.context.output.b.buffer instanceof ArrayBuffer);
});
