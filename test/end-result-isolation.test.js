import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A linear trigger -> end workflow usable by the synchronous entry.
function linearEndWorkflow(endResult) {
  return {
    id: 'linear-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'finish' },
      { id: 'finish', type: 'end', result: endResult },
    ],
  };
}

// A single-end workflow whose end carries a nested approval result. Array
// successors force the "exactly one end node" rule, which is also what lets
// the end run before another activated branch's business action finishes.
function approvalWorkflow(endResult) {
  return {
    id: 'approval',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: endResult },
      { id: 'work', type: 'action', operation: 'work', next: 'finish' },
    ],
  };
}

const approvalPayload = () => ({
  verdict: 'approved',
  approver: { id: 'u-7', name: 'Lee' },
  details: [
    { item: 'keyboard', qty: 2 },
    { item: 'monitor', qty: 1 },
  ],
  flags: { urgent: false, tags: ['finance'] },
});

test('synchronous run returns an independent deep copy of an object end result', () => {
  const workflow = linearEndWorkflow(approvalPayload());
  const first = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');

  // The caller can freely edit fields, add/delete nested properties and
  // change array contents of the value it received.
  first.result.verdict = 'rejected';
  first.result.approver.name = 'Someone Else';
  first.result.details[0].qty = 99;
  first.result.details.push({ item: 'webcam', qty: 3 });
  delete first.result.flags.tags;
  first.result.extra = { nested: [1, 2, 3] };

  // The definition keeps its configured content, nested levels included.
  assert.equal(workflow.nodes[1].result.verdict, 'approved');
  assert.equal(workflow.nodes[1].result.approver.name, 'Lee');
  assert.equal(workflow.nodes[1].result.details[0].qty, 2);
  assert.deepEqual(workflow.nodes[1].result.details.map(d => d.item), ['keyboard', 'monitor']);
  assert.equal(Object.hasOwn(workflow.nodes[1].result.flags, 'tags'), true);
  assert.equal('extra' in workflow.nodes[1].result, false);

  // Re-running the same definition still yields the configured content.
  const second = executeWorkflow(workflow, {});
  assert.deepEqual(second.result, approvalPayload());
  assert.notEqual(second.result, workflow.nodes[1].result);
  assert.notEqual(second.result.details, workflow.nodes[1].result.details);

  // Editing one run's result cannot change another completed run's result.
  first.result.details.length = 0;
  assert.equal(second.result.details.length, 2);
});

test('arrays at the top level and primitive leaves are isolated too', () => {
  const workflow = linearEndWorkflow({ rows: [{ n: 1 }, { n: 2 }] });
  const execution = executeWorkflow(workflow, {});
  execution.result.rows[0].n = 100;
  execution.result.rows.pop();
  assert.deepEqual(workflow.nodes[1].result.rows, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(executeWorkflow(workflow, {}).result.rows, [{ n: 1 }, { n: 2 }]);
});

test('asynchronous run follows the same deep-copy isolation rules', async () => {
  const workflow = approvalWorkflow(approvalPayload());
  const execution = await executeWorkflowAsync(workflow, {}, { work: () => 'done' });
  assert.equal(execution.status, 'completed');

  execution.result.verdict = 'rejected';
  execution.result.details[1].item = 'changed';
  execution.result.flags.tags.push('tampered');

  assert.equal(workflow.nodes[1].result.verdict, 'approved');
  assert.equal(workflow.nodes[1].result.details[1].item, 'monitor');
  assert.deepEqual(workflow.nodes[1].result.flags.tags, ['finance']);

  const another = await executeWorkflowAsync(workflow, {}, { work: () => 'done' });
  assert.deepEqual(another.result, approvalPayload());
  assert.notEqual(another.result, execution.result);
});

test('unset, null and primitive results keep their exact values', async () => {
  const cases = [
    ['absent', undefined, value => assert.equal(value, null)],
    ['null', null, value => assert.equal(value, null)],
    ['empty string', '', value => assert.equal(value, '')],
    ['zero', 0, value => assert.equal(value, 0)],
    ['false', false, value => assert.equal(value, false)],
    ['number', 42, value => assert.equal(value, 42)],
    ['boolean', true, value => assert.equal(value, true)],
  ];
  for (const [label, configured, check] of cases) {
    const workflow = {
      id: `primitive-${label}`,
      entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'done' },
        configured === undefined
          ? { id: 'done', type: 'end' }
          : { id: 'done', type: 'end', result: configured },
      ],
    };
    const sync = executeWorkflow(workflow, {});
    check(sync.result);
  }

  // The asynchronous entry preserves them as well, especially 0 and false.
  for (const configured of [0, false, '']) {
    const workflow = {
      id: 'async-primitives', entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'done' },
        { id: 'done', type: 'end', result: configured },
      ],
    };
    const execution = await executeWorkflowAsync(workflow, {});
    assert.equal(execution.result, configured);
  }
});

