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

// An end whose only predecessor runs before it: the end depends on the
// action, so a business operation can change the configured result and the
// change is observed when the end actually executes.
function actionBeforeEndWorkflow(endResult, actionProps = {}) {
  return {
    id: 'action-before-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'work', next: 'finish', ...actionProps },
      { id: 'finish', type: 'end', result: endResult, dependsOn: ['work'] },
    ],
  };
}

// A compensable action preceding the end, used to prove an end-result
// rejection spends no action retries and runs no compensation.
function compensableBeforeEndWorkflow(endResult) {
  return {
    id: 'compensable-before-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA' },
        retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        next: 'finish',
      },
      { id: 'finish', type: 'end', result: endResult },
    ],
  };
}

function assertEndResultError(error, nodeId, kind) {
  assert.ok(error instanceof Error, 'an Error is thrown/rejected');
  assert.ok(!(error instanceof TypeError), 'an end-result failure is a plain Error, not a TypeError');
  if (kind === 'shared') {
    assert.match(error.message, new RegExp(`end node ${nodeId}: result contains shared memory`));
    assert.match(error.message, /SharedArrayBuffer/);
    assert.match(error.message, /independent copies cannot be guaranteed/);
  } else {
    assert.match(error.message, new RegExp(`end node ${nodeId}: result must be a structured-cloneable value`));
  }
}

// An enumerable value property whose answer changes between reads: the first
// read (the validation clone) gets `first`, every later read gets `later`.
function flippingProperty(first, later) {
  let reads = 0;
  return {
    object: {
      get flip() {
        reads += 1;
        return reads === 1 ? first : later;
      },
    },
    reads: () => reads,
  };
}

// ---------------------------------------------------------------------------
// Shared memory that only appears when the end node actually executes
// ---------------------------------------------------------------------------

test('a getter returning ordinary data at validation but shared memory at execution makes the synchronous entry throw', () => {
  const { object } = flippingProperty('ordinary', new SharedArrayBuffer(4));
  const workflow = linearEndWorkflow(object);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => {
      assertEndResultError(error, 'finish', 'shared');
      return true;
    },
  );
});

test('the asynchronous entry rejects the returned promise, never reporting completed', async () => {
  const { object } = flippingProperty('ordinary', new Uint8Array(new SharedArrayBuffer(4)));
  const workflow = actionBeforeEndWorkflow(object);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { work: () => 'done' }),
    error => {
      assertEndResultError(error, 'finish', 'shared');
      return true;
    },
  );
});

test('a preceding business operation swapping a plain buffer for a shared one rejects the run', async () => {
  const workflow = actionBeforeEndWorkflow({ bytes: new Uint8Array([1, 2, 3]), view: new DataView(new ArrayBuffer(2)) });
  const execution = executeWorkflowAsync(workflow, {}, {
    work: () => {
      workflow.nodes[2].result.bytes = new Uint8Array(new SharedArrayBuffer(3));
      workflow.nodes[2].result.view = new DataView(new SharedArrayBuffer(2));
      return 'done';
    },
  });
  await assert.rejects(execution, error => {
    assertEndResultError(error, 'finish', 'shared');
    return true;
  });
  // The definition really was mutated; only the recorded success was withheld.
  assert.ok(workflow.nodes[2].result.bytes.buffer instanceof SharedArrayBuffer);
});

test('an end-result rejection is not an action failure: no retries are spent and no compensation runs', async () => {
  const { object } = flippingProperty('ordinary', new SharedArrayBuffer(4));
  const workflow = compensableBeforeEndWorkflow(object);
  let businessCalls = 0;
  let compensationCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      opA: () => { businessCalls += 1; return 'A'; },
      undoA: () => { compensationCalls += 1; return 'undone'; },
    }),
    error => {
      assertEndResultError(error, 'finish', 'shared');
      return true;
    },
  );
  // The business action succeeded once; nothing was retried and the end-node
  // result failure did not trigger its compensation.
  assert.equal(businessCalls, 1);
  assert.equal(compensationCalls, 0);
});

test('a shared-first getter is still rejected at validation, before any node runs', async () => {
  // Synchronous entry with a fresh shared-first object.
  const syncCase = flippingProperty(new SharedArrayBuffer(4), 'ordinary');
  assert.throws(
    () => executeWorkflow(linearEndWorkflow(syncCase.object), {}),
    error => {
      assertEndResultError(error, 'finish', 'shared');
      return true;
    },
  );

  // Asynchronous entry gets its own fresh object so validation observes the
  // shared first read; no business operation may run.
  let businessCalls = 0;
  const asyncCase = flippingProperty(new SharedArrayBuffer(4), 'ordinary');
  await assert.rejects(
    () => executeWorkflowAsync(actionBeforeEndWorkflow(asyncCase.object), {}, {
      work: () => { businessCalls += 1; return 'done'; },
    }),
    /end node finish: result contains shared memory/,
  );
  assert.equal(businessCalls, 0);
  // The validation clone is the property's only read; the execution-time read
  // is never reached.
  assert.equal(asyncCase.reads(), 1);
});

