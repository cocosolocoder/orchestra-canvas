import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form defaults aimed at a structured input whose
// prototype already answers the field's name with an inherited member — most
// importantly a Map, whose prototype exposes "size" as an accessor with no
// setter. Only own properties count as filled: the inherited Map.prototype.size
// neither substitutes for a missing field nor makes a legal default throw
// (a plain [[Set]] finds the getter-only prototype property and raises a
// TypeError). The default is installed as an own enumerable data property
// instead, the Map keeps its type and original entries, and every existing
// rollback, copy and isolation rule keeps working.

function oneFormWorkflow(fields, formId = 'collect') {
  return {
    id: 'prototype-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: formId },
      { id: formId, type: 'form', next: 'done', schema: { fields } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

// start -> form-one (defaults shadow inherited Map members) -> gate
//       -> act (business op reading the defaults on its own copy) -> done
function gatedWorkflow() {
  return {
    id: 'prototype-defaults-async',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'gate', schema: { fields: [
        { path: 'request.options.size', type: 'integer', default: 7 },
        { path: 'request.options.size2.label', type: 'string', default: 'manual' },
      ] } },
      {
        id: 'gate', type: 'condition', then: 'act', else: 'missed',
        condition: { all: [
          { field: 'request.options.size', operator: 'eq', value: 7 },
          { field: 'request.options.size2.label', operator: 'eq', value: 'manual' },
        ] },
      },
      { id: 'act', type: 'action', operation: 'inspect', next: 'done' },
      { id: 'missed', type: 'end', result: 'condition-saw-inherited' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

function assertMapWithOwnDefaults(map, { size = 7, expectSize2 = true } = {}) {
  assert.ok(map instanceof Map, 'the value keeps its Map type');
  assert.equal(Object.hasOwn(map, 'size'), true, 'size is an own field');
  assert.equal(map.size, size, 'the own field shadows Map.prototype.size');
  assert.deepEqual([...map.entries()], [['a', 1], ['b', 2]], 'original Map members survive');
  if (expectSize2) {
    assert.deepEqual(map.size2, { label: 'manual' }, 'the created own parent chain reads through');
  }
}

test('sync: a default shadows an inherited read-only/accessor property instead of throwing', () => {
  const callerMap = new Map([['a', 1], ['b', 2]]);
  const caller = { request: { options: callerMap } };
  const result = executeWorkflow(oneFormWorkflow([
    { path: 'request.options.size', type: 'integer', default: 7 },
  ]), caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'ok');
  assertMapWithOwnDefaults(result.context.input.request.options, { expectSize2: false });

  // The caller's Map was never mutated: no own "size", prototype getter intact.
  assert.equal(Object.hasOwn(callerMap, 'size'), false);
  assert.equal(callerMap.size, 2);
  assert.deepEqual([...callerMap.entries()], [['a', 1], ['b', 2]]);
});

test('sync: a default path creates the missing own parent rather than descending the prototype', () => {
  // A populated Map answers "size" on its prototype with a number; the default
  // path size.label must not walk into that number (and then fail assigning to
  // it) — the missing own parent is created as a fresh plain object.
  const callerMap = new Map([['a', 1]]);
  const result = executeWorkflow(oneFormWorkflow([
    { path: 'request.options.size.label', type: 'string', default: 'manual' },
  ]), { request: { options: callerMap } });

  assert.equal(result.status, 'completed');
  const options = result.context.input.request.options;
  assert.ok(options instanceof Map);
  assert.equal(Object.hasOwn(options, 'size'), true);
  assert.equal(Object.getPrototypeOf(options.size), Object.prototype);
  assert.equal(options.size.label, 'manual');
  // The inherited member count never substituted for — or blocked — the field.
  assert.equal(options.size !== 1, true);
  assert.deepEqual([...options.entries()], [['a', 1]]);
  assert.equal(Object.hasOwn(callerMap, 'size'), false);
});

test('sync and async use the same behavior', async () => {
  const workflow = oneFormWorkflow([
    { path: 'request.options.size', type: 'integer', default: 7 },
    { path: 'request.options.size2.label', type: 'string', default: 'manual' },
  ]);
  const make = () => ({ request: { options: new Map([['a', 1], ['b', 2]]) } });

  const sync = executeWorkflow(workflow, make());
  assert.equal(sync.status, 'completed');
  assertMapWithOwnDefaults(sync.context.input.request.options);

  const async = await executeWorkflowAsync(workflow, make(), {});
  assert.equal(async.status, 'completed');
  assertMapWithOwnDefaults(async.context.input.request.options);
});

test('async: conditions and business copies read the defaults; copy edits stay in the copy', async () => {
  const callerMap = new Map([['a', 1], ['b', 2]]);
  const caller = { request: { options: callerMap } };
  let attemptCopy;
  const result = await executeWorkflowAsync(gatedWorkflow(), caller, {
    inspect: (input, output, nodeId, attempt) => {
      const options = input.request.options;
      assertMapWithOwnDefaults(options);
      attemptCopy = input;
      assert.equal(nodeId, 'act');
      assert.equal(attempt, 1);
      // Edit every part of this invocation's copy.
      options.size = 700;
      options.size2.label = 'changed';
      options.set('copy-only', true);
      options.addedOwnProp = true;
      return { saw: options.size };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished', 'the condition read the own defaults, not inherited size');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one', 'gate', 'act', 'done']);
  assert.deepEqual(result.context.output.act, { saw: 700 });

  // The live run input keeps the defaults and the original entries.
  assertMapWithOwnDefaults(result.context.input.request.options);
  const live = result.context.input.request.options;
  assert.equal(live.has('copy-only'), false);
  assert.equal(Object.hasOwn(live, 'addedOwnProp'), false);

  // The attempt's own copy keeps its independent edits.
  assert.equal(attemptCopy.request.options.size, 700);
  assert.equal(attemptCopy.request.options.size2.label, 'changed');
  assert.equal(attemptCopy.request.options.has('copy-only'), true);

  // The caller's Map is completely untouched.
  assert.equal(Object.hasOwn(callerMap, 'size'), false);
  assert.equal(callerMap.size, 2);
  assert.deepEqual([...callerMap.entries()], [['a', 1], ['b', 2]]);
});

test('a failed form rolls the shadowing default and its created parents back in declaration order', async () => {
  const workflow = {
    id: 'prototype-defaults-rollback',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-a' },
      { id: 'form-a', type: 'form', next: 'act', schema: { fields: [
        { path: 'earlier.keep', type: 'integer', default: 1 },
      ] } },
      { id: 'act', type: 'action', message: 'saved-output', next: 'form-b' },
      { id: 'form-b', type: 'form', next: 'done', schema: { fields: [
        { path: 'request.options.size', type: 'integer', default: 7 },
        { path: 'request.options.size2', type: 'integer', default: 8 },
        { path: 'request.options.deep.label', type: 'string', default: 'manual' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'should-not-happen' },
    ],
  };

  for (const [label, run] of [
    ['sync', input => executeWorkflow(workflow, input)],
    ['async', input => executeWorkflowAsync(workflow, input, {})],
  ]) {
    const callerMap = new Map([['k', 'v']]);
    const caller = { request: { options: callerMap } };
    const result = await run(caller);

    assert.equal(result.status, 'invalid_input', label);
    assert.deepEqual(result.errors, [
      { nodeId: 'form-b', path: 'missing.required', code: 'required' },
    ], `${label}: errors keep declaration order`);
    assert.deepEqual(result.trace.map(n => n.nodeId),
      ['start', 'form-a', 'act', 'form-b'], `${label}: later nodes do not run`);
    assert.equal(result.result, undefined, label);

    const options = result.context.input.request.options;
    assert.ok(options instanceof Map, label);
    // Everything the failed form added is withdrawn, leaf and parent alike.
    assert.equal(Object.hasOwn(options, 'size'), false, label);
    assert.equal(Object.hasOwn(options, 'size2'), false, label);
    assert.equal(Object.hasOwn(options, 'deep'), false, label);
    // The inherited getter answers again, with the real member count.
    assert.equal(options.size, 1, label);
    assert.deepEqual([...options.entries()], [['k', 'v']], `${label}: Map members kept`);
    // The earlier successful form and the earlier node output remain.
    assert.equal(result.context.input.earlier.keep, 1, label);
    assert.equal(result.context.output.act, 'saved-output', label);
    // The caller's Map was never touched.
    assert.equal(Object.hasOwn(callerMap, 'size'), false, label);
    assert.deepEqual([...callerMap.entries()], [['k', 'v']], label);
  }
});

test('an existing own field is validated as-is and never replaced by a default, even on a host object', () => {
  // Plain-object parent: the own value is filled, so the default is not used.
  const result = executeWorkflow(oneFormWorkflow([
    { path: 'options.size', type: 'integer', default: 7 },
  ]), { options: { size: 3 } });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.options.size, 3);

  // A wrong-typed own value fails instead of being overwritten.
  const bad = executeWorkflow(oneFormWorkflow([
    { path: 'options.size', type: 'integer', default: 7 },
  ]), { options: { size: 'not-a-number' } });
  assert.equal(bad.status, 'invalid_input');
  assert.deepEqual(bad.errors, [{ nodeId: 'collect', path: 'options.size', code: 'type' }]);
  assert.equal(bad.context.input.options.size, 'not-a-number');
});

test('a required field with no default cannot pass on an inherited property', () => {
  // The Map carries one entry, so Map.prototype.size answers 1 — but "size"
  // is not an own property and the field is missing.
  const result = executeWorkflow(oneFormWorkflow([
    { path: 'request.options.size', type: 'integer', required: true },
  ]), { request: { options: new Map([['x', 1]]) } });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'request.options.size', code: 'required' }]);
  assert.equal(Object.hasOwn(result.context.input.request.options, 'size'), false);
  assert.equal(result.context.input.request.options.size, 1, 'the inherited getter is untouched');
});

test('defaults shadow inherited members on other structured built-ins too', () => {
  // Set.prototype.size is the same getter-only accessor as Map's.
  const setRun = executeWorkflow(oneFormWorkflow([
    { path: 'tags.size', type: 'integer', default: 7 },
    { path: 'tags.mid.label', type: 'string', default: 'manual' },
  ]), { tags: new Set(['x', 'y']) });
  assert.equal(setRun.status, 'completed');
  const tags = setRun.context.input.tags;
  assert.ok(tags instanceof Set);
  assert.equal(Object.hasOwn(tags, 'size'), true);
  assert.equal(tags.size, 7);
  assert.deepEqual([...tags.values()], ['x', 'y']);
  assert.equal(tags.mid.label, 'manual');

  // A typed array's "length" is an inherited non-writable accessor; a default
  // of that name shadows it with an own data property while elements and type
  // stay intact (numeric out-of-bounds indices keep their own separate rule).
  const typedRun = executeWorkflow(oneFormWorkflow([
    { path: 'samples.length', type: 'integer', default: 7 },
  ]), { samples: new Uint8Array([1, 2, 3]) });
  assert.equal(typedRun.status, 'completed');
  const samples = typedRun.context.input.samples;
  assert.ok(samples instanceof Uint8Array);
  assert.equal(Object.hasOwn(samples, 'length'), true);
  assert.equal(samples.length, 7);
  assert.deepEqual([...samples], [1, 2, 3]);
});
