import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// trigger -> a (business, compensable) -> done; used through the async entry
function businessWorkflow(actionProps = {}) {
  return {
    id: 'shared-input',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA' },
        ...actionProps,
        next: 'done',
      },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

// trigger -> done; usable through the synchronous entry
function legacyWorkflow() {
  return {
    id: 'legacy-input',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

const ZERO_DELAY_RETRY = { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };

function assertInputSharedMemoryError(error) {
  assert.ok(error instanceof TypeError, 'the rejection must be a TypeError');
  assert.match(error.message, /run input contains shared memory/);
  assert.match(error.message, /SharedArrayBuffer/);
  assert.match(error.message, /independent copies cannot be guaranteed/);
}

function expectSyncReject(input) {
  try {
    executeWorkflow(legacyWorkflow(), input);
    assert.fail('executeWorkflow was expected to throw');
  } catch (error) {
    assertInputSharedMemoryError(error);
  }
}

// The containers below each carry shared memory in content the input clone
// actually retains.
function sharedInputs() {
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
  const causeIsNonEnumerable = () => {
    const error = new Error('wrap', { cause: new Uint8Array(new SharedArrayBuffer(2)) });
    // The Error constructor installs "cause" as a non-enumerable own property;
    // it must still count because the clone retains it.
    assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
    return error;
  };
  return [
    () => new SharedArrayBuffer(4),
    () => new Uint8Array(new SharedArrayBuffer(4)),
    () => new Int32Array(new SharedArrayBuffer(8)),
    () => new Float64Array(new SharedArrayBuffer(8)),
    () => new BigInt64Array(new SharedArrayBuffer(8)),
    () => new DataView(new SharedArrayBuffer(4)),
    () => new Uint8Array(new SharedArrayBuffer(8), 2, 3),
    () => ({ inner: { bytes: new SharedArrayBuffer(4) } }),
    () => ({ list: [1, [2, new Uint8Array(new SharedArrayBuffer(4))]] }),
    () => new Map([['k', new SharedArrayBuffer(4)]]),
    () => new Map([[new SharedArrayBuffer(4), 'k']]),
    () => new Map([['k', { view: new DataView(new SharedArrayBuffer(4)) }]]),
    () => new Set([new SharedArrayBuffer(4)]),
    () => new Set([{ bytes: new Uint8Array(new SharedArrayBuffer(4)) }]),
    () => ({ table: new Map([[new Set([new SharedArrayBuffer(4)]), new DataView(new SharedArrayBuffer(4))]]) }),
    causeIsNonEnumerable,
    cyclic,
    aliased,
  ];
}

// ---------------------------------------------------------------------------
// The synchronous entry throws a TypeError; the asynchronous one rejects
// ---------------------------------------------------------------------------

test('the synchronous entry throws a TypeError for shared-memory input before any node runs', () => {
  for (const make of sharedInputs()) {
    expectSyncReject(make());
  }
});

test('the asynchronous entry rejects with the same TypeError and makes no business or compensation call', async () => {
  let businessCalls = 0;
  let compensationCalls = 0;
  const operations = {
    opA: () => { businessCalls += 1; return 'A'; },
    undoA: () => { compensationCalls += 1; return 'undone'; },
  };
  for (const make of sharedInputs()) {
    await assert.rejects(
      () => executeWorkflowAsync(businessWorkflow(), make(), operations),
      error => {
        assertInputSharedMemoryError(error);
        return true;
      },
    );
  }
  assert.equal(businessCalls, 0);
  assert.equal(compensationCalls, 0);
});

test('an already-aborted signal does not turn the failure into a cancelled run: input rejection still wins', async () => {
  const controller = new AbortController();
  controller.abort();
  let businessCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(
      businessWorkflow(),
      { bytes: new Uint8Array(new SharedArrayBuffer(4)) },
      { opA: () => { businessCalls += 1; return 'A'; }, undoA: () => 'u' },
      { signal: controller.signal },
    ),
    error => {
      assertInputSharedMemoryError(error);
      return true;
    },
  );
  assert.equal(businessCalls, 0);
});

// ---------------------------------------------------------------------------
// Existing check ordering is preserved; the input check comes last
// ---------------------------------------------------------------------------

test('definition, operation-registration and option errors are still reported before the input check', async () => {
  const sharedInput = { bytes: new SharedArrayBuffer(4) };
  const controller = new AbortController();
  controller.abort();

  // An invalid definition wins over the shared input, on both entries — and
  // even when the signal was already aborted.
  const invalid = {
    id: 'bad', entry: 'start',
    nodes: [{ id: 'start', type: 'trigger', next: 'ghost' }],
  };
  assert.throws(
    () => executeWorkflow(invalid, sharedInput),
    /unknown destination/,
  );
  await assert.rejects(
    () => executeWorkflowAsync(invalid, sharedInput, {}, { signal: controller.signal }),
    /unknown destination/,
  );

  // A missing business operation implementation wins over the shared input.
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), sharedInput, {}),
    /action node a/,
  );

  // A malformed options object / signal wins over the shared input.
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), sharedInput, {
      opA: () => 'A', undoA: () => 'u',
    }, null),
    /options/,
  );
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), sharedInput, {
      opA: () => 'A', undoA: () => 'u',
    }, { signal: 'not-a-signal' }),
    /AbortSignal/,
  );
});