test('end result recorded before a waiting branch is immune to definition mutation during the wait', async () => {
  const workflow = {
    id: 'early-end-wait', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: approvalPayload() },
      { id: 'work', type: 'action', operation: 'slow', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      // The end node has already run; mutate the definition's result object
      // while this branch is still waiting.
      setTimeout(() => {
        workflow.nodes[1].result.verdict = 'tampered';
        workflow.nodes[1].result.details[0].item = 'tampered-item';
        workflow.nodes[1].result.details.push({ item: 'late', qty: 9 });
      }, 10);
      await sleep(40);
      return 'done';
    },
  });

  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.result, approvalPayload());
  // The mutation really happened on the definition; only the recorded result
  // was protected.
  assert.equal(workflow.nodes[1].result.verdict, 'tampered');
});

test('an end reached before another branch fails still reports failure and compensates', async () => {
  let compensated = 0;
  const workflow = {
    id: 'early-end-fail', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'work'] },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'finish' },
      { id: 'finish', type: 'end', result: approvalPayload() },
      { id: 'work', type: 'action', operation: 'opB', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: async () => {
      // The end node already ran by the time this branch fails.
      workflow.nodes[2].result.verdict = 'tampered';
      throw new Error('branch failed');
    },
    undoA: () => { compensated += 1; return 'undone'; },
  });

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.equal('result' in execution, false);
  assert.equal(compensated, 1);
  assert.equal(execution.compensationStatus, 'completed');
});

test('an end reached before cancellation still returns cancelled and compensates', async () => {
  const controller = new AbortController();
  let compensated = 0;
  const workflow = {
    id: 'early-end-cancel', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'work'] },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'finish' },
      { id: 'finish', type: 'end', result: approvalPayload() },
      { id: 'work', type: 'action', operation: 'opB', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: async () => {
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      return 'B';
    },
    undoA: () => { compensated += 1; return 'undone'; },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  assert.equal(compensated, 1);
});

test('a function nested in an end result is a definition error naming the end node', () => {
  const workflow = approvalWorkflow({ verdict: 'approved', save: () => 'nope' });
  assert.throws(
    () => validateWorkflow(workflow),
    /end node finish: result must be a structured-cloneable value/,
  );
});

test('a bare function result and a function inside a nested array are rejected too', () => {
  const bare = {
    id: 'bare-fn', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: () => 'x' },
    ],
  };
  assert.throws(() => validateWorkflow(bare), /end node done/);

  const nested = approvalWorkflow({ rows: [{ ok: true }, { hook: () => 'nope' }] });
  assert.throws(() => validateWorkflow(nested), /end node finish/);
});

test('valid plain objects, arrays and cloneable built-ins are accepted', () => {
  for (const result of [
    approvalPayload(),
    [1, 2, { a: [] }],
    { when: new Date(0), pattern: /ok/, bytes: new Uint8Array([1, 2]) },
  ]) {
    assert.doesNotThrow(() => validateWorkflow(approvalWorkflow(result)));
  }
});

test('all three entries report an uncloneable end result before any node or action runs', async () => {
  const workflow = approvalWorkflow({ verdict: 'approved', save: () => 'nope' });
  let businessCalls = 0;
  const operations = { work: () => { businessCalls += 1; return 'done'; } };

  assert.throws(() => executeWorkflow(workflow, {}), /end node finish/);
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, operations), /end node finish/);
  assert.equal(businessCalls, 0);
});

test('end nodes on branches that never run are still checked', () => {
  const workflow = {
    id: 'untaken-branch', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-end', else: 'bad-end',
      },
      { id: 'good-end', type: 'end', result: 'good' },
      { id: 'bad-end', type: 'end', result: { broken: () => 'nope' } },
    ],
  };
  // Input selects the good branch; the bad end is never visited but still
  // rejected at validation time.
  assert.throws(() => executeWorkflow(workflow, { route: 'good' }), /end node bad-end/);
  assert.throws(() => validateWorkflow(workflow), /end node bad-end/);
});

