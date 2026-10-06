import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form defaults whose target name shadows a read-only
// member on the value's prototype. Structured inputs a caller passes through
// the JavaScript entry points keep their class (a Map is cloned as a Map), and
// some of those classes carry inherited read-only members a form path can
// collide with — Map/Set/WeakMap/WeakSet `size`, typed arrays and DataView
// `length`/`byteLength`, RegExp `source`, the Map/Set methods, and so on.
//
// Forms and conditions read own properties only, so such an inherited member
// must never count as a filled field; and a default for the missing own field
// must land as an ordinary own property instead of aborting the run with a
// strict-mode "Cannot set property ... which has only a getter" TypeError.
// The host object keeps its type and internal members (the Map entries), the
// own default shadows the inherited member on own-only reads, and deleting the
// own property restores the inherited member (the entry count).

function singleFormWorkflow(fields, formId = 'collect') {
  return {
    id: 'prototype-readonly-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: formId },
      { id: formId, type: 'form', next: 'done', schema: { fields } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

// The full expectation on a Map that gained an own `size` default: it stays a
// Map with exactly its original entries, carries the own numeric field, and the
// inherited entry-count getter is still intact underneath the shadow.
function assertMapWithOwnSize(map, ownSize, entries) {
  assert.ok(map instanceof Map, 'the value stays a Map');
  assert.equal(Object.hasOwn(map, 'size'), true, 'the default is an own property');
  assert.equal(map.size, ownSize, 'own reads return the default');
  assert.deepEqual([...map.entries()], entries, 'the Map keeps its original members');
  delete map.size;
  assert.equal(map.size, entries.length, 'deleting the own field restores the inherited count');
  // Re-place the shadow for any later assertion on the same object.
  Object.defineProperty(map, 'size', {
    value: ownSize, writable: true, enumerable: true, configurable: true,
  });
}

test('a default for a missing own field shadows Map.prototype.size without touching the Map', () => {
  const caller = { request: { options: new Map([['a', 1], ['b', 2]]) } };
  const result = executeWorkflow(singleFormWorkflow([
    { path: 'request.options.size', type: 'integer', default: 7 },
  ]), caller);

  assert.equal(result.status, 'completed');
  assertMapWithOwnSize(result.context.input.request.options, 7, [['a', 1], ['b', 2]]);

  // The caller's own Map is never mutated: no own size, member count intact.
  assert.equal(Object.hasOwn(caller.request.options, 'size'), false);
  assert.equal(caller.request.options.size, 2);
});

test('the same Map.size default works through the asynchronous entry point', async () => {
  const caller = { request: { options: new Map([['a', 1], ['b', 2]]) } };
  const result = await executeWorkflowAsync(singleFormWorkflow([
    { path: 'request.options.size', type: 'integer', default: 7 },
  ]), caller);

  assert.equal(result.status, 'completed');
  assertMapWithOwnSize(result.context.input.request.options, 7, [['a', 1], ['b', 2]]);
  assert.equal(Object.hasOwn(caller.request.options, 'size'), false);
});

test('a deeper default creates the missing own parent instead of following an inherited primitive', () => {
  const workflow = singleFormWorkflow([
    { path: 'request.options.size.label', type: 'string', default: 'manual' },
  ]);
  for (const entries of [[], [['k', 10]]]) {
    const result = executeWorkflow(workflow, { request: { options: new Map(entries) } });
    assert.equal(result.status, 'completed');
    const options = result.context.input.request.options;
    assert.ok(options instanceof Map);
    assert.equal(Object.hasOwn(options, 'size'), true, 'an own parent named size was created');
    assert.equal(typeof options.size, 'object');
    assert.equal(options.size.label, 'manual');
    assert.deepEqual([...options.entries()], entries, 'the Map keeps its original members');
    // The inherited numeric count is reachable again once the own parent goes.
    delete options.size;
    assert.equal(options.size, entries.length);
  }
});

test('a following condition reads the own default rather than the inherited member', () => {
  const workflow = {
    id: 'proto-default-condition',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'check', schema: { fields: [
        // The Map has two members, so its inherited size getter returns 2;
        // the own default 7 must be what the comparison sees.
        { path: 'options.size', type: 'integer', default: 7 },
        { path: 'options.meta.label', type: 'string', default: 'manual' },
      ] } },
      {
        id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { all: [
          { field: 'options.size', operator: 'eq', value: 7 },
          { field: 'options.meta.label', operator: 'eq', value: 'manual' },
        ] },
      },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
  const result = executeWorkflow(workflow, { options: new Map([['a', 1], ['b', 2]]) });
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'collect', 'check', 'seen']);
});

test('an asynchronous business operation reads the own default on an independent Map copy', async () => {
  const workflow = {
    id: 'proto-default-action-copy',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'inspect', schema: { fields: [
        { path: 'options.size', type: 'integer', default: 7 },
        { path: 'options.meta.label', type: 'string', default: 'manual' },
      ] } },
      { id: 'inspect', type: 'action', operation: 'inspect', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const callerMap = new Map([['k', 'v']]);
  const seen = [];
  const result = await executeWorkflowAsync(workflow, { options: callerMap }, {
    inspect(input) {
      seen.push({
        isMap: input.options instanceof Map,
        ownSize: Object.hasOwn(input.options, 'size'),
        size: input.options.size,
        entries: [...input.options.entries()],
        label: input.options.meta.label,
      });
      // Editing this copy must never reach the run input or the caller's Map.
      input.options.set('copy-only', 1);
      input.options.size = 12345;
      input.options.meta.label = 'mutated';
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, [{
    isMap: true, ownSize: true, size: 7,
    entries: [['k', 'v']], label: 'manual',
  }]);

  const runOptions = result.context.input.options;
  assert.ok(runOptions instanceof Map);
  assert.equal(runOptions.size, 7);
  assert.equal(runOptions.meta.label, 'manual');
  assert.deepEqual([...runOptions.entries()], [['k', 'v']]);

  assert.equal(callerMap.size, 1);
  assert.equal(Object.hasOwn(callerMap, 'size'), false);
  assert.deepEqual([...callerMap.entries()], [['k', 'v']]);
});

test('another invalid field in the same form rolls the own default and its parents off the Map', () => {
  const workflow = {
    id: 'proto-default-rollback',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'earlier' },
      { id: 'earlier', type: 'form', next: 'collect', schema: { fields: [
        { path: 'kept.earlier', type: 'string', default: 'E' },
      ] } },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'options.size', type: 'integer', default: 7 },
        { path: 'options.size2.label', type: 'string', default: 'manual' },
        { path: 'options.count', type: 'integer', required: true },
        { path: 'present', type: 'integer' },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const callerMap = new Map([['a', 1]]);
  const caller = { options: callerMap, present: 'nope' };

  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  // Field errors keep declaration order; the inherited size getter cannot
  // satisfy the missing required `count`.
  assert.deepEqual(result.errors, [
    { nodeId: 'collect', path: 'options.count', code: 'required' },
    { nodeId: 'collect', path: 'present', code: 'type' },
  ]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'earlier', 'collect']);

  // Everything the failed form added was withdrawn from the live Map...
  assert.equal(Object.hasOwn(callerMap, 'size'), false);
  assert.equal(Object.hasOwn(callerMap, 'size2'), false);
  assert.equal(callerMap.size, 1, 'the inherited member count is exposed again');
  assert.deepEqual([...callerMap.entries()], [['a', 1]]);

  // ...the earlier successful form's defaults and caller data remain...
  assert.equal(result.context.input.kept.earlier, 'E');
  assert.equal(result.context.input.present, 'nope');
  // ...and no later node executed.
  assert.equal(result.result, undefined);
});

test('an inherited member never fills a required field, and an own field is never replaced by its default', () => {
  // Required, no default: the Map.size getter is not a value.
  let result = executeWorkflow(singleFormWorkflow([
    { path: 'options.size', type: 'integer', required: true },
  ]), { options: new Map([['a', 1]]) });
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'options.size', code: 'required' }]);

  // A present own value is validated as itself — a wrong type is a type error,
  // never silently substituted by the default.
  result = executeWorkflow(singleFormWorkflow([
    { path: 'options.size', type: 'integer', default: 7 },
  ]), { options: { size: 'many' } });
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'options.size', code: 'type' }]);

  // A value a previous successful form already added is an own field now: a
  // later form validates it as itself and never re-applies its own default
  // (and an inherited getter cannot masquerade as that value either).
  const twoForms = {
    id: 'proto-default-two-forms',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'first' },
      { id: 'first', type: 'form', next: 'second', schema: { fields: [
        { path: 'options.size', type: 'integer', default: 7 },
      ] } },
      { id: 'second', type: 'form', next: 'done', schema: { fields: [
        { path: 'options.size', type: 'integer', default: 99, min: 0 },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  result = executeWorkflow(twoForms, { options: new Map([['a', 1]]) });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.options.size, 7, 'the first form value is kept, not replaced');
  assert.ok(result.context.input.options instanceof Map);
});

