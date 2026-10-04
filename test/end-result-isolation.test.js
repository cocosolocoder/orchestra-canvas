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

// ===========================================================================
// End results containing shared memory
// ===========================================================================

// A workflow with business work a shared-memory definition error must never
// reach: a compensable action on one branch, the end node under test shared by
// both branches.
function businessThenEndWorkflow(endResult) {
  return {
    id: 'business-then-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'early'] },
      {
        id: 'early', type: 'action', operation: 'opEarly',
        compensation: { operation: 'undoEarly' }, next: 'finish',
      },
      { id: 'finish', type: 'end', result: endResult },
    ],
  };
}

function assertResultSharedMemoryError(error, nodeId = 'finish') {
  assert.ok(error instanceof Error, 'a definition error (plain Error) is thrown/rejected');
  assert.ok(!(error instanceof TypeError), 'a shared-memory end result is a definition error, not a TypeError');
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

test('validateWorkflow rejects every result whose clone retains shared memory, naming the end node', () => {
  for (const make of sharedResults()) {
    assert.throws(
      () => validateWorkflow(linearEndWorkflow(make())),
      error => {
        assertResultSharedMemoryError(error);
        return true;
      },
    );
  }
});

test('every typed-array kind backed by shared memory is rejected as an end result', () => {
  const sharedBacked = [
    () => new Int8Array(new SharedArrayBuffer(4)),
    () => new Uint8ClampedArray(new SharedArrayBuffer(4)),
    () => new Int16Array(new SharedArrayBuffer(4)),
    () => new Uint16Array(new SharedArrayBuffer(4)),
    () => new Uint32Array(new SharedArrayBuffer(8)),
    () => new Float32Array(new SharedArrayBuffer(8)),
    () => new BigUint64Array(new SharedArrayBuffer(8)),
  ];
  for (const make of sharedBacked) {
    assert.throws(() => validateWorkflow(linearEndWorkflow(make())), /end node finish: result contains shared memory/);
  }
});

test('the check judges the cloned result: cycles and repeated references never bypass it', () => {
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

test('the synchronous entry throws the definition error before any node executes', () => {
  for (const make of sharedResults()) {
    assert.throws(
      () => executeWorkflow(linearEndWorkflow(make()), {}),
      error => {
        assertResultSharedMemoryError(error);
        return true;
      },
    );
  }
});

test('the asynchronous entry rejects the returned Promise: never action_failed, no trace, attempts or compensation', async () => {
  let businessCalls = 0;
  let compensationCalls = 0;
  const operations = {
    opEarly: () => { businessCalls += 1; return 'early'; },
    undoEarly: () => { compensationCalls += 1; return 'undone'; },
  };
  for (const make of sharedResults()) {
    let outcome;
    try {
      outcome = await executeWorkflowAsync(businessThenEndWorkflow(make()), {}, operations);
    } catch (error) {
      assertResultSharedMemoryError(error);
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
      businessThenEndWorkflow(new SharedArrayBuffer(4)),
      {},
      { opEarly: () => { businessCalls += 1; return 'early'; }, undoEarly: () => 'u' },
      { signal: controller.signal },
    ),
    error => {
      assertResultSharedMemoryError(error);
      return true;
    },
  );
  assert.equal(businessCalls, 0);
});

test('end nodes on untaken branches and entry-unreachable ends with shared memory are checked too', () => {
  const untaken = {
    id: 'untaken-shared-branch',
    entry: 'start',
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
  // Input selects the good branch; the bad end is never visited but still
  // rejected at validation time.
  assert.throws(() => executeWorkflow(untaken, { route: 'good' }), /end node bad-end/);
  assert.throws(() => validateWorkflow(untaken), /end node bad-end/);

  const unreachable = {
    id: 'unreachable-shared-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'orphan-end', type: 'end', result: new Uint8Array(new SharedArrayBuffer(4)) },
    ],
  };
  assert.throws(() => validateWorkflow(unreachable), /end node orphan-end/);
});

test('a shared-memory end on an untaken branch still rejects the async entry before any operation or compensation', async () => {
  let businessCalls = 0;
  let compensationCalls = 0;
  const workflow = {
    id: 'untaken-async',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-work', else: 'bad-end',
      },
      {
        id: 'good-work', type: 'action', operation: 'opGood',
        compensation: { operation: 'undoGood' }, next: 'good-end',
      },
      { id: 'good-end', type: 'end', result: 'good' },
      // Never visited (input selects the good branch), but still rejected.
      { id: 'bad-end', type: 'end', result: new DataView(new SharedArrayBuffer(4)) },
    ],
  };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'good' }, {
      opGood: () => { businessCalls += 1; return 'G'; },
      undoGood: () => { compensationCalls += 1; return 'u'; },
    }),
    error => {
      assertResultSharedMemoryError(error, 'bad-end');
      return true;
    },
  );
  assert.equal(businessCalls, 0);
  assert.equal(compensationCalls, 0);
});