// ---------------------------------------------------------------------------
// Values that cannot be cloned (or read) when the end node executes
// ---------------------------------------------------------------------------

test('a function appearing only at execution time is reported as the end-node cloneability error (synchronous entry)', () => {
  const { object } = flippingProperty('ordinary', () => 'nope');
  const workflow = linearEndWorkflow(object);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => {
      assertEndResultError(error, 'finish', 'uncloneable');
      return true;
    },
  );
});

test('a nested function produced by an execution-time getter rejects the asynchronous promise', async () => {
  const { object } = flippingProperty({ ok: true }, { save: () => 'nope' });
  const workflow = actionBeforeEndWorkflow(object);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { work: () => 'done' }),
    error => {
      assertEndResultError(error, 'finish', 'uncloneable');
      return true;
    },
  );
});

test('a preceding operation replacing the whole result with a bare function rejects, without compensating', async () => {
  const workflow = {
    id: 'op-replaces-result',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA' }, next: 'finish',
      },
      { id: 'finish', type: 'end', result: { verdict: 'approved' } },
    ],
  };
  let compensationCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      opA: () => { workflow.nodes[2].result = () => 'nope'; return 'A'; },
      undoA: () => { compensationCalls += 1; return 'undone'; },
    }),
    error => {
      assertEndResultError(error, 'finish', 'uncloneable');
      return true;
    },
  );
  assert.equal(compensationCalls, 0);
});

test('an enumerable property that throws when read at execution time reports the end-node result error', async () => {
  let reads = 0;
  const object = {
    get boom() {
      reads += 1;
      if (reads === 1) return 'calm';
      throw new Error('getter-go-boom');
    },
  };
  const syncWorkflow = linearEndWorkflow(object);
  assert.doesNotThrow(() => validateWorkflow(syncWorkflow));
  assert.throws(
    () => executeWorkflow(syncWorkflow, {}),
    error => {
      assertEndResultError(error, 'finish', 'uncloneable');
      return true;
    },
  );

  // Same situation through the asynchronous entry, the throw arriving after a
  // business operation.
  let readsAsync = 0;
  const asyncObject = {
    get boom() {
      readsAsync += 1;
      if (readsAsync === 1) return 'calm';
      throw new Error('getter-go-boom');
    },
  };
  const asyncWorkflow = actionBeforeEndWorkflow(asyncObject);
  await assert.rejects(
    () => executeWorkflowAsync(asyncWorkflow, {}, { work: () => 'done' }),
    error => {
      assertEndResultError(error, 'finish', 'uncloneable');
      return true;
    },
  );
});

test('an uncloneable value at execution takes precedence over shared memory', () => {
  const { object } = flippingProperty(
    'ordinary',
    { fn: () => 'nope', bytes: new SharedArrayBuffer(4) },
  );
  const workflow = linearEndWorkflow(object);
  assert.throws(
    () => executeWorkflow(workflow, {}),
    /end node finish: result must be a structured-cloneable value/,
  );
});

// ---------------------------------------------------------------------------
// The execution-time judgment reads the original exactly once and judges only
// the content this run actually saves
// ---------------------------------------------------------------------------

test('the execution-time check never reads an enumerable value property more than once', async () => {
  // Validation (read #1) sees an ordinary string. At execution the first read
  // yields shared memory; a hypothetical extra inspection read would yield an
  // ordinary string again. A correct implementation clones exactly the first
  // execution-time value (shared) and must therefore reject.
  let reads = 0;
  const object = {
    get flip() {
      reads += 1;
      if (reads === 1) return 'validation-value';
      if (reads === 2) return new SharedArrayBuffer(4);
      return 'inspected-again';
    },
  };
  const workflow = actionBeforeEndWorkflow(object);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { work: () => 'done' }),
    /result contains shared memory/,
  );
  assert.equal(reads, 2, 'one validation read plus exactly one execution read');

  // Mirror case: execution's single read is ordinary; a hypothetical extra
  // read would have produced shared memory. The run must complete with the
  // value the single clone read obtained.
  let reads2 = 0;
  const ordinaryOnce = {
    get flip() {
      reads2 += 1;
      if (reads2 === 1) return 'validation-value';
      if (reads2 === 2) return 'execution-value';
      return new SharedArrayBuffer(4);
    },
  };
  const okWorkflow = actionBeforeEndWorkflow(ordinaryOnce);
  const execution = await executeWorkflowAsync(okWorkflow, {}, { work: () => 'done' });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result.flip, 'execution-value');
  assert.equal(reads2, 2, 'the legal path likewise performs exactly one execution read');
});

