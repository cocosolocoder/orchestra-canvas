import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form defaults that target a typed-array element
// index the view does not have. Typed arrays (Uint8Array and friends) route a
// canonical numeric index key ("0", "2", …) to a fixed element slot: writing
// an index outside the view's length silently does nothing — neither the
// element nor an own property is created. The form engine used to record that
// no-op write and report the default as applied, so the run could show
// completed while a later condition still could not read the field. These
// tests pin the fix: such a default is a normal form failure (invalid_input,
// code "type") for both a leaf index and a path descending through one, the
// array keeps its type/length/elements, everything the failing form wrote is
// rolled back, and the surrounding rules (declaration-order errors, earlier
// forms' defaults, compensation, caller immutability) are unchanged.

const leafWorkflow = () => ({
  id: 'typed-array-oob-leaf',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'trigger', next: 'collect' },
    { id: 'collect', type: 'form', next: 'done', schema: { fields: [
      { path: 'samples.2', type: 'integer', default: 7 },
    ] } },
    { id: 'done', type: 'end', result: 'ok' },
  ],
});

const parentWorkflow = () => ({
  id: 'typed-array-oob-parent',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'trigger', next: 'collect' },
    { id: 'collect', type: 'form', next: 'done', schema: { fields: [
      // The parent object at the out-of-bounds index must not be temporarily
      // created either: the whole path is one type error.
      { path: 'samples.2.label', type: 'string', default: 'L' },
    ] } },
    { id: 'done', type: 'end', result: 'ok' },
  ],
});

function assertFailedBeforeEnd(result, nodeId, path) {
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId, path, code: 'type' }]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', nodeId]);
  assert.equal(result.trace.some(node => node.nodeId === 'done'), false);
  assert.equal(result.result, undefined);
}

test('an out-of-bounds typed-array leaf default is a type error, not a false success (sync)', () => {
  const workflow = leafWorkflow();
  const caller = { samples: new Uint8Array([1, 2]) };
  const result = executeWorkflow(workflow, caller);

  assertFailedBeforeEnd(result, 'collect', 'samples.2');

  // The array keeps its type, length and existing elements.
  assert.ok(result.context.input.samples instanceof Uint8Array);
  assert.equal(result.context.input.samples.length, 2);
  assert.deepEqual([...result.context.input.samples], [1, 2]);
  assert.equal(Object.hasOwn(result.context.input.samples, '2'), false);

  // The caller's input and its array contents are never mutated.
  assert.ok(caller.samples instanceof Uint8Array);
  assert.equal(caller.samples.length, 2);
  assert.deepEqual([...caller.samples], [1, 2]);
  assert.equal(Object.hasOwn(caller.samples, '2'), false);
});

test('a path descending through an out-of-bounds typed-array index is a type error without a temporary parent (sync)', () => {
  const workflow = parentWorkflow();
  const caller = { samples: new Uint8Array([1, 2]) };
  const result = executeWorkflow(workflow, caller);

  assertFailedBeforeEnd(result, 'collect', 'samples.2.label');
  assert.ok(result.context.input.samples instanceof Uint8Array);
  assert.equal(result.context.input.samples.length, 2);
  assert.deepEqual([...result.context.input.samples], [1, 2]);
  assert.equal(Object.hasOwn(result.context.input.samples, '2'), false);
});

test('a zero-length typed array is rejected the same way and keeps type, length and elements', () => {
  const workflow = leafWorkflow();
  const caller = { samples: new Uint8Array(0) };
  const result = executeWorkflow(workflow, caller);

  assertFailedBeforeEnd(result, 'collect', 'samples.2');
  assert.ok(result.context.input.samples instanceof Uint8Array);
  assert.equal(result.context.input.samples.length, 0);
});

test('other typed-array kinds get the same out-of-bounds treatment', () => {
  const workflow = {
    id: 'typed-array-kinds',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'words.3', type: 'integer', default: 4 },
        { path: 'values.0', type: 'number', default: 1.5 },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { words: new Int32Array([1, 2, 3]), values: new Float64Array(0) };
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'collect', path: 'words.3', code: 'type' },
    { nodeId: 'collect', path: 'values.0', code: 'type' },
  ]);
  assert.ok(result.context.input.words instanceof Int32Array);
  assert.equal(result.context.input.words.length, 3);
  assert.deepEqual([...result.context.input.words], [1, 2, 3]);
  assert.ok(result.context.input.values instanceof Float64Array);
  assert.equal(result.context.input.values.length, 0);
});

