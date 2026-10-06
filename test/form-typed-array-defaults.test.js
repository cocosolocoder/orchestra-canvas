import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Form defaults aimed at a typed array's out-of-bounds index must not report
// success: assigning to a missing canonical numeric index of a typed array is
// silently ignored by the language, so the "written" default would be
// unreadable by every later node. Such a field fails its form with a `type`
// error instead — whether the index is the leaf (samples.2) or an
// intermediate segment that would need a parent created under it
// (samples.2.label) — while existing indices, ordinary non-index properties
// and every other default target keep their current behavior.

function singleFormWorkflow(fields, formId = 'collect') {
  return {
    id: 'typed-array-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: formId },
      { id: formId, type: 'form', next: 'done', schema: { fields } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

test('a default for an out-of-bounds typed-array index fails the form with a type error', () => {
  const samples = new Uint8Array([1, 2]);
  const caller = { samples };
  const result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.2', type: 'integer', default: 7 },
  ]), caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.2', code: 'type' }]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'collect']);
  assert.equal(result.result, undefined);

  // The returned input keeps the array's type, length and existing elements,
  // and gained no own property for the missing index.
  const returned = result.context.input.samples;
  assert.equal(returned instanceof Uint8Array, true);
  assert.equal(returned.length, 2);
  assert.deepEqual([...returned], [1, 2]);
  assert.equal(Object.hasOwn(returned, '2'), false);

  // The caller's own array is untouched.
  assert.deepEqual([...samples], [1, 2]);
  assert.equal(Object.hasOwn(samples, '2'), false);
});

test('a default path crossing an out-of-bounds typed-array index fails instead of orphaning a parent', () => {
  const caller = { samples: new Uint8Array([1, 2]) };
  const result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.2.label', type: 'string', default: 'x' },
  ]), caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.2.label', code: 'type' }]);
  // No temporary parent object was left behind at the missing index.
  assert.equal(Object.hasOwn(result.context.input.samples, '2'), false);
  assert.deepEqual([...result.context.input.samples], [1, 2]);
});

test('a zero-length typed array rejects every indexed default', () => {
  const caller = { samples: new Uint8Array(0) };
  const result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.0', type: 'integer', default: 7 },
  ]), caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.0', code: 'type' }]);
  const returned = result.context.input.samples;
  assert.equal(returned instanceof Uint8Array, true);
  assert.equal(returned.length, 0);
});

test('declaration order and rollback hold around an out-of-bounds field in the same form', () => {
  const workflow = {
    id: 'typed-array-rollback',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'early' },
      { id: 'early', type: 'form', next: 'collect', schema: { fields: [
        { path: 'kept.earlier', type: 'string', default: 'E' },
      ] } },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'added.before', type: 'string', default: 'before' },
        { path: 'samples.2', type: 'integer', default: 7 },
        { path: 'samples.3.label', type: 'string', default: 'x' },
        { path: 'added.after', type: 'string', default: 'after' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { samples: new Uint8Array([1, 2]), raw: 'value' };
  const callerSnapshot = structuredClone(caller);

  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  // Fields are processed in declaration order, each contributing at most one
  // error under the usual priority — the two out-of-bounds fields fail as
  // type errors and the later required field is still reported.
  assert.deepEqual(result.errors, [
    { nodeId: 'collect', path: 'samples.2', code: 'type' },
    { nodeId: 'collect', path: 'samples.3.label', code: 'type' },
    { nodeId: 'collect', path: 'missing.required', code: 'required' },
  ]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'early', 'collect']);

  // Everything the failed form added — including fields around the failing
  // ones and the parents created only for them — is rolled back; the earlier
  // successful form's defaults and the caller's own data survive.
  assert.deepEqual(result.context.input, {
    samples: result.context.input.samples,
    raw: 'value',
    kept: { earlier: 'E' },
  });
  assert.equal(Object.hasOwn(result.context.input, 'added'), false);
  assert.deepEqual([...result.context.input.samples], [1, 2]);
  assert.equal(Object.hasOwn(result.context.input.samples, '2'), false);

  assert.deepEqual(caller, callerSnapshot);
});

test('existing typed-array indices keep their validation and are never replaced by defaults', () => {
  // A present in-bounds element is validated, not defaulted.
  let result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.1', type: 'integer', default: 7 },
  ]), { samples: new Uint8Array([1, 2]) });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.samples[1], 2);

  // The same element still fails the field's own type check...
  result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.1', type: 'string' },
  ]), { samples: new Uint8Array([1, 2]) });
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.1', code: 'type' }]);

  // ...and its range check.
  result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.1', type: 'integer', max: 1 },
  ]), { samples: new Uint8Array([1, 2]) });
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.1', code: 'range' }]);
});

test('ordinary properties on a typed array remain legal default targets', () => {
  // A non-index property can be added to a typed array as usual.
  let result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.label', type: 'string', default: 'x' },
  ]), { samples: new Uint8Array([1, 2]) });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.samples.label, 'x');
  assert.deepEqual([...result.context.input.samples], [1, 2]);

  // A numeric-looking name that is not a canonical index is an ordinary
  // property too, not an element write.
  result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.02', type: 'integer', default: 9 },
  ]), { samples: new Uint8Array([1, 2]) });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.samples['02'], 9);
});

test('async run: out-of-bounds defaults fail the form and compensation still runs by the usual rules', async () => {
  const workflow = {
    id: 'typed-array-async',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'reserve' },
      { id: 'reserve', type: 'action', operation: 'reserve',
        compensation: { operation: 'release' }, next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'kept', type: 'string', default: 'K' },
        { path: 'samples.2', type: 'integer', default: 7 },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const samples = new Uint8Array([1, 2]);
  const caller = { samples };

  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    reserve: () => ({ id: 'tx-1' }),
    release: (input, output, returned, nodeId, attempt) => {
      compensationSeen.push({ nodeId, attempt, returned: structuredClone(returned) });
      return 'released';
    },
  });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.2', code: 'type' }]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'reserve', 'collect']);

  // The failed form's own default is rolled back; the typed array is intact.
  assert.equal(Object.hasOwn(result.context.input, 'kept'), false);
  assert.deepEqual([...result.context.input.samples], [1, 2]);
  assert.equal(Object.hasOwn(result.context.input.samples, '2'), false);

  // The earlier successful action keeps its output and attempt record, and is
  // compensated exactly once under the existing form-failure rules.
  assert.deepEqual(result.context.output, { reserve: { id: 'tx-1' } });
  assert.deepEqual(result.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [['reserve', 1, true]]);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['reserve', 'release', 1, true, 'released'],
  ]);
  assert.deepEqual(compensationSeen, [{ nodeId: 'reserve', attempt: 1, returned: { id: 'tx-1' } }]);

  // The caller's input and its array contents are unchanged.
  assert.deepEqual([...samples], [1, 2]);
  assert.deepEqual(Object.keys(caller), ['samples']);
});