test('legal input under an already-aborted signal keeps the existing cancelled result', async () => {
  const controller = new AbortController();
  controller.abort();
  let businessCalls = 0;
  let compensationCalls = 0;
  const callerInput = { amount: 5 };
  const execution = await executeWorkflowAsync(businessWorkflow(), callerInput, {
    opA: () => { businessCalls += 1; return 'A'; },
    undoA: () => { compensationCalls += 1; return 'u'; },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.deepEqual(execution.trace, []);
  assert.deepEqual(execution.actionAttempts, []);
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
  assert.deepEqual(execution.context.input, { amount: 5 });
  assert.equal(businessCalls, 0);
  assert.equal(compensationCalls, 0);
  execution.context.input.amount = 999;
  assert.deepEqual(callerInput, { amount: 5 });
});

// ---------------------------------------------------------------------------
// Shared memory placed only where cloning drops it never condemns legal data
// ---------------------------------------------------------------------------

test('shared bytes in dropped properties (Date/RegExp/ArrayBuffer/Error auxiliaries, non-enumerable and symbol keys) are accepted', async () => {
  const symbolKey = Symbol('hidden');

  const date = new Date('2021-06-07T08:09:10.000Z');
  date.aux = new SharedArrayBuffer(8);

  const regexp = /pattern/gi;
  regexp.aux = new SharedArrayBuffer(8);

  const plainBuffer = new ArrayBuffer(2);
  plainBuffer.dropped = new SharedArrayBuffer(2);

  const errorWithAux = new Error('boom');
  errorWithAux.details = new SharedArrayBuffer(4);

  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'hidden', { value: new SharedArrayBuffer(4), enumerable: false });

  const list = ['a', 'b'];
  Object.defineProperty(list, 'aux', { value: new SharedArrayBuffer(4), enumerable: false });

  const symboled = {};
  symboled[symbolKey] = new SharedArrayBuffer(4);

  const input = {
    date, regexp, plainBuffer, errorWithAux, nonEnumerable, list, symboled,
    keep: new Uint8Array([7, 8]),
  };

  // The synchronous entry accepts it too (it rejects before any node, so a
  // trigger -> end run completes normally).
  const sync = executeWorkflow(legacyWorkflow(), input);
  assert.equal(sync.status, 'completed');

  let calls = 0;
  const execution = await executeWorkflowAsync(businessWorkflow(), input, {
    opA: received => {
      calls += 1;
      assert.ok(received.date instanceof Date);
      assert.equal(received.date.aux, undefined);
      assert.ok(received.regexp instanceof RegExp);
      assert.equal(received.regexp.aux, undefined);
      assert.equal(received.plainBuffer.dropped, undefined);
      assert.equal(received.errorWithAux.details, undefined);
      assert.equal(Object.hasOwn(received.nonEnumerable, 'hidden'), false);
      assert.equal(Object.hasOwn(received.list, 'aux'), false);
      assert.equal(Object.getOwnPropertySymbols(received.symboled).length, 0);
      assert.deepEqual([...received.keep], [7, 8]);
      return 'A';
    },
    undoA: () => 'u',
  });
  assert.equal(execution.status, 'completed');
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Enumerable getters are read once by the clone; that value is judged
// ---------------------------------------------------------------------------

test('an enumerable getter that answers ordinary first is judged on that single cloned value', async () => {
  let reads = 0;
  const input = {
    get flip() {
      reads += 1;
      return reads === 1 ? 'first' : new SharedArrayBuffer(4);
    },
  };
  const execution = await executeWorkflowAsync(businessWorkflow(), input, {
    opA: received => {
      assert.equal(received.flip, 'first');
      return 'A';
    },
    undoA: () => 'u',
  });
  assert.equal(execution.status, 'completed');
  assert.equal(reads, 1, 'the getter is read exactly once while receiving the input');
  assert.equal(execution.context.input.flip, 'first');
});

test('an enumerable getter that yields shared memory on its single read is rejected', async () => {
  let reads = 0;
  const input = {
    get flip() {
      reads += 1;
      return reads === 1 ? new SharedArrayBuffer(4) : 'ordinary';
    },
  };
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), input, {
      opA: () => 'A', undoA: () => 'u',
    }),
    error => {
      assertInputSharedMemoryError(error);
      return true;
    },
  );
  assert.equal(reads, 1);
});