test('an entry-unreachable end node with an uncloneable result is still checked', () => {
  const workflow = {
    id: 'unreachable-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'orphan-end', type: 'end', result: { fn: () => 'nope' } },
    ],
  };
  assert.throws(() => validateWorkflow(workflow), /end node orphan-end/);
});

// ---------------------------------------------------------------------------
// End results whose structured clone retains shared memory
// ---------------------------------------------------------------------------

// A compensable business action precedes the end: when definition validation
// rejects the result, that action and its compensation must never be invoked.
function businessBeforeEndWorkflow(endResult) {
  return {
    id: 'business-before-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'early' },
      {
        id: 'early', type: 'action', operation: 'opEarly',
        compensation: { operation: 'undoEarly' }, next: 'finish',
      },
      { id: 'finish', type: 'end', result: endResult },
    ],
  };
}

function assertEndSharedMemoryError(error, nodeId = 'finish') {
  assert.ok(error instanceof Error, 'a definition error (plain Error) is thrown/rejected');
  assert.ok(!(error instanceof TypeError), 'shared-memory end results are a definition error, not a TypeError');
  assert.match(error.message, new RegExp(`end node ${nodeId}: result contains shared memory`));
  assert.match(error.message, /SharedArrayBuffer/);
  assert.match(error.message, /independent copies cannot be guaranteed/);
}

// Every result below retains shared memory in the content its structured clone
// actually saves.
function sharedResults() {
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

test('validateWorkflow rejects an end result whose clone retains shared memory, naming the end node', () => {
  for (const make of sharedResults()) {
    assert.throws(
      () => validateWorkflow(linearEndWorkflow(make())),
      error => {
        assertEndSharedMemoryError(error);
        return true;
      },
    );
  }
});

test('cycles and repeated references in an end result never bypass the shared-memory check', () => {
  // Shared bytes reachable only through a cycle edge.
  const a = { name: 'a' };
  const b = { name: 'b' };
  a.peer = b;
  b.peer = a;
  b.bytes = new SharedArrayBuffer(4);
  assert.throws(() => validateWorkflow(linearEndWorkflow(a)), /end node finish/);

  // The same shared buffer aliased through many slots is still found once.
  const shared = new SharedArrayBuffer(4);
  const root = { x: [shared], y: { z: shared } };
  root.loop = root;
  assert.throws(() => validateWorkflow(linearEndWorkflow(root)), /result contains shared memory/);
});

test('the synchronous entry throws the shared-memory definition error before any node executes', () => {
  for (const make of sharedResults()) {
    assert.throws(
      () => executeWorkflow(linearEndWorkflow(make()), {}),
      error => {
        assertEndSharedMemoryError(error);
        return true;
      },
    );
  }
});

test('the asynchronous entry rejects the returned promise, never reporting action_failed or compensation failure', async () => {
  let businessCalls = 0;
  let compensationCalls = 0;
  const operations = {
    opEarly: () => { businessCalls += 1; return 'early'; },
    undoEarly: () => { compensationCalls += 1; return 'undone'; },
  };
  for (const make of sharedResults()) {
    await assert.rejects(
      () => executeWorkflowAsync(businessBeforeEndWorkflow(make()), {}, operations),
      error => {
        assertEndSharedMemoryError(error);
        return true;
      },
    );
  }
  assert.equal(businessCalls, 0);
  assert.equal(compensationCalls, 0);
});

test('an already-aborted signal does not turn the end-result rejection into a cancelled run', async () => {
  const controller = new AbortController();
  controller.abort();
  let businessCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(
      businessBeforeEndWorkflow(new SharedArrayBuffer(4)),
      {},
      { opEarly: () => { businessCalls += 1; return 'early'; }, undoEarly: () => 'u' },
      { signal: controller.signal },
    ),
    error => {
      assertEndSharedMemoryError(error);
      return true;
    },
  );
  assert.equal(businessCalls, 0);
});