test('fields are processed in declaration order, each keeps one error, and only the failing form\'s writes are rolled back', () => {
  const workflow = {
    id: 'typed-array-ordering',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'good.before', type: 'string', default: 'B' },
        { path: 'samples.2', type: 'integer', default: 7 },
        { path: 'samples.3.label', type: 'string', default: 'L' },
        { path: 'good.after', type: 'string', default: 'A' },
        // An existing element keeps its normal type/range validation; a
        // Uint8 element is a number, so a declared string is a type error.
        { path: 'samples.1', type: 'string' },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { samples: new Uint8Array([1, 2]) };
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'collect', path: 'samples.2', code: 'type' },
    { nodeId: 'collect', path: 'samples.3.label', code: 'type' },
    { nodeId: 'collect', path: 'samples.1', code: 'type' },
  ]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'collect']);
  assert.equal(result.trace.some(node => node.nodeId === 'done'), false);

  // The parents this form created solely for its own good defaults are gone.
  assert.equal(Object.hasOwn(result.context.input, 'good'), false);
  // The typed array is untouched in type, length and elements.
  assert.ok(result.context.input.samples instanceof Uint8Array);
  assert.equal(result.context.input.samples.length, 2);
  assert.deepEqual([...result.context.input.samples], [1, 2]);
  assert.equal(Object.hasOwn(result.context.input.samples, '2'), false);
  assert.equal(Object.hasOwn(result.context.input.samples, '3'), false);
});

test('an earlier successful form\'s defaults survive the later typed-array failure (sync)', () => {
  const workflow = {
    id: 'typed-array-earlier-form',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'form-two', schema: { fields: [
        { path: 'earlier.keep', type: 'string', default: 'K' },
        // A non-index own property on the typed array is a legal default.
        { path: 'samples.tag', type: 'string', default: 'T' },
      ] } },
      { id: 'form-two', type: 'form', next: 'done', schema: { fields: [
        { path: 'mine.temp', type: 'string', default: 'M' },
        { path: 'samples.2', type: 'integer', default: 7 },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { samples: new Uint8Array([9, 8]), raw: true };
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'form-two', path: 'samples.2', code: 'type' }]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'form-one', 'form-two']);

  // Earlier form defaults, including an expando on the typed array, remain.
  assert.deepEqual(result.context.input.earlier, { keep: 'K' });
  assert.equal(result.context.input.samples.tag, 'T');
  assert.equal(result.context.input.raw, true);
  // The failed form's own created parent is withdrawn.
  assert.equal(Object.hasOwn(result.context.input, 'mine'), false);
  assert.deepEqual([...result.context.input.samples], [9, 8]);
  assert.equal(result.context.input.samples.length, 2);
});

test('existing typed-array elements keep their type/range validation and are never replaced by a default', () => {
  const workflow = fields => ({
    id: 'typed-array-existing',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  });

  // Wrong-typed existing element: type error, default is not substituted.
  let caller = { samples: new Uint8Array([1, 2]) };
  let result = executeWorkflow(workflow([{ path: 'samples.1', type: 'string', default: 'x' }]), caller);
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.1', code: 'type' }]);
  assert.equal(result.context.input.samples[1], 2);

  // Existing element violating a range bound.
  caller = { samples: new Uint8Array([1, 2]) };
  result = executeWorkflow(workflow([{ path: 'samples.1', type: 'integer', min: 5 }]), caller);
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.1', code: 'range' }]);

  // An in-range existing element with a matching default keeps its value.
  caller = { samples: new Uint8Array([1, 2]) };
  result = executeWorkflow(workflow([{ path: 'samples.1', type: 'integer', default: 99 }]), caller);
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.samples[1], 2);
});

test('non-index defaults on typed arrays, and defaults on plain objects and Dates, keep working', () => {
  const workflow = {
    id: 'typed-array-legit-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        // A non-canonical numeric spelling is an expando key, not an element
        // ("00" never canonicalizes back to itself as a string), as are
        // ordinary names.
        { path: 'bytes.00', type: 'string', default: 'expando-zero-zero' },
        { path: 'bytes.tag', type: 'string', default: 'T' },
        { path: 'bytes.meta.who', type: 'string', default: 'me' },
        { path: 'plain.pair.x', type: 'integer', default: 3 },
        { path: 'when.channel', type: 'string', default: 'web' },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { bytes: new Uint8Array([1, 2]), plain: {}, when: new Date(0) };
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.bytes['00'], 'expando-zero-zero');
  assert.equal(result.context.input.bytes.tag, 'T');
  assert.deepEqual(result.context.input.bytes.meta, { who: 'me' });
  assert.equal(result.context.input.bytes.length, 2);
  assert.deepEqual([...result.context.input.bytes], [1, 2]);
  assert.deepEqual(result.context.input.plain, { pair: { x: 3 } });
  assert.ok(result.context.input.when instanceof Date);
  assert.equal(result.context.input.when.channel, 'web');
});