test('other read-only inherited members behave the same: Set.size and a typed array length', () => {
  let result = executeWorkflow(singleFormWorkflow([
    { path: 'bag.size', type: 'integer', default: 7 },
  ]), { bag: new Set([1, 2, 3]) });
  assert.equal(result.status, 'completed');
  const bag = result.context.input.bag;
  assert.ok(bag instanceof Set);
  assert.equal(Object.hasOwn(bag, 'size'), true);
  assert.equal(bag.size, 7);
  assert.deepEqual([...bag], [1, 2, 3]);

  result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.length.tag', type: 'string', default: 'T' },
  ]), { samples: new Uint8Array([1, 2]) });
  assert.equal(result.status, 'completed');
  const samples = result.context.input.samples;
  assert.ok(samples instanceof Uint8Array);
  assert.equal(Object.hasOwn(samples, 'length'), true);
  assert.equal(samples.length.tag, 'T');
  assert.deepEqual([...samples], [1, 2]);

  // The existing typed-array rule is untouched: an out-of-bounds canonical
  // index is still a type error.
  result = executeWorkflow(singleFormWorkflow([
    { path: 'samples.2', type: 'integer', default: 9 },
  ]), { samples: new Uint8Array([1, 2]) });
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'samples.2', code: 'type' }]);
});