test('shared-memory end results on untaken branches and entry-unreachable end nodes are checked too', () => {
  const untaken = {
    id: 'untaken-end-branch', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-end', else: 'bad-end',
      },
      { id: 'good-end', type: 'end', result: 'good' },
      { id: 'bad-end', type: 'end', result: { bytes: new SharedArrayBuffer(4) } },
    ],
  };
  assert.throws(() => validateWorkflow(untaken), /end node bad-end/);
  assert.throws(() => executeWorkflow(untaken, { route: 'good' }), /end node bad-end/);

  const unreachable = {
    id: 'unreachable-shared-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'orphan-end', type: 'end', result: new DataView(new SharedArrayBuffer(4)) },
    ],
  };
  assert.throws(() => validateWorkflow(unreachable), /end node orphan-end/);
});

test('an end result carrying both a function and shared memory reports the cloneability failure first', () => {
  const workflow = linearEndWorkflow({ fn: () => 'nope', bytes: new SharedArrayBuffer(4) });
  assert.throws(
    () => validateWorkflow(workflow),
    /end node finish: result must be a structured-cloneable value/,
  );
});

test('shared bytes in clone-dropped properties (Date/RegExp auxiliaries, non-enumerable and symbol keys) leave the result legal', () => {
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

  const result = {
    date, customDate, regexp, customRegexp, plainBuffer, view,
    errorWithAux, nonEnumerable, list, holey, symboled, boxed,
    keep: new Uint8Array([7, 8]),
  };

  const workflow = linearEndWorkflow(result);
  assert.doesNotThrow(() => validateWorkflow(workflow));

  const run = executeWorkflow(workflow, {});
  assert.equal(run.status, 'completed');
  const saved = run.result;
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
  assert.ok(result.date.aux instanceof SharedArrayBuffer);
  assert.ok(result.plainBuffer.dropped instanceof SharedArrayBuffer);
});

test('a shared buffer carried only in an Error non-cause own property is dropped and the result is legal', () => {
  const result = new Error('saved normally');
  result.info = { bytes: new SharedArrayBuffer(4) };
  result.cause = 'ordinary cause';
  const workflow = linearEndWorkflow(result);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  const run = executeWorkflow(workflow, {});
  assert.equal(run.status, 'completed');
  assert.ok(run.result instanceof Error);
  assert.equal(run.result.message, 'saved normally');
  assert.equal(run.result.cause, 'ordinary cause');
  assert.equal(run.result.info, undefined);
});

test('an enumerable getter in the end result is read once by the validation clone and judged on that value', () => {
  let rejectingReads = 0;
  const sharedFirst = {
    get flip() {
      rejectingReads += 1;
      return rejectingReads === 1 ? new SharedArrayBuffer(4) : 'ordinary';
    },
  };
  assert.throws(() => validateWorkflow(linearEndWorkflow(sharedFirst)), /result contains shared memory/);
  assert.equal(rejectingReads, 1, 'the getter is read exactly once during validation');

  let acceptedReads = 0;
  const ordinaryFirst = {
    get flip() {
      acceptedReads += 1;
      return acceptedReads === 1 ? 'ordinary' : new SharedArrayBuffer(4);
    },
  };
  assert.doesNotThrow(() => validateWorkflow(linearEndWorkflow(ordinaryFirst)));
  assert.equal(acceptedReads, 1, 'the getter is read exactly once during validation');
});

test('a custom Map/Set iterator in the end result cannot hide real shared members or fabricate shared ones', () => {
  const hiddenMap = new Map([['real', new SharedArrayBuffer(2)]]);
  hiddenMap[Symbol.iterator] = function* hidden() { yield ['fake', 1]; };
  assert.throws(() => validateWorkflow(linearEndWorkflow({ map: hiddenMap })), /shared memory/);

  const emptySet = new Set([new SharedArrayBuffer(2)]);
  emptySet[Symbol.iterator] = function* empty() {};
  assert.throws(() => validateWorkflow(linearEndWorkflow({ set: emptySet })), /shared memory/);

  const fabricatedMap = new Map([['real', 1]]);
  fabricatedMap[Symbol.iterator] = function* fake() { yield ['fabricated', new SharedArrayBuffer(2)]; };
  const fabricatedSet = new Set([1, 2]);
  fabricatedSet[Symbol.iterator] = function* fake() { yield new SharedArrayBuffer(2); };
  for (const value of [{ map: fabricatedMap }, { set: fabricatedSet }]) {
    const workflow = linearEndWorkflow(value);
    assert.doesNotThrow(() => validateWorkflow(workflow));
    const run = executeWorkflow(workflow, {});
    assert.equal(run.status, 'completed');
    assert.equal(
      run.result.map ? run.result.map.get('real') : [...run.result.set].join(','),
      run.result.map ? 1 : '1,2',
    );
  }
});

