import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form rollback when a missing field's default lands
// on an own property of a Date already present in the run input.
//
// structuredClone copies a Date only by its internal time value and discards
// every property attached to it, so a per-form structuredClone snapshot used
// as the rollback target deleted successful earlier forms' Date defaults
// together with the failed form's writes. The snapshot must instead preserve
// those attached defaults, the Date type/time, and repeated/circular
// references throughout the graph.
//
// Shared shape for both entry points:
//
//   start -> form-one (succeeds, writes date.label)
//         -> reserve (business action + compensation in async runs; a message
//                    action in sync runs)
//         -> form-two (writes date.note and a fresh draft.* chain, then fails
//                      on a missing required approval)
//         -> after (end, never reached)
const WHEN_TIME = new Date('2026-03-14T08:30:00.000Z').getTime();

function dateRollbackWorkflow(reserveNode) {
  return {
    id: 'form-rollback-date',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'reserve', schema: { fields: [
        { path: 'date.label', type: 'string', default: '已安排' },
      ] } },
      reserveNode,
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        { path: 'date.note', type: 'string', default: '临时备注' },
        { path: 'draft.detail', type: 'string', default: '临时明细' },
        { path: 'approval', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
}

const callerInput = () => ({
  date: new Date(WHEN_TIME),
  meta: 'kept',
});

const expectedErrors = () => ([
  { nodeId: 'form-two', path: 'approval', code: 'required' },
]);

const expectedTraceIds = ['start', 'form-one', 'reserve', 'form-two'];

function assertDateRestored(input) {
  // The Date stays a Date with its original time value.
  assert.ok(input.date instanceof Date, 'date keeps its Date type after rollback');
  assert.equal(input.date.getTime(), WHEN_TIME);

  // The earlier successful form's own default on the Date survives the later
  // form's failure; the failed form's own write is undone.
  assert.equal(input.date.label, '已安排');
  assert.equal(Object.hasOwn(input.date, 'note'), false);

  // The parent chain created solely for the failed form's default vanishes.
  assert.equal(Object.hasOwn(input, 'draft'), false);
  // The missing required value is never written.
  assert.equal(Object.hasOwn(input, 'approval'), false);

  // Ordinary input that existed before either form ran is retained.
  assert.equal(input.meta, 'kept');
}

function assertCallerDateUntouched(caller) {
  // The caller's Date is never mutated: neither the successful nor the failed
  // form's defaults leak onto it.
  assert.ok(caller.date instanceof Date);
  assert.equal(caller.date.getTime(), WHEN_TIME);
  assert.equal(Object.hasOwn(caller.date, 'label'), false);
  assert.equal(Object.hasOwn(caller.date, 'note'), false);
  assert.equal(Object.hasOwn(caller, 'draft'), false);
}

test('async run: a failed form keeps an earlier form\'s Date default and undoes only its own writes', async () => {
  const workflow = dateRollbackWorkflow({
    id: 'reserve', type: 'action', operation: 'reserve',
    compensation: { operation: 'release' }, next: 'form-two',
  });
  const caller = callerInput();

  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    reserve: () => ({ id: 'tx-7' }),
    release: (input, output, returned) => {
      compensationSeen.push({ input, output, returned });
      return 'released';
    },
  });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());
  assert.deepEqual(result.trace.map(node => node.nodeId), expectedTraceIds);
  assert.equal(result.trace.some(node => node.nodeId === 'after'), false);

  assertDateRestored(result.context.input);

  // The earlier business action's output stays in place.
  assert.deepEqual(result.context.output, { reserve: { id: 'tx-7' } });

  // The successful action is compensated once under the unchanged rules. Its
  // independently captured snapshot still carries the Date by time value; the
  // form-rollback fix does not alter compensation behavior.
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.ok, r.result]), [
    ['reserve', 'release', true, 'released'],
  ]);
  assert.equal(compensationSeen.length, 1);
  assert.ok(compensationSeen[0].input.date instanceof Date);
  assert.equal(compensationSeen[0].input.date.getTime(), WHEN_TIME);
  assert.deepEqual(compensationSeen[0].returned, { id: 'tx-7' });

  // After compensation the run input still carries form-one's Date default;
  // the failure status and errors stand.
  assert.equal(result.context.input.date.label, '已安排');
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());

  assertCallerDateUntouched(caller);
  assert.notEqual(result.context.input.date, caller.date);
});