test('async run: compensation sees the Map default frozen at the action success moment, on its own copy', async () => {
  const workflow = {
    id: 'proto-default-compensation',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'reserve', schema: { fields: [
        { path: 'options.size', type: 'integer', default: 7 },
        { path: 'options.meta.label', type: 'string', default: 'manual' },
      ] } },
      {
        id: 'reserve', type: 'action', operation: 'reserve',
        compensation: { operation: 'release' }, next: 'later',
      },
      { id: 'later', type: 'form', next: 'done', schema: { fields: [
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const callerMap = new Map([['k', 'v']]);
  const compSeen = [];
  const result = await executeWorkflowAsync(workflow, { options: callerMap }, {
    reserve: () => ({ id: 'tx-1' }),
    release: (input) => {
      compSeen.push({
        isMap: input.options instanceof Map,
        size: input.options.size,
        label: input.options.meta.label,
        entries: [...input.options.entries()],
      });
      input.options.set('comp-only', 1);
      input.options.size = 999;
      return 'released';
    },
  });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'later', path: 'missing.required', code: 'required' }]);
  assert.deepEqual(compSeen, [{
    isMap: true, size: 7, label: 'manual', entries: [['k', 'v']],
  }]);

  // The successful form's own defaults stay on the run input; the failed
  // form's writes and the compensation copy edits do not reach the Map.
  const options = result.context.input.options;
  assert.ok(options instanceof Map);
  assert.equal(options.size, 7);
  assert.equal(options.meta.label, 'manual');
  assert.deepEqual([...options.entries()], [['k', 'v']]);
  assert.equal(Object.hasOwn(callerMap, 'size'), false);
  assert.deepEqual([...callerMap.entries()], [['k', 'v']]);
  assert.deepEqual(result.context.output, { reserve: { id: 'tx-1' } });
});