test('shared buffers and views produced in another realm are rejected in end results too', async () => {
  const vm = await import('node:vm');
  const realm = vm.createContext({});
  const remote = code => vm.runInContext(code, realm);
  for (const value of [
    remote('new SharedArrayBuffer(4)'),
    remote('new Uint8Array(new SharedArrayBuffer(4))'),
    remote('new DataView(new SharedArrayBuffer(4))'),
    { bytes: remote('new Uint8Array(new SharedArrayBuffer(4))') },
    new Map([['k', remote('new SharedArrayBuffer(4)')]]),
  ]) {
    assert.throws(
      () => validateWorkflow(linearEndWorkflow(value)),
      /result contains shared memory/,
    );
  }
});

test('a plain ArrayBuffer end result and views over one are copied byte-for-byte and stay independent', () => {
  const workflow = linearEndWorkflow(Uint8Array.from([9, 8, 7, 6]).buffer);
  const definitionBuffer = workflow.nodes[1].result;

  const first = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');
  assert.ok(first.result instanceof ArrayBuffer);
  assert.ok(!(first.result instanceof SharedArrayBuffer));
  assert.notEqual(first.result, definitionBuffer);
  assert.deepEqual([...new Uint8Array(first.result)], [9, 8, 7, 6]);

  // Rewriting the returned bytes cannot reach the definition.
  new Uint8Array(first.result).fill(1);
  assert.deepEqual([...new Uint8Array(definitionBuffer)], [9, 8, 7, 6]);

  // A second run gets its own copy of the untouched configured bytes.
  const second = executeWorkflow(workflow, {});
  assert.deepEqual([...new Uint8Array(second.result)], [9, 8, 7, 6]);
  assert.notEqual(second.result, first.result);
  assert.notEqual(second.result, definitionBuffer);
});

test('typed-view end results keep their type and bytes and do not share storage', () => {
  const workflow = linearEndWorkflow(new Uint16Array([258, 1000]));
  const definitionView = workflow.nodes[1].result;

  const run = executeWorkflow(workflow, {});
  assert.ok(run.result instanceof Uint16Array);
  assert.notEqual(run.result, definitionView);
  assert.notEqual(run.result.buffer, definitionView.buffer);
  assert.deepEqual([...run.result], [258, 1000]);

  run.result[0] = 0;
  assert.equal(definitionView[0], 258);
  assert.deepEqual([...executeWorkflow(workflow, {}).result], [258, 1000]);
});

test('structured legal end results preserve types, bytes and circular/repeated references', async () => {
  const bytes = new ArrayBuffer(4);
  new Uint8Array(bytes).set([1, 2, 3, 4]);
  const view = new Uint16Array(new ArrayBuffer(4));
  new Uint8Array(view.buffer).set([5, 6, 7, 8]);
  const detail = { id: 'detail' };
  const result = {
    bytes, view, detail, when: new Date('2020-02-03T04:05:06.000Z'), pattern: /ok/gi,
  };
  result.self = result;
  result.again = detail;
  result.list = [detail];

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

  const workflow = linearEndWorkflow(result);
  assertSaved(executeWorkflow(workflow, {}).result);
  assertSaved((await executeWorkflowAsync(workflow, {})).result);

  // The definition and the caller's objects are never mutated.
  assert.equal(workflow.nodes[1].result, result);
  assert.equal(workflow.nodes[1].result.bytes, bytes);
});

// ---------------------------------------------------------------------------
// The independent-copy promise is re-established at the end node's own
// execution moment. Validation only reads the configured result once; the
// value the end node actually reads later can differ — an enumerable getter
// can change its answer, and an earlier asynchronous business operation can
// mutate the shared workflow definition — so only content the execution-time
// clone independently copies may be recorded as a successful result.
// ---------------------------------------------------------------------------