test('regular arrays keep their existing behavior for out-of-bounds defaults', () => {
  const workflow = {
    id: 'regular-array-unchanged',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'samples.2', type: 'integer', default: 7 },
        { path: 'samples.3.label', type: 'string', default: 'L' },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  // A regular array is not a usable (non-array) object host, so descending
  // into an index is the same type error it always was.
  const caller = { samples: [1, 2] };
  const result = executeWorkflow(workflow, caller);
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'collect', path: 'samples.2', code: 'type' },
    { nodeId: 'collect', path: 'samples.3.label', code: 'type' },
  ]);
  assert.deepEqual(result.context.input.samples, [1, 2]);
});

test('async run: the typed-array failure is a normal form failure, rolls back, and compensates earlier actions', async () => {
  const workflow = {
    id: 'typed-array-async',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'reserve', schema: { fields: [
        { path: 'earlier.keep', type: 'string', default: 'K' },
        { path: 'samples.tag', type: 'string', default: 'T' },
      ] } },
      {
        id: 'reserve', type: 'action', operation: 'reserve',
        compensation: { operation: 'release' }, next: 'form-two',
      },
      { id: 'form-two', type: 'form', next: 'done', schema: { fields: [
        { path: 'mine.temp', type: 'string', default: 'M' },
        { path: 'samples.2', type: 'integer', default: 7 },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { samples: new Uint8Array([9, 8]) };
  const reserveSeen = [];
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    reserve: (input, output, nodeId, attempt) => {
      reserveSeen.push({ bytes: [...input.samples], tag: input.samples.tag, earlier: structuredClone(input.earlier), nodeId, attempt });
      return { id: 'tx-7' };
    },
    release: (input, output, returned, nodeId, attempt) => {
      compensationSeen.push({ bytes: [...input.samples], tag: input.samples.tag, nodeId, attempt });
      return 'released';
    },
  });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'form-two', path: 'samples.2', code: 'type' }]);
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'form-one', 'reserve', 'form-two']);
  assert.equal(result.trace.some(node => node.nodeId === 'done'), false);
  assert.equal(result.result, undefined);

  // Successful action output and its record survive; it is compensated once.
  assert.deepEqual(result.context.output, { reserve: { id: 'tx-7' } });
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['reserve', 'release', 1, true, 'released'],
  ]);

  // The action saw the earlier form's defaults at its own success moment.
  assert.equal(reserveSeen.length, 1);
  assert.deepEqual(reserveSeen[0].bytes, [9, 8]);
  assert.equal(reserveSeen[0].tag, 'T');
  assert.deepEqual(reserveSeen[0].earlier, { keep: 'K' });
  assert.equal(reserveSeen[0].nodeId, 'reserve');
  assert.equal(reserveSeen[0].attempt, 1);

  // Compensation is frozen at that same moment.
  assert.equal(compensationSeen.length, 1);
  assert.deepEqual(compensationSeen[0].bytes, [9, 8]);
  assert.equal(compensationSeen[0].tag, 'T');
  assert.equal(compensationSeen[0].nodeId, 'reserve');

  // Earlier successful form defaults remain; the failed form's are withdrawn.
  assert.deepEqual(result.context.input.earlier, { keep: 'K' });
  assert.equal(result.context.input.samples.tag, 'T');
  assert.equal(Object.hasOwn(result.context.input, 'mine'), false);
  assert.ok(result.context.input.samples instanceof Uint8Array);
  assert.equal(result.context.input.samples.length, 2);
  assert.deepEqual([...result.context.input.samples], [9, 8]);
  assert.equal(Object.hasOwn(result.context.input.samples, '2'), false);

  // The caller's input and array are untouched throughout.
  assert.ok(caller.samples instanceof Uint8Array);
  assert.equal(caller.samples.length, 2);
  assert.deepEqual([...caller.samples], [9, 8]);
  assert.equal(caller.samples.tag, undefined);
  assert.equal(caller.earlier, undefined);
  assert.equal(caller.mine, undefined);
});
