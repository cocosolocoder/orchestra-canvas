import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

// A trigger -> legacy message action -> end workflow usable by the
// synchronous entry.
function linearMessageWorkflow(message) {
  return {
    id: 'linear-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      { id: 'note', type: 'action', message, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

// A business action precedes the message action, so an operation can change
// the configured message and the change is observed when the message action
// actually executes.
function actionBeforeMessageWorkflow(message) {
  return {
    id: 'action-before-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'work', next: 'note' },
      { id: 'note', type: 'action', message, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

// A compensable action preceding the message action, used to prove a
// message-output rejection spends no action retries and runs no compensation.
function compensableBeforeMessageWorkflow(message) {
  return {
    id: 'compensable-before-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA' },
        retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        next: 'note',
      },
      { id: 'note', type: 'action', message, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

function assertMessageError(error, nodeId, kind) {
  assert.ok(error instanceof Error, 'an Error is thrown/rejected');
  assert.ok(!(error instanceof TypeError), 'a message-output failure is a plain Error, not a TypeError');
  if (kind === 'shared') {
    assert.match(error.message, new RegExp(`action node ${nodeId}: message contains shared memory`));
    assert.match(error.message, /SharedArrayBuffer/);
    assert.match(error.message, /independent copies cannot be guaranteed/);
  } else {
    assert.match(error.message, new RegExp(`action node ${nodeId}: message must be a structured-cloneable value`));
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
// Shared memory that only appears when the message action actually executes
// ---------------------------------------------------------------------------

test('a getter returning ordinary data at validation but shared memory at execution makes the synchronous entry throw', () => {
  const { object } = flippingProperty('ordinary', new SharedArrayBuffer(4));
  const workflow = linearMessageWorkflow(object);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => {
      assertMessageError(error, 'note', 'shared');
      return true;
    },
  );
});

test('the asynchronous entry rejects the returned promise, never reporting completed', async () => {
  const { object } = flippingProperty('ordinary', new Uint8Array(new SharedArrayBuffer(4)));
  const workflow = actionBeforeMessageWorkflow(object);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { work: () => 'done' }),
    error => {
      assertMessageError(error, 'note', 'shared');
      return true;
    },
  );
});

test('a preceding business operation swapping a plain buffer for a shared one rejects the run', async () => {
  const workflow = actionBeforeMessageWorkflow({ bytes: new Uint8Array([1, 2, 3]), view: new DataView(new ArrayBuffer(2)) });
  const execution = executeWorkflowAsync(workflow, {}, {
    work: () => {
      workflow.nodes[2].message.bytes = new Uint8Array(new SharedArrayBuffer(3));
      workflow.nodes[2].message.view = new DataView(new SharedArrayBuffer(2));
      return 'done';
    },
  });
  await assert.rejects(execution, error => {
    assertMessageError(error, 'note', 'shared');
    return true;
  });
  // The definition really was mutated; only the saved output was withheld.
  assert.ok(workflow.nodes[2].message.bytes.buffer instanceof SharedArrayBuffer);
});

test('a message-output rejection is not an action failure: no retries are spent and no compensation runs', async () => {
  const { object } = flippingProperty('ordinary', new SharedArrayBuffer(4));
  const workflow = compensableBeforeMessageWorkflow(object);
  let businessCalls = 0;
  let compensationCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      opA: () => { businessCalls += 1; return 'A'; },
      undoA: () => { compensationCalls += 1; return 'undone'; },
    }),
    error => {
      assertMessageError(error, 'note', 'shared');
      return true;
    },
  );
  // The business action succeeded once; nothing was retried and the message
  // action's failure did not trigger its compensation.
  assert.equal(businessCalls, 1);
  assert.equal(compensationCalls, 0);
});

test('the failing action leaves no success output and no later node executes', () => {
  const { object } = flippingProperty('ordinary', new SharedArrayBuffer(4));
  const workflow = {
    id: 'no-leftovers',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      { id: 'note', type: 'action', message: object, next: 'after' },
      { id: 'after', type: 'action', message: 'must-not-run', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => {
      assertMessageError(error, 'note', 'shared');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Values that cannot be cloned (or read) when the message action executes
// ---------------------------------------------------------------------------

test('a function appearing only at execution time is reported as the message cloneability error (synchronous entry)', () => {
  const { object } = flippingProperty('ordinary', () => 'nope');
  const workflow = linearMessageWorkflow(object);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => {
      assertMessageError(error, 'note', 'uncloneable');
      return true;
    },
  );
});

test('a nested function produced by an execution-time getter rejects the asynchronous promise', async () => {
  const { object } = flippingProperty({ ok: true }, { save: () => 'nope' });
  const workflow = actionBeforeMessageWorkflow(object);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { work: () => 'done' }),
    error => {
      assertMessageError(error, 'note', 'uncloneable');
      return true;
    },
  );
});

test('a preceding operation replacing the whole message with a bare function rejects, without compensating', async () => {
  const workflow = {
    id: 'op-replaces-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA' }, next: 'note',
      },
      { id: 'note', type: 'action', message: { verdict: 'approved' }, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  let compensationCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      opA: () => { workflow.nodes[2].message = () => 'nope'; return 'A'; },
      undoA: () => { compensationCalls += 1; return 'undone'; },
    }),
    error => {
      assertMessageError(error, 'note', 'uncloneable');
      return true;
    },
  );
  assert.equal(compensationCalls, 0);
});

test('an enumerable property that throws when read at execution time reports the message error', async () => {
  let reads = 0;
  const object = {
    get boom() {
      reads += 1;
      if (reads === 1) return 'calm';
      throw new Error('getter-go-boom');
    },
  };
  const syncWorkflow = linearMessageWorkflow(object);
  assert.doesNotThrow(() => validateWorkflow(syncWorkflow));
  assert.throws(
    () => executeWorkflow(syncWorkflow, {}),
    error => {
      assertMessageError(error, 'note', 'uncloneable');
      return true;
    },
  );

  let readsAsync = 0;
  const asyncObject = {
    get boom() {
      readsAsync += 1;
      if (readsAsync === 1) return 'calm';
      throw new Error('getter-go-boom');
    },
  };
  const asyncWorkflow = actionBeforeMessageWorkflow(asyncObject);
  await assert.rejects(
    () => executeWorkflowAsync(asyncWorkflow, {}, { work: () => 'done' }),
    error => {
      assertMessageError(error, 'note', 'uncloneable');
      return true;
    },
  );
});

test('an uncloneable value at execution takes precedence over shared memory', () => {
  const { object } = flippingProperty(
    'ordinary',
    { fn: () => 'nope', bytes: new SharedArrayBuffer(4) },
  );
  const workflow = linearMessageWorkflow(object);
  assert.throws(
    () => executeWorkflow(workflow, {}),
    /action node note: message must be a structured-cloneable value/,
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
  const workflow = actionBeforeMessageWorkflow(object);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { work: () => 'done' }),
    /message contains shared memory/,
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
  const okWorkflow = actionBeforeMessageWorkflow(ordinaryOnce);
  const execution = await executeWorkflowAsync(okWorkflow, {}, { work: () => 'done' });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.context.output.note.flip, 'execution-value');
  assert.equal(reads2, 2, 'the legal path likewise performs exactly one execution read');
});