test('a legal ordinary change made before the end executes is recorded from the fresh value, not the validation snapshot', async () => {
  const workflow = actionBeforeEndWorkflow({
    bytes: new Uint8Array([1, 2, 3, 4]),
    nested: { label: 'before', list: [1, 2] },
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    work: () => {
      const next = new Uint8Array([9, 8, 7, 6]);
      workflow.nodes[2].result.bytes = next;
      workflow.nodes[2].result.nested.label = 'after';
      workflow.nodes[2].result.nested.list.push(3);
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual([...execution.result.bytes], [9, 8, 7, 6]);
  assert.equal(execution.result.nested.label, 'after');
  assert.deepEqual(execution.result.nested.list, [1, 2, 3]);

  // The recorded copy is independent of the buffers the definition now holds.
  workflow.nodes[2].result.bytes.fill(0);
  assert.deepEqual([...execution.result.bytes], [9, 8, 7, 6]);
});

test('shared memory carried only by a clone-dropped property attached at execution time does not reject', async () => {
  const workflow = actionBeforeEndWorkflow({ when: new Date(0), plain: { keep: 1 } });
  const execution = await executeWorkflowAsync(workflow, {}, {
    work: () => {
      // Enumerable attached own property of a Date: the clone drops it.
      workflow.nodes[2].result.when.aux = new SharedArrayBuffer(8);
      // A non-enumerable property of a plain object is dropped as well.
      Object.defineProperty(workflow.nodes[2].result.plain, 'hidden', {
        value: new SharedArrayBuffer(4), enumerable: false,
      });
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result.when.aux, undefined);
  assert.equal(Object.hasOwn(execution.result.plain, 'hidden'), false);
  assert.equal(execution.result.plain.keep, 1);
});

// ---------------------------------------------------------------------------
// Timing: the result is fixed at the end node's execution moment and survives
// later mutation of plain buffers/objects on another activated branch
// ---------------------------------------------------------------------------

test('bytes and nested structures recorded when the end runs early stay independent while another branch continues', async () => {
  const workflow = {
    id: 'early-end-bytes', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      {
        id: 'finish', type: 'end',
        result: { bytes: new Uint8Array([1, 2, 3, 4]), nested: { list: [10, 20] } },
      },
      { id: 'work', type: 'action', operation: 'slow', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      // The end has already recorded; rewrite the definition's plain bytes
      // and nested arrays while this branch is still running.
      setTimeout(() => {
        workflow.nodes[1].result.bytes.fill(99);
        workflow.nodes[1].result.nested.list.length = 0;
        workflow.nodes[1].result.nested.added = 'late';
      }, 10);
      await sleep(40);
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual([...execution.result.bytes], [1, 2, 3, 4]);
  assert.deepEqual(execution.result.nested.list, [10, 20]);
  assert.equal('added' in execution.result.nested, false);

  // Mutating the returned copy cannot reach the definition either.
  execution.result.bytes[0] = 77;
  execution.result.nested.list.push(30);
  assert.deepEqual([...workflow.nodes[1].result.bytes].slice(0, 4), [99, 99, 99, 99]);
});

// ---------------------------------------------------------------------------
// Validation-time rejection remains pre-execution, including unreachable ends
// ---------------------------------------------------------------------------

test('statically detectable illegal results still reject before any node, even when the reachable end is fine', async () => {
  let businessCalls = 0;
  const untaken = {
    id: 'untaken-exec-check', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-end', else: 'bad-end',
      },
      { id: 'good-end', type: 'end', result: 'good' },
      // Getter: shared on its first (validation) read, so validation rejects
      // it even though the good branch is selected.
      { id: 'bad-end', type: 'end', result: { get bytes() { return new SharedArrayBuffer(4); } } },
    ],
  };
  assert.throws(() => executeWorkflow(untaken, { route: 'good' }), /end node bad-end/);
  await assert.rejects(
    () => executeWorkflowAsync(untaken, { route: 'good' }, {
      work: () => { businessCalls += 1; return 'done'; },
    }),
    /end node bad-end/,
  );
  assert.equal(businessCalls, 0);

  const unreachable = {
    id: 'unreachable-exec-check', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'orphan-end', type: 'end', result: { get bytes() { return new SharedArrayBuffer(4); } } },
    ],
  };
  assert.throws(() => validateWorkflow(unreachable), /end node orphan-end/);
});

// ---------------------------------------------------------------------------
// Primitives still pass through, including when changed right before the end
// ---------------------------------------------------------------------------

test('unset/null/0/false/""/primitives remain exact, also when swapped in by a preceding operation', async () => {
  for (const configured of [undefined, null, 0, false, '', 42, true, 'ok']) {
    const workflow = {
      id: `primitive-${String(configured)}`,
      entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'done' },
        configured === undefined
          ? { id: 'done', type: 'end' }
          : { id: 'done', type: 'end', result: configured },
      ],
    };
    const run = executeWorkflow(workflow, {});
    assert.equal(run.status, 'completed');
    assert.equal(run.result, configured === undefined || configured === null ? null : configured);
  }

  // An operation that replaces an object result with 0/false/null records
  // those exact falsy values at the end's execution moment.
  for (const switched of [0, false, null, '']) {
    const workflow = actionBeforeEndWorkflow({ originally: 'an object' });
    const execution = await executeWorkflowAsync(workflow, {}, {
      work: () => { workflow.nodes[2].result = switched; return 'done'; },
    });
    assert.equal(execution.status, 'completed');
    assert.equal(execution.result, switched === null ? null : switched);
  }
});
