import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// trigger -> prep (legacy message) -> work (business "echo") -> done
function businessWorkflow() {
  return {
    id: 'shared-input',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'work' },
      { id: 'work', type: 'action', operation: 'echo', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

// trigger -> message (legacy) -> done: runnable through executeWorkflow.
function syncWorkflow() {
  return {
    id: 'shared-input-sync',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'message' },
      { id: 'message', type: 'action', message: 'hi', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

function assertSharedInputError(error) {
  assert.ok(error instanceof TypeError, 'the rejection must be a TypeError');
  assert.match(error.message, /run input contains shared memory/);
  assert.match(error.message, /SharedArrayBuffer/);
  assert.match(error.message, /independent copies cannot be guaranteed/);
}

// ---------------------------------------------------------------------------
// Rejection shape and timing
// ---------------------------------------------------------------------------

test('synchronous entry throws a TypeError for a directly-shared input before any node runs', () => {
  assert.throws(
    () => executeWorkflow(syncWorkflow(), new SharedArrayBuffer(8)),
    error => {
      assertSharedInputError(error);
      return true;
    },
  );
});

test('a typed array or DataView backed by shared memory rejects the synchronous input', () => {
  const inputs = [
    new Uint8Array(new SharedArrayBuffer(4)),
    new Int32Array(new SharedArrayBuffer(8)),
    new DataView(new SharedArrayBuffer(4)),
    { bytes: new Float64Array(new SharedArrayBuffer(8)) },
  ];
  for (const input of inputs) {
    assert.throws(() => executeWorkflow(syncWorkflow(), input), error => {
      assertSharedInputError(error);
      return true;
    });
  }
});

test('asynchronous entry rejects with the same TypeError and never invokes an operation or compensation', async () => {
  let businessCalls = 0;
  let compensationCalls = 0;
  const workflow = {
    id: 'async-reject',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      {
        id: 'work', type: 'action', operation: 'echo',
        compensation: { operation: 'undo' }, next: 'done',
      },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  await assert.rejects(
    executeWorkflowAsync(workflow, new SharedArrayBuffer(8), {
      echo: () => { businessCalls += 1; return 'ok'; },
      undo: () => { compensationCalls += 1; return 'undone'; },
    }),
    error => {
      assertSharedInputError(error);
      return true;
    },
  );
  assert.equal(businessCalls, 0);
  assert.equal(compensationCalls, 0);
});

test('the rejection is a failed reception, never an action_failed result (no status/context/trace)', async () => {
  let rejected;
  try {
    await executeWorkflowAsync(businessWorkflow(), { view: new DataView(new SharedArrayBuffer(4)) }, {
      echo: () => 'ok',
    });
  } catch (error) {
    rejected = error;
  }
  assertSharedInputError(rejected);
});

test('the caller input and its shared bytes are never mutated by the rejected reception', async () => {
  const bytes = new Uint8Array(new SharedArrayBuffer(4));
  bytes.set([1, 2, 3, 4]);
  const holder = { list: [bytes] };
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), holder, { echo: () => 'ok' }),
    error => { assertSharedInputError(error); return true; },
  );
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  assert.equal(holder.list.length, 1);
});

// ---------------------------------------------------------------------------
// Shared memory anywhere in the retained graph, including cycles and repeats
// ---------------------------------------------------------------------------

test('shared memory nested in object/array properties, Map keys/values, Set members and Error cause is rejected', async () => {
  const inputs = [
    { inner: { bytes: new SharedArrayBuffer(4) } },
    { list: [1, [2, new Uint8Array(new SharedArrayBuffer(4))]] },
    new Map([['k', new SharedArrayBuffer(4)]]),
    new Map([[new SharedArrayBuffer(4), 'k']]),
    new Map([['k', { view: new DataView(new SharedArrayBuffer(4)) }]]),
    new Set([new SharedArrayBuffer(4)]),
    new Set([{ bytes: new Uint8Array(new SharedArrayBuffer(4)) }]),
    { table: new Map([[new Set([new SharedArrayBuffer(4)]), new DataView(new SharedArrayBuffer(4))]]) },
    { boom: new Error('x', { cause: new SharedArrayBuffer(4) }) },
    { boom: new TypeError('x', { cause: { deep: new Map([['k', new Set([new Uint8Array(new SharedArrayBuffer(2))])]]) } }) },
  ];
  for (const input of inputs) {
    assert.throws(() => executeWorkflow(syncWorkflow(), input), error => {
      assertSharedInputError(error);
      return true;
    });
    await assert.rejects(
      () => executeWorkflowAsync(businessWorkflow(), input, { echo: () => 'ok' }),
      error => { assertSharedInputError(error); return true; },
    );
  }
});

test('cyclic and repeated references carrying shared memory are still detected', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  cyclic.items = [cyclic];
  cyclic.shared = new SharedArrayBuffer(2);

  const shared = new SharedArrayBuffer(2);
  const repeated = { a: { buf: shared }, b: { buf: shared }, c: [shared, shared] };

  // A cycle routed through a retained Error cause that still leads to shared
  // bytes: e.cause -> inner -> back -> e, and inner.bytes is retained.
  const causeCycle = (() => {
    const e = new Error('x');
    const inner = { bytes: new Uint8Array(new SharedArrayBuffer(2)) };
    e.cause = inner;
    inner.back = e;
    return e;
  })();

  for (const input of [cyclic, repeated, { wrap: causeCycle }]) {
    assert.throws(() => executeWorkflow(syncWorkflow(), input), error => {
      assertSharedInputError(error);
      return true;
    });
  }
});

test('a shared buffer reachable only after several container hops through a cycle is detected', () => {
  const a = { tag: 'a' };
  const b = { tag: 'b', back: a };
  a.next = b;
  const m = new Map();
  m.set(a, new Set([b]));
  b.leaf = new DataView(new SharedArrayBuffer(4));
  a.map = m;
  assert.throws(() => executeWorkflow(syncWorkflow(), a), error => {
    assertSharedInputError(error);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Content structuredClone drops must not condemn otherwise-legal input
// ---------------------------------------------------------------------------

test('shared memory only in properties the input clone drops (Date/RegExp/view/box) is accepted', () => {
  const date = new Date('2021-06-07T08:09:10.000Z');
  date.aux = new SharedArrayBuffer(8);
  Object.defineProperty(date, 'hidden', { value: new SharedArrayBuffer(4), enumerable: false });

  const regexp = /pattern/gi;
  regexp.aux = new SharedArrayBuffer(4);

  const view = new Uint8Array([4, 3, 2, 1]);
  view.dropped = new SharedArrayBuffer(2);
  const buffer = new ArrayBuffer(2);
  buffer.dropped = new SharedArrayBuffer(2);

  const boxed = new Number(7);
  boxed.aux = new SharedArrayBuffer(2);

  const execution = executeWorkflow(syncWorkflow(), { date, regexp, view, buffer, boxed });
  assert.equal(execution.status, 'completed');
  const input = execution.context.input;
  assert.ok(input.date instanceof Date);
  assert.equal(input.date.getTime(), Date.parse('2021-06-07T08:09:10.000Z'));
  assert.equal(input.date.aux, undefined);
  assert.equal(Object.hasOwn(input.date, 'hidden'), false);
  assert.ok(input.regexp instanceof RegExp);
  assert.equal(input.regexp.source, 'pattern');
  assert.equal(input.regexp.aux, undefined);
  assert.deepEqual([...input.view], [4, 3, 2, 1]);
  assert.equal(input.view.dropped, undefined);
  assert.equal(input.buffer.dropped, undefined);
  assert.equal(input.boxed.valueOf(), 7);
  assert.equal(input.boxed.aux, undefined);
});

test('shared memory only in non-enumerable or symbol-keyed properties of retained objects/arrays is accepted', () => {
  const symbolKey = Symbol('hidden');
  const plain = {};
  Object.defineProperty(plain, 'nonEnumerable', { value: new SharedArrayBuffer(2), enumerable: false });
  plain[symbolKey] = new SharedArrayBuffer(2);
  plain.kept = new Uint8Array([7]);

  const list = [1, 2, 3];
  Object.defineProperty(list, 'aux', { value: new SharedArrayBuffer(8), enumerable: false });
  // A non-enumerable index clones as a hole and is not inspected.
  Object.defineProperty(list, 1, { value: 2, enumerable: false, configurable: true, writable: true });

  const execution = executeWorkflow(syncWorkflow(), { plain, list });
  assert.equal(execution.status, 'completed');
  const input = execution.context.input;
  assert.equal(Object.hasOwn(input.plain, 'nonEnumerable'), false);
  assert.equal(Object.getOwnPropertySymbols(input.plain).length, 0);
  assert.deepEqual([...input.plain.kept], [7]);
  assert.equal(Object.hasOwn(input.list, 'aux'), false);
  assert.equal(Object.hasOwn(input.list, '1'), false);
  assert.deepEqual(Object.keys(input.list), ['0', '2']);
});

test('an enumerable non-index property of an array carrying shared memory is still rejected', () => {
  const bad = Object.assign([1, 2], { note: new SharedArrayBuffer(4) });
  assert.throws(() => executeWorkflow(syncWorkflow(), bad), error => {
    assertSharedInputError(error);
    return true;
  });
});

test('shared memory that genuinely survives the input clone alongside a Date leaf is still rejected', () => {
  const date = new Date();
  date.aux = new SharedArrayBuffer(4); // dropped with the own property
  assert.throws(
    () => executeWorkflow(syncWorkflow(), { when: date, shared: new Uint8Array(new SharedArrayBuffer(4)) }),
    error => { assertSharedInputError(error); return true; },
  );
});

test('Error own properties other than a retained cause are dropped and do not condemn the input', () => {
  const error = new Error('boom');
  error.shared = new SharedArrayBuffer(4);
  Object.defineProperty(error, 'hidden', { value: new SharedArrayBuffer(4), enumerable: true });
  const execution = executeWorkflow(syncWorkflow(), { error });
  assert.equal(execution.status, 'completed');
  assert.ok(execution.context.input.error instanceof Error);
  assert.equal(execution.context.input.error.message, 'boom');
  assert.equal(execution.context.input.error.shared, undefined);
  assert.equal(Object.hasOwn(execution.context.input.error, 'hidden'), false);
});

test('a non-enumerable retained Error cause carrying shared memory is rejected', () => {
  const error = new Error('boom');
  Object.defineProperty(error, 'cause', { value: new SharedArrayBuffer(4), enumerable: false, configurable: true });
  assert.throws(() => executeWorkflow(syncWorkflow(), { error }), e => {
    assertSharedInputError(e);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Getters and custom iterators: the judgment follows the clone's one read
// ---------------------------------------------------------------------------

test('an enumerable getter is read once by the clone and judged on that retained value', () => {
  let reads = 0;
  const legal = {
    get g() {
      reads += 1;
      return new Uint8Array([7]);
    },
  };
  const legalRun = executeWorkflow(syncWorkflow(), legal);
  assert.equal(legalRun.status, 'completed');
  assert.equal(reads, 1);
  assert.deepEqual([...legalRun.context.input.g], [7]);

  assert.throws(
    () => executeWorkflow(syncWorkflow(), { get g() { return new SharedArrayBuffer(2); } }),
    e => { assertSharedInputError(e); return true; },
  );

  // A getter whose first read is ordinary but whose later reads hand back
  // shared memory is judged only by the value the single clone read retained.
  let toggle = 0;
  const once = {
    get g() {
      toggle += 1;
      return toggle === 1 ? new Uint8Array([1]) : new SharedArrayBuffer(2);
    },
  };
  assert.equal(executeWorkflow(syncWorkflow(), once).status, 'completed');
  assert.equal(toggle, 1);
});

test('a Map/Set custom iterator cannot hide real shared members or fabricate shared ones', () => {
  const hiding = new Map([['k', new SharedArrayBuffer(2)]]);
  hiding[Symbol.iterator] = function* () {};
  assert.throws(() => executeWorkflow(syncWorkflow(), { m: hiding }), e => {
    assertSharedInputError(e); return true;
  });

  const hidingSet = new Set([new SharedArrayBuffer(2)]);
  hidingSet[Symbol.iterator] = function* () {};
  assert.throws(() => executeWorkflow(syncWorkflow(), { s: hidingSet }), e => {
    assertSharedInputError(e); return true;
  });

  const fabricating = new Map([['k', 1]]);
  fabricating[Symbol.iterator] = function* () { yield ['fake', new SharedArrayBuffer(2)]; };
  const run = executeWorkflow(syncWorkflow(), { m: fabricating });
  assert.equal(run.status, 'completed');
  assert.deepEqual([...run.context.input.m.entries()], [['k', 1]]);
});

test('cross-realm shared buffers and views in the input are rejected; cross-realm plain buffers pass', async () => {
  const vm = await import('node:vm');
  const realm = vm.createContext({});
  const remote = code => vm.runInContext(code, realm);
  const shared = [
    remote('new SharedArrayBuffer(4)'),
    remote('new Uint8Array(new SharedArrayBuffer(4))'),
    remote('new DataView(new SharedArrayBuffer(4))'),
    { bytes: remote('new Uint8Array(new SharedArrayBuffer(4))') },
    new Map([['k', remote('new SharedArrayBuffer(4)')]]),
  ];
  for (const input of shared) {
    await assert.rejects(
      () => executeWorkflowAsync(businessWorkflow(), input, { echo: () => 'ok' }),
      e => { assertSharedInputError(e); return true; },
    );
  }
  const execution = await executeWorkflowAsync(businessWorkflow(),
    { bytes: remote('new Uint8Array([1, 2, 3])') }, { echo: () => 'ok' });
  assert.equal(execution.status, 'completed');
  assert.deepEqual([...execution.context.input.bytes], [1, 2, 3]);
});

test('a spoofed @@toStringTag does not change classification', () => {
  const fake = { [Symbol.toStringTag]: 'SharedArrayBuffer', x: 1 };
  assert.equal(executeWorkflow(syncWorkflow(), fake).status, 'completed');
  const nested = { [Symbol.toStringTag]: 'Map', x: new SharedArrayBuffer(2) };
  assert.throws(() => executeWorkflow(syncWorkflow(), nested), e => {
    assertSharedInputError(e); return true;
  });
});

// ---------------------------------------------------------------------------
// Ordinary buffers stay legal, with full copy/identity isolation
// ---------------------------------------------------------------------------

test('a plain ArrayBuffer and its views are accepted with type, bytes and reference relations preserved', async () => {
  const buffer = new ArrayBuffer(8);
  new Uint8Array(buffer).set([9, 8, 7, 6, 5, 4, 3, 2]);
  const view = new Uint16Array(buffer);
  const root = { buffer, view, again: view, list: [view], date: new Date(0), map: new Map([['v', view]]) };
  root.self = root;

  const execution = executeWorkflow(syncWorkflow(), root);
  const asyncRun = await executeWorkflowAsync(businessWorkflow(), root, { echo: () => 'ok' });
  assert.equal(execution.status, 'completed');
  assert.equal(asyncRun.status, 'completed');

  const input = execution.context.input;
  assert.ok(input.buffer instanceof ArrayBuffer);
  assert.ok(!(input.buffer instanceof SharedArrayBuffer));
  assert.ok(input.view instanceof Uint16Array);
  assert.equal(input.view.buffer, input.buffer);
  assert.equal(input.again, input.view, 'repeated references stay identical');
  assert.equal(input.list[0], input.view);
  assert.equal(input.map.get('v'), input.view);
  assert.equal(input.self, input, 'cycles are preserved');
  assert.ok(input.date instanceof Date);

  // Mutate the caller's original only after both runs retained their copies.
  new Uint8Array(buffer)[0] = 100;
  assert.deepEqual([...new Uint8Array(input.buffer)], [9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual([...new Uint8Array(asyncRun.context.input.buffer)], [9, 8, 7, 6, 5, 4, 3, 2]);
});

test('a business action mutating its input copy cannot change the caller input, the run context or a later attempt', async () => {
  const callerBytes = new Uint8Array([1, 2, 3]);
  const callerInput = { amount: 10, bytes: callerBytes, nested: { label: 'original' } };

  const retryWorkflow = {
    id: 'isolation',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      {
        id: 'work', type: 'action', operation: 'echo',
        retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        next: 'done',
      },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };

  const seen = [];
  const execution = await executeWorkflowAsync(retryWorkflow, callerInput, {
    echo: (input, output, nodeId, attempt) => {
      seen.push({
        amount: input.amount,
        first: input.bytes[0],
        label: input.nested.label,
      });
      // Mutations belong to this attempt's copy only.
      input.amount = 999;
      input.bytes[0] = 100 + attempt;
      input.nested.label = 'mutated';
      input.extra = 'attempt-only';
      if (attempt === 1) throw new Error('force retry');
      return { echoed: input.amount };
    },
  });

  assert.equal(execution.status, 'completed');
  assert.deepEqual(seen, [
    { amount: 10, first: 1, label: 'original' },
    { amount: 10, first: 1, label: 'original' },
  ]);
  // The caller's input and its bytes are untouched.
  assert.equal(callerInput.amount, 10);
  assert.equal(callerInput.nested.label, 'original');
  assert.equal(callerInput.extra, undefined);
  assert.deepEqual([...callerBytes], [1, 2, 3]);
  // The run context keeps the original input (defaults apart), not the edits.
  assert.equal(execution.context.input.amount, 10);
  assert.equal(execution.context.input.nested.label, 'original');
  assert.equal(execution.context.input.extra, undefined);
  assert.deepEqual([...execution.context.input.bytes], [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Ordering: definition / registration / signal checks keep their precedence
// ---------------------------------------------------------------------------

test('definition and business-operation checks precede the input check', async () => {
  const invalid = {
    id: 'bad', entry: 'start',
    nodes: [{ id: 'start', type: 'trigger', next: 'ghost' }],
  };
  assert.throws(() => executeWorkflow(invalid, new SharedArrayBuffer(4)), /unknown destination/);
  await assert.rejects(
    () => executeWorkflowAsync(invalid, new SharedArrayBuffer(4), {}),
    /unknown destination/,
  );

  // A workflow naming a missing operation reports the registration problem,
  // not the shared input.
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), new SharedArrayBuffer(4), {}),
    /operation "echo" has no function implementation/,
  );

  // The synchronous entry still refuses a business-operation workflow first.
  assert.throws(
    () => executeWorkflow(businessWorkflow(), new SharedArrayBuffer(4)),
    /must run asynchronously/,
  );
});

test('invalid options/signal shape is rejected before the input is received', async () => {
  await assert.rejects(
    () => executeWorkflowAsync(businessWorkflow(), new SharedArrayBuffer(4), { echo: () => 'ok' }, { signal: {} }),
    /AbortSignal/,
  );
});

test('a signal already aborted before the start does not waive the shared-input check', async () => {
  const workflow = {
    id: 'preaborted',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      {
        id: 'work', type: 'action', operation: 'echo',
        compensation: { operation: 'undo' }, next: 'done',
      },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeWorkflowAsync(workflow, { x: new SharedArrayBuffer(4) }, {
      echo: () => { calls += 1; return 'ok'; },
      undo: () => { calls += 1; return 'undone'; },
    }, { signal: controller.signal }),
    e => { assertSharedInputError(e); return true; },
  );
  assert.equal(calls, 0);
});

test('a pre-aborted run with legal input is still cancelled, with the usual independent copy', async () => {
  const controller = new AbortController();
  controller.abort();
  const callerInput = { amount: 5, bytes: new Uint8Array([1, 2]) };
  const execution = await executeWorkflowAsync(businessWorkflow(), callerInput, {
    echo: () => 'ok',
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.deepEqual(execution.trace, []);
  assert.deepEqual(execution.actionAttempts, []);
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.context.input, { amount: 5, bytes: new Uint8Array([1, 2]) });
  // The reported input is an independent copy; mutating it and the caller's
  // bytes cannot cross.
  execution.context.input.bytes[0] = 99;
  execution.context.input.amount = 999;
  assert.equal(callerInput.amount, 5);
  assert.deepEqual([...callerInput.bytes], [1, 2]);
});

// ---------------------------------------------------------------------------
// Forms, defaults and conditions keep working against buffer-bearing input
// ---------------------------------------------------------------------------

test('form defaults, validation and conditions keep their existing behavior with legal buffer input', () => {
  const workflow = {
    id: 'form-input',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form' },
      {
        id: 'form', type: 'form',
        schema: { fields: [{ path: 'amount', type: 'integer', required: true, default: 7 }] },
        next: 'check',
      },
      {
        id: 'check', type: 'condition',
        condition: { field: 'amount', operator: 'gte', value: 1 },
        then: 'done', else: 'done',
      },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { bytes: new Uint8Array([0]) };
  const execution = executeWorkflow(workflow, caller);
  assert.equal(execution.status, 'completed');
  assert.equal(execution.context.input.amount, 7, 'the default is applied to the run copy');
  assert.equal(caller.amount, undefined, 'the caller object never receives the default');
  assert.deepEqual([...execution.context.input.bytes], [0]);
});