test('the root message itself is read exactly once at execution', () => {
  let rootReads = 0;
  const workflow = {
    id: 'root-read-once',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      { id: 'note', type: 'action', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  Object.defineProperty(workflow.nodes[1], 'message', {
    enumerable: true,
    get() { rootReads += 1; return { v: rootReads }; },
  });
  const run = executeWorkflow(workflow, {});
  assert.equal(run.status, 'completed');
  // The saved output holds the value of the single execution-time read, not
  // a later re-read.
  assert.deepEqual(run.context.output.note, { v: rootReads });
});

test('a legal ordinary change made before the action executes is saved from the fresh value, not the validation snapshot', async () => {
  const workflow = actionBeforeMessageWorkflow({
    bytes: new Uint8Array([1, 2, 3, 4]),
    nested: { label: 'before', list: [1, 2] },
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    work: () => {
      const next = new Uint8Array([9, 8, 7, 6]);
      workflow.nodes[2].message.bytes = next;
      workflow.nodes[2].message.nested.label = 'after';
      workflow.nodes[2].message.nested.list.push(3);
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.note;
  assert.deepEqual([...saved.bytes], [9, 8, 7, 6]);
  assert.equal(saved.nested.label, 'after');
  assert.deepEqual(saved.nested.list, [1, 2, 3]);

  // The saved copy is independent of the buffers the definition now holds,
  // and mutating the returned output cannot reach the definition.
  workflow.nodes[2].message.bytes.fill(0);
  assert.deepEqual([...saved.bytes], [9, 8, 7, 6]);
  saved.bytes[0] = 77;
  assert.deepEqual([...workflow.nodes[2].message.bytes], [0, 0, 0, 0]);
});

test('shared memory carried only by a clone-dropped property attached at execution time does not reject', async () => {
  const workflow = actionBeforeMessageWorkflow({ when: new Date(0), plain: { keep: 1 } });
  const execution = await executeWorkflowAsync(workflow, {}, {
    work: () => {
      // Enumerable attached own property of a Date: the clone drops it.
      workflow.nodes[2].message.when.aux = new SharedArrayBuffer(8);
      // A non-enumerable property of a plain object is dropped as well.
      Object.defineProperty(workflow.nodes[2].message.plain, 'hidden', {
        value: new SharedArrayBuffer(4), enumerable: false,
      });
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.note;
  assert.equal(saved.when.aux, undefined);
  assert.equal(Object.hasOwn(saved.plain, 'hidden'), false);
  assert.equal(saved.plain.keep, 1);
});

// ---------------------------------------------------------------------------
// Later nodes read the executed-moment copy
// ---------------------------------------------------------------------------

test('later conditions and business actions read the value saved at execution time', async () => {
  const seenByOperation = [];
  const workflow = {
    id: 'execution-copy-reads',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'reshape', next: 'note' },
      { id: 'note', type: 'action', message: { score: 10 }, next: 'consume' },
      { id: 'consume', type: 'action', operation: 'consume', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { outputField: { nodeId: 'note', path: 'score' }, operator: 'gte', value: 80 },
        then: 'pass', else: 'fail',
      },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    // A legal change before the message action runs: the new content is what
    // the action saves and what every later node reads.
    reshape: () => { workflow.nodes[2].message = { score: 90 }; return 'reshaped'; },
    consume: (input, output) => {
      seenByOperation.push(structuredClone(output.note));
      output.note.score = 0;
      return 'consumed';
    },
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.result, 'passed');
  assert.deepEqual(seenByOperation[0], { score: 90 });
  // The operation only saw a copy: the stored message output is unchanged.
  assert.equal(run.context.output.note.score, 90);
});

// ---------------------------------------------------------------------------
// Existing rules are unchanged
// ---------------------------------------------------------------------------

test('absent, undefined, null and primitive messages keep their existing output rules at execution', async () => {
  const cases = [
    ['undefined', undefined, 'action:note'],
    ['null', null, 'action:note'],
    ['empty string', '', ''],
    ['zero', 0, 0],
    ['false', false, false],
  ];
  for (const [label, configured, expected] of cases) {
    const workflow = linearMessageWorkflow(configured);
    const sync = executeWorkflow(workflow, {});
    assert.equal(sync.context.output.note, expected, `sync ${label}`);
    const asynced = await executeWorkflowAsync(workflow, {});
    assert.equal(asynced.context.output.note, expected, `async ${label}`);
    assert.deepEqual(asynced.actionAttempts, []);
  }
});

test('a plain ArrayBuffer message swapped in before execution keeps type, bytes and independence', async () => {
  const workflow = actionBeforeMessageWorkflow({ placeholder: true });
  const execution = await executeWorkflowAsync(workflow, {}, {
    work: () => {
      workflow.nodes[2].message = Uint8Array.from([9, 8, 7, 6]).buffer;
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.note;
  assert.ok(saved instanceof ArrayBuffer);
  assert.ok(!(saved instanceof SharedArrayBuffer));
  assert.deepEqual([...new Uint8Array(saved)], [9, 8, 7, 6]);
  new Uint8Array(saved).fill(1);
  assert.deepEqual([...new Uint8Array(workflow.nodes[2].message)], [9, 8, 7, 6]);
});

test('an action that names an operation still ignores a message that turns shared at execution', async () => {
  const workflow = {
    id: 'operation-ignores-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'first' },
      { id: 'first', type: 'action', operation: 'first', next: 'work' },
      { id: 'work', type: 'action', operation: 'real', message: { ok: true }, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    first: () => { workflow.nodes[2].message = new SharedArrayBuffer(4); return 'f'; },
    real: () => 'from-operation',
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.context.output.work, 'from-operation');
});