test('an enumerable getter that returns shared memory on the execution-time read rejects the synchronous run', () => {
  let reads = 0;
  const flips = {
    get bytes() {
      reads += 1;
      return reads === 1 ? new Uint8Array([1, 2]) : new Uint8Array(new SharedArrayBuffer(4));
    },
  };
  const workflow = linearEndWorkflow(flips);
  // Validation accepted the ordinary value the getter returned the first
  // time, and read it exactly once.
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.equal(reads, 1);

  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => {
      assertEndSharedMemoryError(error);
      return true;
    },
  );
  // The execution-time clone is the only extra read: it must not traverse
  // the original a second time or otherwise change the getter's order.
  assert.equal(reads, 2);
});

test('the asynchronous entry rejects (never completes) when a getter answers shared memory at execution', async () => {
  let reads = 0;
  const flips = {
    get view() {
      reads += 1;
      return reads === 1 ? 'ordinary' : new DataView(new SharedArrayBuffer(4));
    },
  };
  const workflow = businessBeforeEndWorkflow(flips);
  let businessCalls = 0;
  let compensationCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      opEarly: () => { businessCalls += 1; return 'early'; },
      undoEarly: () => { compensationCalls += 1; return 'undone'; },
    }),
    error => {
      assertEndSharedMemoryError(error);
      return true;
    },
  );
  // The earlier business action did run, but the end-result error is not a
  // business failure: it never completes and never triggers compensation.
  assert.equal(businessCalls, 1);
  assert.equal(compensationCalls, 0);
});

test('an earlier business operation swapping a plain buffer for a shared one rejects the run', async () => {
  const workflow = {
    id: 'op-swap-shared', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'mutate' },
      { id: 'mutate', type: 'action', operation: 'mutate', next: 'finish' },
      { id: 'finish', type: 'end', result: { bytes: new Uint8Array([1, 2, 3, 4]), nested: { buf: new ArrayBuffer(2) } } },
    ],
  };
  let compensationCalls = 0;
  const mutate = () => {
    workflow.nodes[3].result.bytes = new Uint8Array(new SharedArrayBuffer(4));
    workflow.nodes[3].result.nested.buf = new SharedArrayBuffer(2);
    return 'mutated';
  };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      opA: () => 'A',
      mutate,
      undoA: () => { compensationCalls += 1; return 'undone'; },
    }),
    error => {
      assertEndSharedMemoryError(error);
      return true;
    },
  );
  assert.equal(compensationCalls, 0, 'an end-result error is not action_failed and does not compensate');
});

test('an earlier operation replacing an end property with a function rejects with the cloneability error', async () => {
  const workflow = {
    id: 'op-swap-fn', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'mutate' },
      { id: 'mutate', type: 'action', operation: 'mutate', next: 'finish' },
      { id: 'finish', type: 'end', result: { payload: 'ready' } },
    ],
  };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      mutate: () => { workflow.nodes[2].result.promise = () => 'nope'; return 'mutated'; },
    }),
    /end node finish: result must be a structured-cloneable value/,
  );
});

test('a function that appears only in the execution-time clone is reported without leaking the DOMException', () => {
  let reads = 0;
  const flips = {
    get hook() {
      reads += 1;
      return reads === 1 ? 'ordinary' : () => 'nope';
    },
  };
  const workflow = linearEndWorkflow(flips);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /end node finish: result must be a structured-cloneable value/);
      return true;
    },
  );
});

test('a value getter that throws when the end node reads it is reported as that end node result error', () => {
  let reads = 0;
  const flips = {
    get value() {
      reads += 1;
      if (reads > 1) throw new Error('getter boom');
      return 'ordinary';
    },
  };
  const workflow = linearEndWorkflow(flips);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () => executeWorkflow(workflow, {}),
    /end node finish: result must be a structured-cloneable value/,
  );

  // The same applies to an accessor defined directly on the end node: its
  // throw at the execution-time read must not escape the engine raw either.
  // Validation reads it twice (the undefined check and its own clone), so it
  // answers ordinarily for those and throws only on the third read.
  let nodeReads = 0;
  const node = { id: 'done', type: 'end' };
  Object.defineProperty(node, 'result', {
    enumerable: true, configurable: true,
    get() {
      nodeReads += 1;
      if (nodeReads > 2) throw new Error('node accessor boom');
      return 'ordinary';
    },
  });
  const nodeWorkflow = {
    id: 'node-accessor-throws', entry: 'start',
    nodes: [{ id: 'start', type: 'trigger', next: 'done' }, node],
  };
  // executeWorkflow's own validation is the first read; the end node's
  // execution-time read is the second and throws.
  assert.throws(
    () => executeWorkflow(nodeWorkflow, {}),
    /end node done: result must be a structured-cloneable value/,
  );
});