test('sync run: the same Date-aware rollback rules hold through executeWorkflow', () => {
  const workflow = dateRollbackWorkflow({
    id: 'reserve', type: 'action', message: 'reserved', next: 'form-two',
  });
  const caller = callerInput();

  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());
  assert.deepEqual(result.trace.map(node => node.nodeId), expectedTraceIds);
  assert.equal(result.trace.some(node => node.nodeId === 'after'), false);

  assertDateRestored(result.context.input);
  assert.deepEqual(result.context.output, { reserve: 'reserved' });

  assertCallerDateUntouched(caller);
  assert.notEqual(result.context.input.date, caller.date);
});

// Two input fields that point at the same Date must keep pointing at the same
// restored Date after rollback, with identical content through either view.
// Ordinary-object duplicate and circular references must survive as well.
function aliasRollbackWorkflow() {
  return {
    id: 'form-rollback-date-alias',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'form-two', schema: { fields: [
        { path: 'd1.label', type: 'string', default: '已安排' },
        { path: 'left.fromOne', type: 'string', default: 'L1' },
      ] } },
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        { path: 'd2.note', type: 'string', default: '临时备注' },
        { path: 'left.temp', type: 'string', default: '临时共享' },
        { path: 'draft.detail', type: 'string', default: '临时明细' },
        { path: 'approval', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
}

// d1 and d2 are the same Date; left and right are the same plain object; self
// points back at the root, so the shared objects are also reachable through it.
const aliasCallerInput = () => {
  const date = new Date(WHEN_TIME);
  const shared = { original: 'kept' };
  const root = { d1: date, d2: date, left: shared, right: shared };
  root.self = root;
  return root;
};

function assertAliasRollback(input) {
  assert.ok(input.d1 instanceof Date && input.d2 instanceof Date);
  // The two fields still alias one single restored Date.
  assert.equal(input.d1, input.d2);
  assert.equal(input.d1.getTime(), WHEN_TIME);

  // The successful default is visible through both views; the failed form's
  // write is gone through both.
  assert.equal(input.d1.label, '已安排');
  assert.equal(input.d2.label, '已安排');
  assert.equal(Object.hasOwn(input.d1, 'note'), false);
  assert.equal(Object.hasOwn(input.d2, 'note'), false);

  // Fresh parents the failed form created disappear.
  assert.equal(Object.hasOwn(input, 'draft'), false);
  assert.equal(Object.hasOwn(input.self, 'draft'), false);

  // Plain-object duplicate references and the cycle survive together with
  // the Date aliasing, including the earlier form's default on the shared
  // plain object; the failed form's write into that object is gone through
  // every view.
  assert.equal(input.self, input);
  assert.equal(input.left, input.right);
  assert.equal(input.self.left, input.right);
  assert.deepEqual(input.left, { original: 'kept', fromOne: 'L1' });
  for (const view of [input.left, input.right, input.self.left]) {
    assert.equal(Object.hasOwn(view, 'temp'), false);
  }
}

test('sync run: two fields aliasing one Date and plain-object cycles all restore consistently', () => {
  const caller = aliasCallerInput();
  const result = executeWorkflow(aliasRollbackWorkflow(), caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'form-one', 'form-two']);

  assertAliasRollback(result.context.input);

  // The caller's reference topology and objects are untouched.
  assert.equal(caller.d1, caller.d2);
  assert.equal(caller.left, caller.right);
  assert.equal(caller.self, caller);
  assert.equal(Object.hasOwn(caller.d1, 'label'), false);
  assert.deepEqual(caller.left, { original: 'kept' });
  assert.notEqual(result.context.input.d1, caller.d1);
});

test('async run: the same alias-aware rollback holds through executeWorkflowAsync', async () => {
  const caller = aliasCallerInput();
  const result = await executeWorkflowAsync(aliasRollbackWorkflow(), caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());
  assertAliasRollback(result.context.input);

  assert.equal(caller.d1, caller.d2);
  assert.equal(Object.hasOwn(caller.d1, 'label'), false);
  assert.notEqual(result.context.input.d1, caller.d1);
});