// ---------------------------------------------------------------------------
// Custom Map/Set iterators cannot change the judgment of the real members
// ---------------------------------------------------------------------------

test('a custom iterator that hides real shared members does not save the input', async () => {
  const map = new Map([['real', new SharedArrayBuffer(2)]]);
  map[Symbol.iterator] = function* hidden() { yield ['fake', 1]; };
  const set = new Set([new SharedArrayBuffer(2)]);
  set[Symbol.iterator] = function* empty() {};

  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), { map }, {
      opA: () => 'A', undoA: () => 'u',
    }),
    error => {
      assertInputSharedMemoryError(error);
      return true;
    },
  );
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), { set }, {
      opA: () => 'A', undoA: () => 'u',
    }),
    error => {
      assertInputSharedMemoryError(error);
      return true;
    },
  );
});

test('a custom iterator that fabricates shared entries does not condemn ordinary members', async () => {
  const map = new Map([['real', 1]]);
  map[Symbol.iterator] = function* fake() { yield ['fabricated', new SharedArrayBuffer(2)]; };
  const set = new Set([1, 2]);
  set[Symbol.iterator] = function* fake() { yield new SharedArrayBuffer(2); };

  for (const input of [{ map }, { set }]) {
    const execution = await executeWorkflowAsync(businessWorkflow(), input, {
      opA: received => {
        assert.equal(received.map ? received.map.get('real') : [...received.set].join(','), received.map ? 1 : '1,2');
        return 'A';
      },
      undoA: () => 'u',
    });
    assert.equal(execution.status, 'completed');
  }
});

// ---------------------------------------------------------------------------
// Cross-realm shared buffers are rejected too
// ---------------------------------------------------------------------------