test('a result that both cannot be cloned and contains shared memory reports the cloneability failure first', () => {
  const workflow = linearEndWorkflow({ fn: () => 'nope', bytes: new SharedArrayBuffer(4) });
  assert.throws(() => validateWorkflow(workflow), /end node finish: result must be a structured-cloneable value/);
});

// ---------------------------------------------------------------------------
// Shared memory placed only where cloning drops it never condemns legal results
// ---------------------------------------------------------------------------

test('shared bytes in clone-dropped properties (Date/RegExp/ArrayBuffer/Error auxiliaries, non-enumerable and symbol keys) are accepted', () => {
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

test('a Date or RegExp result itself carrying shared bytes in an attached property stays legal, keeping only the internal value', () => {
  const date = new Date('2021-06-07T08:09:10.000Z');
  date.aux = new SharedArrayBuffer(8);
  Object.defineProperty(date, 'hidden', { value: new SharedArrayBuffer(4), enumerable: false });
  const dateRun = executeWorkflow(linearEndWorkflow(date), {});
  assert.equal(dateRun.status, 'completed');
  assert.ok(dateRun.result instanceof Date, 'the result keeps its Date type, never stringified');
  assert.equal(dateRun.result.getTime(), date.getTime());
  assert.equal(dateRun.result.aux, undefined);
  assert.equal(Object.hasOwn(dateRun.result, 'hidden'), false);
  date.setTime(0);
  assert.equal(dateRun.result.getTime(), Date.parse('2021-06-07T08:09:10.000Z'));

  const regexp = /pattern/gi;
  regexp.shared = new SharedArrayBuffer(4);
  const regexpRun = executeWorkflow(linearEndWorkflow(regexp), {});
  assert.ok(regexpRun.result instanceof RegExp, 'the result keeps its RegExp type');
  assert.equal(regexpRun.result.source, 'pattern');
  assert.equal(regexpRun.result.flags, 'gi');
  assert.equal(regexpRun.result.shared, undefined);
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

// ---------------------------------------------------------------------------
// The judgment is made on the validation clone's own reads
// ---------------------------------------------------------------------------

test('an enumerable getter is read by the validation clone exactly once and judged on that value', () => {
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

test('a getter that consistently yields an ordinary value is judged and saved on that value', () => {
  let reads = 0;
  const result = {
    get flip() {
      reads += 1;
      return { answer: 7 };
    },
  };
  const workflow = linearEndWorkflow(result);
  // One run takes exactly two clones — one at validation, one at the end
  // node's execution moment — and the shared-memory traversal adds no read of
  // its own (the clone already materialized the getter's value as data).
  const run = executeWorkflow(workflow, {});
  assert.equal(reads, 2);
  assert.deepEqual(run.result.flip, { answer: 7 });
  // The saved copy is independent of anything a later read might produce.
  run.result.flip.answer = 99;
  assert.deepEqual(executeWorkflow(workflow, {}).result.flip, { answer: 7 });
});

test('a custom Map/Set iterator cannot hide real shared members or fabricate shared ones', () => {
  const hiddenMap = new Map([['real', new SharedArrayBuffer(2)]]);
  hiddenMap[Symbol.iterator] = function* hidden() { yield ['fake', 1]; };
  assert.throws(
    () => validateWorkflow(linearEndWorkflow({ map: hiddenMap })),
    /result contains shared memory/,
  );

  const emptySet = new Set([new SharedArrayBuffer(2)]);
  emptySet[Symbol.iterator] = function* empty() {};
  assert.throws(
    () => validateWorkflow(linearEndWorkflow({ set: emptySet })),
    /result contains shared memory/,
  );

  const fabricatedMap = new Map([['real', 1]]);
  fabricatedMap[Symbol.iterator] = function* fake() { yield ['fabricated', new SharedArrayBuffer(2)]; };
  const fabricatedSet = new Set([1, 2]);
  fabricatedSet[Symbol.iterator] = function* fake() { yield new SharedArrayBuffer(2); };
  for (const result of [{ map: fabricatedMap }, { set: fabricatedSet }]) {
    const workflow = linearEndWorkflow(result);
    assert.doesNotThrow(() => validateWorkflow(workflow));
    const run = executeWorkflow(workflow, {});
    assert.equal(run.status, 'completed');
    const saved = run.result;
    assert.equal(saved.map ? saved.map.get('real') : [...saved.set].join(','), saved.map ? 1 : '1,2');
  }
});

test('shared buffers and views produced in another realm are rejected too', async () => {
  const vm = await import('node:vm');
  const realm = vm.createContext({});
  const remote = code => vm.runInContext(code, realm);
  for (const result of [
    remote('new SharedArrayBuffer(4)'),
    remote('new Uint8Array(new SharedArrayBuffer(4))'),
    remote('new DataView(new SharedArrayBuffer(4))'),
    { bytes: remote('new Uint8Array(new SharedArrayBuffer(4))') },
    new Map([['k', remote('new SharedArrayBuffer(4)')]]),
  ]) {
    assert.throws(
      () => validateWorkflow(linearEndWorkflow(result)),
      /result contains shared memory/,
    );
  }
  // A cross-realm plain ArrayBuffer view is accepted.
  const workflow = linearEndWorkflow({ bytes: remote('new Uint8Array([1, 2, 3])') });
  const run = executeWorkflow(workflow, {});
  assert.equal(run.status, 'completed');
  assert.deepEqual([...run.result.bytes], [1, 2, 3]);
});

test('a shadowed own "buffer" property cannot hide a shared backing store', () => {
  const sharedView = new Uint8Array(new SharedArrayBuffer(8));
  Object.defineProperty(sharedView, 'buffer', {
    value: new ArrayBuffer(8), configurable: true, enumerable: true,
  });
  const sharedDataView = new DataView(new SharedArrayBuffer(4));
  Object.defineProperty(sharedDataView, 'buffer', {
    value: new ArrayBuffer(4), configurable: true, enumerable: true,
  });
  for (const result of [sharedView, sharedDataView, { nested: [new Map([['k', sharedView]])] }]) {
    assert.throws(() => validateWorkflow(linearEndWorkflow(result)), /result contains shared memory/);
  }

  // The reverse spoof — a plain-backed view claiming a shared buffer — is a
  // legal result and completes.
  const plainView = new Uint8Array(new ArrayBuffer(4));
  Object.defineProperty(plainView, 'buffer', {
    value: new SharedArrayBuffer(4), configurable: true, enumerable: true,
  });
  const workflow = linearEndWorkflow(plainView);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  const run = executeWorkflow(workflow, {});
  assert.ok(run.result.buffer instanceof ArrayBuffer);
});

// ---------------------------------------------------------------------------
// Plain ArrayBuffers and legal results keep working as end results
// ---------------------------------------------------------------------------

test('a plain ArrayBuffer result and views over it keep type and bytes and stay independent across the definition, runs and the caller', () => {
  const buffer = new ArrayBuffer(4);
  new Uint8Array(buffer).set([9, 8, 7, 6]);
  const heldView = new Uint16Array(new ArrayBuffer(4));
  new Uint8Array(heldView.buffer).set([5, 6, 7, 8]);
  const heldDataView = new DataView(new ArrayBuffer(2));
  new Uint8Array(heldDataView.buffer).set([3, 4]);

  const workflow = linearEndWorkflow({ buffer, view: heldView, dv: heldDataView });
  const first = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');
  const saved = first.result;
  assert.ok(saved.buffer instanceof ArrayBuffer);
  assert.ok(!(saved.buffer instanceof SharedArrayBuffer));
  assert.ok(saved.view instanceof Uint16Array);
  assert.ok(saved.dv instanceof DataView);
  // The returned storage is disjoint from the definition's storage.
  assert.notEqual(saved.buffer, workflow.nodes[1].result.buffer);
  assert.notEqual(saved.view.buffer, workflow.nodes[1].result.view.buffer);
  assert.deepEqual([...new Uint8Array(saved.buffer)], [9, 8, 7, 6]);
  assert.deepEqual([...new Uint8Array(saved.view.buffer)], [5, 6, 7, 8]);
  assert.deepEqual([...new Uint8Array(saved.dv.buffer)], [3, 4]);

  // Rewriting the returned bytes cannot reach the definition or another run.
  new Uint8Array(saved.buffer).fill(1);
  new Uint8Array(saved.view.buffer).fill(2);
  assert.deepEqual([...new Uint8Array(workflow.nodes[1].result.buffer)], [9, 8, 7, 6]);
  assert.deepEqual([...new Uint8Array(workflow.nodes[1].result.view.buffer)], [5, 6, 7, 8]);

  const second = executeWorkflow(workflow, {});
  assert.deepEqual([...new Uint8Array(second.result.buffer)], [9, 8, 7, 6]);
  assert.notEqual(second.result.buffer, saved.buffer);

  // A bare ArrayBuffer / typed array result works at the top level too.
  const direct = linearEndWorkflow(Uint8Array.from([9, 8, 7, 6]).buffer);
  const directRun = executeWorkflow(direct, {});
  assert.ok(directRun.result instanceof ArrayBuffer);
  assert.ok(!(directRun.result instanceof SharedArrayBuffer));
  assert.deepEqual([...new Uint8Array(directRun.result)], [9, 8, 7, 6]);
  new Uint8Array(directRun.result)[0] = 99;
  assert.deepEqual([...new Uint8Array(direct.nodes[1].result)], [9, 8, 7, 6]);
});

test('structured legal results preserve types, bytes, circular and repeated references through both entries', async () => {
  const bytes = new ArrayBuffer(4);
  new Uint8Array(bytes).set([1, 2, 3, 4]);
  const detail = { id: 'detail' };
  const result = {
    bytes, detail, when: new Date('2020-02-03T04:05:06.000Z'), pattern: /ok/gi,
    table: new Map([['row', detail]]), bag: new Set([detail]),
  };
  result.self = result;
  result.again = detail;
  result.list = [detail];

  const assertSaved = saved => {
    assert.ok(saved.bytes instanceof ArrayBuffer);
    assert.notEqual(saved.bytes, bytes);
    assert.deepEqual([...new Uint8Array(saved.bytes)], [1, 2, 3, 4]);
    assert.ok(saved.when instanceof Date);
    assert.ok(saved.pattern instanceof RegExp);
    assert.equal(saved.self, saved);
    assert.equal(saved.again, saved.detail);
    assert.equal(saved.list[0], saved.detail);
    assert.equal(saved.table.get('row'), saved.detail);
    assert.equal([...saved.bag][0], saved.detail);
  };

  const workflow = linearEndWorkflow(result);
  assertSaved(executeWorkflow(workflow, {}).result);
  assertSaved((await executeWorkflowAsync(workflow, {})).result);

  // The definition and its objects are never mutated by the returned copy.
  assert.equal(workflow.nodes[1].result, result);
  assert.equal(workflow.nodes[1].result.bytes, bytes);
  const sync = executeWorkflow(workflow, {});
  new Uint8Array(sync.result.bytes).fill(9);
  sync.result.detail.id = 'edited';
  assert.deepEqual([...new Uint8Array(result.bytes)], [1, 2, 3, 4]);
  assert.equal(result.detail.id, 'detail');
});