// Control: on success the default written onto the Date stays in the run
// input and a successor condition can read it.
function dateSuccessWorkflow() {
  return {
    id: 'form-date-success',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'check', schema: { fields: [
        { path: 'date.label', type: 'string', default: '已安排' },
      ] } },
      { id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { field: 'date.label', operator: 'eq', value: '已安排' } },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
}

test('sync control: a successful form keeps its Date default for later conditions', () => {
  const caller = { date: new Date(WHEN_TIME) };
  const result = executeWorkflow(dateSuccessWorkflow(), caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'form-one', 'check', 'seen']);
  assert.ok(result.context.input.date instanceof Date);
  assert.equal(result.context.input.date.getTime(), WHEN_TIME);
  assert.equal(result.context.input.date.label, '已安排');
  assert.equal(Object.hasOwn(caller.date, 'label'), false);
});

test('async control: the successful Date default survives executeWorkflowAsync', async () => {
  const caller = { date: new Date(WHEN_TIME) };
  const result = await executeWorkflowAsync(dateSuccessWorkflow(), caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assert.ok(result.context.input.date instanceof Date);
  assert.equal(result.context.input.date.getTime(), WHEN_TIME);
  assert.equal(result.context.input.date.label, '已安排');
  assert.equal(Object.hasOwn(caller.date, 'label'), false);
});

// The same protection applies to every internal-slot value structuredClone
// copies without its attached properties: a successful form's expando default
// on each survives a later form's failure, while the failed form's expando and
// the parents it created are undone. Each leaf stays its original kind/value.
test('rollback preserves earlier expandos and undoes later ones on every structured-clone leaf kind', () => {
  const cases = [
    ['Date', () => new Date(WHEN_TIME), leaf => { assert.ok(leaf instanceof Date); assert.equal(leaf.getTime(), WHEN_TIME); }],
    ['RegExp', () => /ok/gi, leaf => { assert.ok(leaf instanceof RegExp); assert.equal(leaf.source, 'ok'); assert.equal(leaf.flags, 'gi'); }],
    ['Map', () => new Map([['k', 1]]), leaf => { assert.ok(leaf instanceof Map); assert.deepEqual([...leaf], [['k', 1]]); }],
    ['Set', () => new Set(['a']), leaf => { assert.ok(leaf instanceof Set); assert.deepEqual([...leaf], ['a']); }],
    ['ArrayBuffer', () => new ArrayBuffer(4), leaf => { assert.ok(leaf instanceof ArrayBuffer); assert.equal(leaf.byteLength, 4); }],
    ['Uint8Array', () => new Uint8Array([7, 8, 9]), leaf => { assert.ok(leaf instanceof Uint8Array); assert.deepEqual([...leaf], [7, 8, 9]); }],
    ['boxed Number', () => new Number(5), leaf => { assert.equal(typeof leaf, 'object'); assert.equal(leaf.valueOf(), 5); }],
  ];

  for (const [kind, makeLeaf, assertKind] of cases) {
    const workflow = {
      id: `leaf-${kind}`,
      entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'f1' },
        { id: 'f1', type: 'form', next: 'f2', schema: { fields: [
          { path: 'leaf.keep', type: 'string', default: 'KEEP' },
        ] } },
        { id: 'f2', type: 'form', next: 'done', schema: { fields: [
          { path: 'leaf.drop', type: 'string', default: 'DROP' },
          { path: 'fresh.x', type: 'string', default: 'X' },
          { path: 'approval', type: 'string', required: true },
        ] } },
        { id: 'done', type: 'end', result: 'ok' },
      ],
    };
    const caller = { leaf: makeLeaf() };
    const result = executeWorkflow(workflow, caller);

    assert.equal(result.status, 'invalid_input', kind);
    assert.deepEqual(result.errors,
      [{ nodeId: 'f2', path: 'approval', code: 'required' }], kind);
    const { leaf } = result.context.input;
    assertKind(leaf);
    assert.equal(leaf.keep, 'KEEP', kind);
    assert.equal(Object.hasOwn(leaf, 'drop'), false, kind);
    assert.equal(Object.hasOwn(result.context.input, 'fresh'), false, kind);
    assert.equal(Object.hasOwn(caller.leaf, 'keep'), false, kind);
  }
});