test('shared buffers and views produced in another realm are rejected', async () => {
  const vm = await import('node:vm');
  const realm = vm.createContext({});
  const remote = code => vm.runInContext(code, realm);
  const inputs = [
    () => remote('new SharedArrayBuffer(4)'),
    () => remote('new Uint8Array(new SharedArrayBuffer(4))'),
    () => remote('new DataView(new SharedArrayBuffer(4))'),
    () => ({ bytes: remote('new Uint8Array(new SharedArrayBuffer(4))') }),
    () => new Map([['k', remote('new SharedArrayBuffer(4)')]]),
  ];
  for (const make of inputs) {
    expectSyncReject(make());
    await assert.rejects(
      () => executeWorkflowAsync(businessWorkflow(), make(), {
        opA: () => 'A', undoA: () => 'u',
      }),
      error => {
        assertInputSharedMemoryError(error);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Legal inputs: plain ArrayBuffers are copied and stay isolated
// ---------------------------------------------------------------------------

test('a plain ArrayBuffer and its views are copied byte-for-byte with types, cycles and repeated references preserved', async () => {
  const callerBytes = new ArrayBuffer(4);
  new Uint8Array(callerBytes).set([9, 8, 7, 6]);
  const callerView = new Uint16Array(new ArrayBuffer(4));
  new Uint8Array(callerView.buffer).set([1, 2, 3, 4]);
  const detail = { id: 'detail' };

  const input = { bytes: callerBytes, view: callerView, detail, when: new Date('2020-02-03T04:05:06.000Z') };
  input.self = input;
  input.again = detail;
  input.list = [detail];

  const execution = await executeWorkflowAsync(businessWorkflow(), input, {
    opA: received => 'A',
    undoA: () => 'u',
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.input;
  assert.ok(saved.bytes instanceof ArrayBuffer);
  assert.ok(!(saved.bytes instanceof SharedArrayBuffer));
  assert.notEqual(saved.bytes, callerBytes);
  assert.ok(saved.view instanceof Uint16Array);
  assert.notEqual(saved.view.buffer, callerView.buffer);
  assert.deepEqual([...new Uint8Array(saved.bytes)], [9, 8, 7, 6]);
  assert.deepEqual([...new Uint8Array(saved.view.buffer)], [1, 2, 3, 4]);
  assert.ok(saved.when instanceof Date);
  assert.equal(saved.self, saved);
  assert.equal(saved.again, saved.detail);
  assert.equal(saved.list[0], saved.detail);

  // The reported context copy is disjoint from the caller's objects.
  new Uint8Array(callerBytes)[0] = 99;
  detail.id = 'edited';
  assert.deepEqual([...new Uint8Array(saved.bytes)], [9, 8, 7, 6]);
  assert.equal(saved.detail.id, 'detail');
});

test('mutations a business attempt makes to its input copy never reach the caller, the run context or a later attempt', async () => {
  const callerBytes = new ArrayBuffer(4);
  new Uint8Array(callerBytes).set([1, 1, 1, 1]);
  const callerInput = { amount: 10, nested: { v: 1 }, bytes: callerBytes };

  const execution = await executeWorkflowAsync(
    businessWorkflow({ retry: ZERO_DELAY_RETRY }),
    callerInput,
    {
      opA: (received, output, nodeId, attempt) => {
        assert.notEqual(received.bytes, callerBytes);
        if (attempt === 2) {
          // The second attempt gets a fresh copy of the original input: none
          // of the failed attempt's rewrites — bytes included — survive.
          assert.deepEqual(received.amount, 10);
          assert.deepEqual(received.nested.v, 1);
          assert.equal(received.added, undefined);
          assert.deepEqual([...new Uint8Array(received.bytes)], [1, 1, 1, 1]);
        }
        received.amount = 999;
        received.nested.v = 999;
        received.added = true;
        new Uint8Array(received.bytes).fill(7);
        if (attempt === 1) throw new Error('first attempt fails');
        return 'A';
      },
      undoA: () => 'u',
    },
  );
  assert.equal(execution.status, 'completed');
  assert.deepEqual(
    execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]),
    [['a', 1, false], ['a', 2, true]],
  );
  // The run context keeps the original input despite the failed attempt.
  assert.deepEqual(execution.context.input.amount, 10);
  assert.deepEqual(execution.context.input.nested, { v: 1 });
  assert.equal(execution.context.input.added, undefined);
  assert.deepEqual([...new Uint8Array(execution.context.input.bytes)], [1, 1, 1, 1]);
  // The caller's own objects were never touched.
  assert.deepEqual(callerInput.amount, 10);
  assert.deepEqual(callerInput.nested, { v: 1 });
  assert.deepEqual([...new Uint8Array(callerInput.bytes)], [1, 1, 1, 1]);
});
