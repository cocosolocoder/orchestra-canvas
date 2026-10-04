import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

// trigger -> legacy message action -> end, usable through the synchronous
// entry. `message` is installed verbatim on the action node.
function linearMessageWorkflow(message, { omit = false } = {}) {
  return {
    id: 'linear-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      omit
        ? { id: 'note', type: 'action', next: 'done' }
        : { id: 'note', type: 'action', message, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

// A business action precedes the legacy message action: when definition
// validation fails it must never have been invoked.
function businessThenMessageWorkflow(message) {
  return {
    id: 'business-then-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'early' },
      {
        id: 'early', type: 'action', operation: 'opEarly',
        compensation: { operation: 'undoEarly' }, next: 'note',
      },
      { id: 'note', type: 'action', message, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

function assertMessageSharedMemoryError(error, nodeId = 'note') {
  assert.ok(error instanceof Error, 'a definition error (plain Error) is thrown/rejected');
  assert.ok(!(error instanceof TypeError), 'shared-memory messages are a definition error, not a TypeError');
  assert.match(error.message, new RegExp(`action node ${nodeId}: message contains shared memory`));
  assert.match(error.message, /SharedArrayBuffer/);
  assert.match(error.message, /independent copies cannot be guaranteed/);
}

// Every message below retains shared memory in the content its structured
// clone actually saves.
function sharedMessages() {
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
    // The Error constructor installs "cause" as a non-enumerable own
    // property; it must still count because the clone retains it.
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
    () => [new SharedArrayBuffer(4)],
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
// validateWorkflow rejects every retained-shared-memory message
// ---------------------------------------------------------------------------

test('validateWorkflow rejects a legacy message whose clone retains shared memory, naming the action node', () => {
  for (const make of sharedMessages()) {
    assert.throws(
      () => validateWorkflow(linearMessageWorkflow(make())),
      error => {
        assertMessageSharedMemoryError(error);
        return true;
      },
    );
  }
});

test('the check judges the structured-cloned message: cycles and repeated references never bypass it', () => {
  // Shared bytes reachable only through a cycle edge.
  const a = { name: 'a' };
  const b = { name: 'b' };
  a.peer = b;
  b.peer = a;
  b.bytes = new SharedArrayBuffer(4);
  assert.throws(() => validateWorkflow(linearMessageWorkflow(a)), /action node note/);

  // The same shared buffer aliased through many slots is still found once.
  const shared = new SharedArrayBuffer(4);
  const root = { x: [shared], y: { z: shared } };
  root.loop = root;
  assert.throws(() => validateWorkflow(linearMessageWorkflow(root)), /message contains shared memory/);
});

// ---------------------------------------------------------------------------
// Both execution entries reject before any node runs
// ---------------------------------------------------------------------------

test('the synchronous entry throws before any node executes', () => {
  for (const make of sharedMessages()) {
    assert.throws(
      () => executeWorkflow(businessThenMessageWorkflow(make()), {}),
      error => {
        assertMessageSharedMemoryError(error);
        return true;
      },
    );
  }
});

test('the asynchronous entry rejects for the same reason without action_failed, traces, attempts or compensation', async () => {
  let businessCalls = 0;
  let compensationCalls = 0;
  const operations = {
    opEarly: () => { businessCalls += 1; return 'early'; },
    undoEarly: () => { compensationCalls += 1; return 'undone'; },
  };
  for (const make of sharedMessages()) {
    let outcome;
    try {
      outcome = await executeWorkflowAsync(businessThenMessageWorkflow(make()), {}, operations);
    } catch (error) {
      assertMessageSharedMemoryError(error);
      continue;
    }
    assert.fail(`expected a rejection, got a result: ${JSON.stringify(outcome && outcome.status)}`);
  }
  assert.equal(businessCalls, 0);
  assert.equal(compensationCalls, 0);
});

test('an already-aborted signal does not turn the definition rejection into a cancelled run', async () => {
  const controller = new AbortController();
  controller.abort();
  let businessCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(
      businessThenMessageWorkflow(new SharedArrayBuffer(4)),
      {},
      { opEarly: () => { businessCalls += 1; return 'early'; }, undoEarly: () => 'u' },
      { signal: controller.signal },
    ),
    error => {
      assertMessageSharedMemoryError(error);
      return true;
    },
  );
  assert.equal(businessCalls, 0);
});

// ---------------------------------------------------------------------------
// The whole definition is covered — untaken branches and orphans included
// ---------------------------------------------------------------------------

test('messages on untaken branches and entry-unreachable actions are checked too', () => {
  const untaken = {
    id: 'untaken-message-branch',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-note', else: 'bad-note',
      },
      { id: 'good-note', type: 'action', message: 'good', next: 'good-end' },
      { id: 'good-end', type: 'end', result: 'good' },
      { id: 'bad-note', type: 'action', message: new SharedArrayBuffer(4), next: 'bad-end' },
      { id: 'bad-end', type: 'end', result: 'bad' },
    ],
  };
  assert.throws(() => validateWorkflow(untaken), /action node bad-note/);
  assert.throws(() => executeWorkflow(untaken, { route: 'good' }), /action node bad-note/);

  const unreachable = {
    id: 'unreachable-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'orphan', type: 'action', message: { bytes: new SharedArrayBuffer(4) }, next: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(unreachable), /action node orphan/);
});

// ---------------------------------------------------------------------------
// The existing function error is unchanged
// ---------------------------------------------------------------------------

test('a bare function or a nested function still reports the original cloneability error', () => {
  assert.throws(
    () => validateWorkflow(linearMessageWorkflow(() => 'nope')),
    /action node note: message must be a structured-cloneable value/,
  );
  for (const message of [
    { save: () => 'nope' },
    { rows: [{ ok: true }, { hook: () => 'nope' }] },
    [1, { nested: [() => 'nope'] }],
  ]) {
    assert.throws(
      () => validateWorkflow(linearMessageWorkflow(message)),
      /message must be a structured-cloneable value \(objects and arrays must not contain functions\)/,
    );
  }
});

test('a message carrying both a function and shared memory reports the cloneability failure first', () => {
  const message = { fn: () => 'nope', bytes: new SharedArrayBuffer(4) };
  assert.throws(
    () => validateWorkflow(linearMessageWorkflow(message)),
    /message must be a structured-cloneable value/,
  );
});

// ---------------------------------------------------------------------------
// Actions that name an operation ignore their message entirely
// ---------------------------------------------------------------------------

test('an operation action is never rejected for an unused shared-memory message', async () => {
  const workflow = {
    id: 'unused-shared-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'real', message: new SharedArrayBuffer(4), next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  assert.doesNotThrow(() => validateWorkflow(workflow));

  // The synchronous entry still refuses business-operation workflows — for
  // the async-only reason, never for the ignored message.
  assert.throws(
    () => executeWorkflow(workflow, {}),
    /action node work names business operation "real".*must run asynchronously/,
  );

  const run = await executeWorkflowAsync(workflow, {}, { real: () => 'from-operation' });
  assert.equal(run.status, 'completed');
  assert.equal(run.context.output.work, 'from-operation');
  assert.equal(run.actionAttempts.length, 1);
});

// ---------------------------------------------------------------------------
// Shared memory placed only where the clone drops it is accepted
// ---------------------------------------------------------------------------

test('shared bytes in clone-dropped properties (Date/RegExp auxiliaries, non-enumerable and symbol keys) are accepted', () => {
  const symbolKey = Symbol('hidden');

  const date = new Date('2021-06-07T08:09:10.000Z');
  date.aux = new SharedArrayBuffer(8);
  class CustomDate extends Date {}
  const customDate = new CustomDate(0);
  customDate.aux = new SharedArrayBuffer(8);

  const regexp = /pattern/gi;
  regexp.aux = new SharedArrayBuffer(8);
  class CustomRegExp extends RegExp {}
  const customRegexp = new CustomRegExp('pat');
  customRegexp.aux = new SharedArrayBuffer(8);

  const plainBuffer = new ArrayBuffer(2);
  plainBuffer.dropped = new SharedArrayBuffer(2);
  const view = new Uint8Array([1, 2]);
  view.dropped = new SharedArrayBuffer(2);

  const errorWithAux = new Error('boom');
  errorWithAux.details = new SharedArrayBuffer(4);

  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'hidden', { value: new SharedArrayBuffer(4), enumerable: false });

  const list = ['a', 'b'];
  Object.defineProperty(list, 'aux', { value: new SharedArrayBuffer(4), enumerable: false });
  // A non-enumerable index clones as a hole; the dropped bytes never count.
  const holey = [10, 20, 30];
  Object.defineProperty(holey, 1, { value: new SharedArrayBuffer(4), enumerable: false, configurable: true });

  const symboled = {};
  symboled[symbolKey] = new SharedArrayBuffer(4);

  const boxed = new Number(7);
  boxed.aux = new SharedArrayBuffer(4);

  const message = {
    date, customDate, regexp, customRegexp, plainBuffer, view,
    errorWithAux, nonEnumerable, list, holey, symboled, boxed,
    keep: new Uint8Array([7, 8]),
  };

  assert.doesNotThrow(() => validateWorkflow(linearMessageWorkflow(message)));

  const run = executeWorkflow(linearMessageWorkflow(message), {});
  assert.equal(run.status, 'completed');
  const saved = run.context.output.note;
  assert.ok(saved.date instanceof Date);
  assert.ok(saved.customDate instanceof Date);
  assert.ok(saved.regexp instanceof RegExp);
  assert.ok(saved.customRegexp instanceof RegExp);
  assert.equal(saved.date.aux, undefined);
  assert.equal(saved.customDate.aux, undefined);
  assert.equal(saved.regexp.aux, undefined);
  assert.equal(saved.customRegexp.aux, undefined);
  assert.equal(saved.plainBuffer.dropped, undefined);
  assert.equal(saved.view.dropped, undefined);
  assert.equal(saved.errorWithAux.details, undefined);
  assert.equal(Object.hasOwn(saved.nonEnumerable, 'hidden'), false);
  assert.equal(Object.hasOwn(saved.list, 'aux'), false);
  assert.equal(Object.getOwnPropertySymbols(saved.symboled).length, 0);
  assert.equal(saved.boxed.aux, undefined);
  assert.deepEqual([...saved.keep], [7, 8]);
  assert.equal(1 in saved.holey, false);

  // The definition keeps the discarded auxiliary properties untouched.
  assert.ok(message.date.aux instanceof SharedArrayBuffer);
  assert.ok(message.plainBuffer.dropped instanceof SharedArrayBuffer);
});

test('a shared buffer carried only in an Error non-cause own property is dropped and the message is legal', () => {
  const message = new Error('saved normally');
  message.info = { bytes: new SharedArrayBuffer(4) };
  message.cause = 'ordinary cause';
  const workflow = linearMessageWorkflow(message);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  const run = executeWorkflow(workflow, {});
  assert.equal(run.status, 'completed');
  assert.ok(run.context.output.note instanceof Error);
  assert.equal(run.context.output.note.message, 'saved normally');
  assert.equal(run.context.output.note.cause, 'ordinary cause');
  assert.equal(run.context.output.note.info, undefined);
});

// ---------------------------------------------------------------------------
// The judgment is made on the validation clone's own reads
// ---------------------------------------------------------------------------

test('an enumerable getter is read by the validation clone and judged on that value', () => {
  let rejectingReads = 0;
  const sharedFirst = {
    get flip() {
      rejectingReads += 1;
      return rejectingReads === 1 ? new SharedArrayBuffer(4) : 'ordinary';
    },
  };
  assert.throws(() => validateWorkflow(linearMessageWorkflow(sharedFirst)), /message contains shared memory/);
  assert.equal(rejectingReads, 1, 'the getter is read exactly once during validation');

  let acceptedReads = 0;
  const ordinaryFirst = {
    get flip() {
      acceptedReads += 1;
      return acceptedReads === 1 ? 'ordinary' : new SharedArrayBuffer(4);
    },
  };
  assert.doesNotThrow(() => validateWorkflow(linearMessageWorkflow(ordinaryFirst)));
  assert.equal(acceptedReads, 1, 'the getter is read exactly once during validation');
});

test('a custom Map/Set iterator cannot hide real shared members or fabricate shared ones', () => {
  const hiddenMap = new Map([['real', new SharedArrayBuffer(2)]]);
  hiddenMap[Symbol.iterator] = function* hidden() { yield ['fake', 1]; };
  assert.throws(() => validateWorkflow(linearMessageWorkflow({ map: hiddenMap })), /shared memory/);

  const emptySet = new Set([new SharedArrayBuffer(2)]);
  emptySet[Symbol.iterator] = function* empty() {};
  assert.throws(() => validateWorkflow(linearMessageWorkflow({ set: emptySet })), /shared memory/);

  const fabricatedMap = new Map([['real', 1]]);
  fabricatedMap[Symbol.iterator] = function* fake() { yield ['fabricated', new SharedArrayBuffer(2)]; };
  const fabricatedSet = new Set([1, 2]);
  fabricatedSet[Symbol.iterator] = function* fake() { yield new SharedArrayBuffer(2); };
  for (const message of [{ map: fabricatedMap }, { set: fabricatedSet }]) {
    assert.doesNotThrow(() => validateWorkflow(linearMessageWorkflow(message)));
    const run = executeWorkflow(linearMessageWorkflow(message), {});
    assert.equal(run.status, 'completed');
    const saved = run.context.output.note;
    assert.equal(saved.map ? saved.map.get('real') : [...saved.set].join(','), saved.map ? 1 : '1,2');
  }
});

test('shared buffers and views produced in another realm are rejected too', async () => {
  const vm = await import('node:vm');
  const realm = vm.createContext({});
  const remote = code => vm.runInContext(code, realm);
  for (const message of [
    remote('new SharedArrayBuffer(4)'),
    remote('new Uint8Array(new SharedArrayBuffer(4))'),
    remote('new DataView(new SharedArrayBuffer(4))'),
    { bytes: remote('new Uint8Array(new SharedArrayBuffer(4))') },
    new Map([['k', remote('new SharedArrayBuffer(4)')]]),
  ]) {
    assert.throws(
      () => validateWorkflow(linearMessageWorkflow(message)),
      /message contains shared memory/,
    );
  }
});

// ---------------------------------------------------------------------------
// Legal byte-bearing messages keep bytes, types, independence and references
// ---------------------------------------------------------------------------

test('a plain ArrayBuffer message and views are copied byte-for-byte and stay independent across runs and the definition', () => {
  const workflow = linearMessageWorkflow(Uint8Array.from([9, 8, 7, 6]).buffer);
  const definitionBuffer = workflow.nodes[1].message;

  const first = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');
  const firstOutput = first.context.output.note;
  assert.ok(firstOutput instanceof ArrayBuffer);
  assert.ok(!(firstOutput instanceof SharedArrayBuffer));
  assert.notEqual(firstOutput, definitionBuffer);
  assert.deepEqual([...new Uint8Array(firstOutput)], [9, 8, 7, 6]);

  // Rewriting the returned output bytes cannot reach the definition.
  new Uint8Array(firstOutput).fill(1);
  assert.deepEqual([...new Uint8Array(definitionBuffer)], [9, 8, 7, 6]);

  // A second run gets its own copy of the untouched configured bytes.
  const second = executeWorkflow(workflow, {});
  assert.deepEqual([...new Uint8Array(second.context.output.note)], [9, 8, 7, 6]);
  assert.notEqual(second.context.output.note, firstOutput);
  assert.notEqual(second.context.output.note, definitionBuffer);
});

test('structured legal messages preserve types, bytes, circular and repeated references through both entries', async () => {
  const bytes = new ArrayBuffer(4);
  new Uint8Array(bytes).set([1, 2, 3, 4]);
  const view = new Uint16Array(new ArrayBuffer(4));
  new Uint8Array(view.buffer).set([5, 6, 7, 8]);
  const detail = { id: 'detail' };
  const message = {
    bytes, view, detail, when: new Date('2020-02-03T04:05:06.000Z'), pattern: /ok/gi,
  };
  message.self = message;
  message.again = detail;
  message.list = [detail];

  const assertSaved = saved => {
    assert.ok(saved.bytes instanceof ArrayBuffer);
    assert.notEqual(saved.bytes, bytes);
    assert.ok(saved.view instanceof Uint16Array);
    assert.notEqual(saved.view.buffer, view.buffer);
    assert.deepEqual([...new Uint8Array(saved.bytes)], [1, 2, 3, 4]);
    assert.deepEqual([...new Uint8Array(saved.view.buffer)], [5, 6, 7, 8]);
    assert.ok(saved.when instanceof Date);
    assert.ok(saved.pattern instanceof RegExp);
    assert.equal(saved.self, saved);
    assert.equal(saved.again, saved.detail);
    assert.equal(saved.list[0], saved.detail);
  };

  const workflow = linearMessageWorkflow(message);

  const sync = executeWorkflow(workflow, {});
  assert.equal(sync.status, 'completed');
  assertSaved(sync.context.output.note);

  const asynced = await executeWorkflowAsync(workflow, {});
  assert.equal(asynced.status, 'completed');
  assertSaved(asynced.context.output.note);

  // Legacy message actions never enter business/compensation records.
  assert.deepEqual(asynced.actionAttempts, []);
  assert.equal(asynced.compensationStatus, 'not_needed');
  assert.deepEqual(asynced.compensationAttempts, []);

  // The definition and the caller's objects are never mutated.
  assert.equal(workflow.nodes[1].message, message);
  assert.equal(workflow.nodes[1].message.bytes, bytes);
  new Uint8Array(asynced.context.output.note.bytes).fill(9);
  assert.deepEqual([...new Uint8Array(message.bytes)], [1, 2, 3, 4]);
  assert.equal(message.detail.id, 'detail');
});

// ---------------------------------------------------------------------------
// Default / primitive message rules are unchanged by the new check
// ---------------------------------------------------------------------------

test('absent, undefined, null and primitive messages keep their existing output rules', async () => {
  const cases = [
    ['absent', 'omit', `action:note`],
    ['undefined', undefined, `action:note`],
    ['null', null, `action:note`],
    ['empty string', '', ''],
    ['zero', 0, 0],
    ['false', false, false],
    ['number', 42, 42],
    ['boolean', true, true],
  ];
  for (const [label, configured, expected] of cases) {
    const workflow = linearMessageWorkflow(configured, { omit: label === 'absent' });
    assert.doesNotThrow(() => validateWorkflow(workflow), label);
    const sync = executeWorkflow(workflow, {});
    assert.equal(sync.context.output.note, expected, `sync ${label}`);
    const asynced = await executeWorkflowAsync(workflow, {});
    assert.equal(asynced.context.output.note, expected, `async ${label}`);
    assert.deepEqual(asynced.actionAttempts, []);
  }
});