test('an execution-time value carrying both an uncloneable value and shared memory reports the clone failure first', () => {
  let aReads = 0;
  let bReads = 0;
  const flips = {
    get a() { aReads += 1; return aReads === 1 ? 'ok' : () => 'nope'; },
    get b() { bReads += 1; return bReads === 1 ? 'ok' : new SharedArrayBuffer(4); },
  };
  const workflow = linearEndWorkflow(flips);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () => executeWorkflow(workflow, {}),
    /end node finish: result must be a structured-cloneable value/,
  );
});

test('shared memory placed only in clone-dropped properties at execution time still completes', async () => {
  const result = { when: new Date(0), pattern: /ok/, list: [1, 2], keep: new Uint8Array([3, 4]) };
  const workflow = {
    id: 'dropped-at-execution', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'mutate' },
      { id: 'mutate', type: 'action', operation: 'mutate', next: 'finish' },
      { id: 'finish', type: 'end', result },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    mutate: () => {
      result.when.aux = new SharedArrayBuffer(4);
      result.pattern.aux = new SharedArrayBuffer(4);
      Object.defineProperty(result.list, 'hidden', { value: new SharedArrayBuffer(4), enumerable: false });
      return 'mutated';
    },
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.when.aux, undefined);
  assert.equal(run.result.pattern.aux, undefined);
  assert.equal(Object.hasOwn(run.result.list, 'hidden'), false);
  assert.deepEqual([...run.result.keep], [3, 4]);
});

test('the recorded result is the value the clone captured at the end node execution moment, not the validation value', async () => {
  let reads = 0;
  const flips = {
    get phase() { reads += 1; return reads === 1 ? 'validation' : 'execution'; },
  };
  const workflow = linearEndWorkflow(flips);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  const run = executeWorkflow(workflow, {});
  assert.equal(run.status, 'completed');
  assert.equal(run.result.phase, 'execution');
});

test('an end recorded first keeps its independent copy when a later activated branch mutates the definition', async () => {
  // The end node is declared before the slow branch's action, so it executes
  // and records first; the branch then replaces the configured bytes with a
  // shared buffer. The recorded result was already judged and copied, so the
  // run still completes with independent bytes.
  const workflow = {
    id: 'recorded-before-swap', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: { bytes: new Uint8Array([5, 6, 7, 8]) } },
      { id: 'work', type: 'action', operation: 'work', next: 'finish' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    work: () => {
      workflow.nodes[1].result.bytes = new Uint8Array(new SharedArrayBuffer(4));
      return 'done';
    },
  });
  assert.equal(run.status, 'completed');
  assert.ok(run.result.bytes instanceof Uint8Array);
  assert.ok(!(run.result.bytes.buffer instanceof SharedArrayBuffer));
  assert.deepEqual([...run.result.bytes], [5, 6, 7, 8]);
  run.result.bytes[0] = 99;
  assert.deepEqual([...new Uint8Array(workflow.nodes[1].result.bytes)], [0, 0, 0, 0]);
});

test('mutating returned nested objects, arrays and plain buffer bytes never reaches the definition', () => {
  const workflow = linearEndWorkflow({
    nested: { a: { b: [1, 2, { c: 3 }] } },
    bytes: Uint8Array.from([9, 8, 7, 6]).buffer,
    views: [new Uint16Array([258]), new DataView(new ArrayBuffer(2))],
  });
  const definition = workflow.nodes[1].result;
  const run = executeWorkflow(workflow, {});
  assert.equal(run.status, 'completed');

  run.result.nested.a.b[2].c = 99;
  run.result.nested.a.b.push(4);
  delete run.result.nested.a.b[0];
  new Uint8Array(run.result.bytes).fill(1);
  run.result.views[0][0] = 0;
  new Uint8Array(run.result.views[1].buffer).fill(255);

  assert.deepEqual(definition.nested.a.b, [1, 2, { c: 3 }]);
  assert.deepEqual([...new Uint8Array(definition.bytes)], [9, 8, 7, 6]);
  assert.equal(definition.views[0][0], 258);
  assert.deepEqual([...new Uint8Array(definition.views[1].buffer)], [0, 0]);
});
