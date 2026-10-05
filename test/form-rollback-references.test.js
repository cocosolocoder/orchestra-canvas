import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form-default rollback on legal inputs whose graph is
// not a tree: the caller points multiple fields at the same ordinary object
// (shared references, not shared memory — every value is a plain object the
// engine already supports) and weaves cycles through that graph. No new field
// types and no execution-rule changes: the per-form snapshot taken before any
// field is processed (structuredClone preserves object identity and cycles)
// is what must protect these relationships across default insertion,
// validation failure and restore.
//
// Caller graph (all ordinary objects):
//
//   root
//   ├─ hub    ───────────────┐       S = { tag: 'kept' }  (shared, pre-existing)
//   ├─ linkA ─────► S ◄──────┘
//   ├─ linkB ─────► S
//   ├─ ring.self ─► root     (cycle)
//   └─ ring.peer ─► hub
//   ... n: 'many'            (present, wrong-typed; the field carries a default)
//
// Failure run:
//   start -> form-one (succeeds; adds a default into the shared object)
//         -> [prep message action in async runs]
//         -> form-bad (writes into the shared object AND creates parents for
//                      missing nested defaults, then fails on a missing
//                      required field and the wrong-typed field)
//         -> after (end, never reached)
//
// form-bad's temporary writes:
//   hub.ghost   — default written into the pre-existing shared object S
//   made.by.form — default at the leaf of a wholly new parent chain
//   n default   — must NOT happen: a present wrong-typed value reports type,
//                 never replaced by its default
//   missing.req — missing required field (and its created parent disappears)
//
// After the failure:
// - the run input keeps the caller's data plus form-one's retained default;
// - everything the failed form wrote, and parents created only for those
//   writes, are gone when viewed through ANY alias of the shared object
//   (linkA/linkB) or around the cycle (ring.self -> hub, ring.peer);
// - pre-existing parents and their other fields survive;
// - the restored graph is a fresh copy: aliases still point at the SAME
//   restored object, cycles still return to the restored root, and no live
//   reference reaches the pre-rollback data the failed form touched;
// - the caller's object and its reference relationships stay exactly as
//   passed; successful-form defaults live only in the run input, never in the
//   caller's graph.
//
// A success control under the same reference structure guards the other
// direction: valid forms keep their defaults (visible through aliases and
// read by a successor condition), so normal default insertion is never rolled
// back along with failures.

// Builds the caller input, returning the cyclic graph. Hub and ring are read
// back off the root by the tests when they need caller-side identities.
function buildCallerInput() {
  const root = {
    hub: { tag: 'kept' },
    linkA: undefined,
    linkB: undefined,
    ring: {},
    n: 'many',
  };
  root.linkA = root.hub;
  root.linkB = root.hub;
  root.ring.self = root; // cycle back to the root
  root.ring.peer = root.hub;
  return root;
}

function formOneNode(next) {
  return { id: 'form-one', type: 'form', next, schema: { fields: [
    { path: 'hub.oneDefault', type: 'string', default: 'ONE' },
  ] } };
}

function formBadNode(next) {
  return { id: 'form-bad', type: 'form', next, schema: { fields: [
    { path: 'hub.ghost', type: 'string', default: 'BOGUS' },
    { path: 'made.by.form', type: 'string', default: 'TEMP' },
    { path: 'missing.req', type: 'string', required: true },
    { path: 'n', type: 'integer', default: 9 },
  ] } };
}

function failingWorkflow({ withPrep }) {
  const nodes = [
    { id: 'start', type: 'trigger', next: 'form-one' },
    formOneNode(withPrep ? 'prep' : 'form-bad'),
  ];
  if (withPrep) {
    nodes.push({ id: 'prep', type: 'action', message: 'ready', next: 'form-bad' });
  }
  nodes.push(
    formBadNode('after'),
    { id: 'after', type: 'end', result: 'done' },
  );
  return { id: withPrep ? 'rollback-refs-fail-async' : 'rollback-refs-fail-sync', entry: 'start', nodes };
}

const expectedErrors = () => ([
  { nodeId: 'form-bad', path: 'missing.req', code: 'required' },
  { nodeId: 'form-bad', path: 'n', code: 'type' },
]);

// Content shape of the restored run input (assert.deepEqual traverses cycles
// and preserves the distinction between shared and distinct objects).
function expectedRestoredContent() {
  const root = {
    hub: { tag: 'kept', oneDefault: 'ONE' },
    linkA: undefined,
    linkB: undefined,
    ring: {},
    n: 'many',
  };
  root.linkA = root.hub;
  root.linkB = root.hub;
  root.ring.self = root;
  root.ring.peer = root.hub;
  return root;
}

// Every content and identity guarantee the restored run input must satisfy;
// shared by the sync and async failure tests.
function assertRestoredGraph(result, { traceIds, output }) {
  const input = result.context.input;

  // Content is right, cycle and all.
  assert.deepEqual(input, expectedRestoredContent());

  // The failed form's leaf in the pre-existing shared object is gone through
  // every alias, and around the cycle in both directions.
  for (const view of [input.hub, input.linkA, input.linkB, input.ring.peer, input.ring.self.hub]) {
    assert.equal(Object.hasOwn(view, 'ghost'), false);
    assert.deepEqual(view, { tag: 'kept', oneDefault: 'ONE' });
  }

  // Wholly new parent chains created only for the failed form disappear.
  assert.equal(Object.hasOwn(input, 'made'), false);
  assert.equal(Object.hasOwn(input, 'missing'), false);

  // Identities inside the restored graph: aliases still name the same object,
  // the cycle still returns to the restored root (repeatedly), and cycling
  // around still lands on the same hub.
  assert.equal(input.linkA, input.hub);
  assert.equal(input.linkB, input.hub);
  assert.equal(input.ring.peer, input.hub);
  assert.equal(input.ring.self, input);
  assert.equal(input.ring.self.ring.self, input);
  assert.equal(input.ring.self.linkA, input.hub);
  assert.equal(input.ring.self.ring.peer, input.hub);

  // The present wrong-typed value survives; its integer default never
  // replaced it.
  assert.equal(input.n, 'many');

  assert.deepEqual(result.trace.map(n => n.nodeId), traceIds);
  assert.equal(result.trace.some(n => n.nodeId === 'after'), false);
  assert.deepEqual(result.errors, expectedErrors());
  if (output) assert.deepEqual(result.context.output, output);
}

// The caller graph must be untouched in both content and identity, including
// the absence of either form's defaults (form-one succeeds, but its default
// belongs to the run input only).
function assertCallerUntouched(caller, callerHub) {
  assert.equal(caller.hub, callerHub);
  assert.equal(caller.linkA, caller.hub);
  assert.equal(caller.linkB, caller.hub);
  assert.equal(caller.ring.self, caller);
  assert.equal(caller.ring.peer, caller.hub);
  assert.deepEqual(caller.hub, { tag: 'kept' });
  assert.equal(Object.hasOwn(caller.hub, 'oneDefault'), false);
  assert.equal(Object.hasOwn(caller.hub, 'ghost'), false);
  assert.equal(Object.hasOwn(caller, 'made'), false);
  assert.equal(Object.hasOwn(caller, 'missing'), false);
  assert.equal(caller.n, 'many');
}

test('sync: rollback after a failed form preserves shared references and cycles; earlier successful default kept', () => {
  const workflow = failingWorkflow({ withPrep: false });
  const caller = buildCallerInput();
  const callerHub = caller.hub;

  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.trace.map(n => n.type), ['trigger', 'form', 'form']);
  assertRestoredGraph(result, { traceIds: ['start', 'form-one', 'form-bad'] });

  // Independent copy: no restored object is an object the caller still holds,
  // even though the same relationships exist inside the restored graph.
  const input = result.context.input;
  assert.notEqual(input, caller);
  assert.notEqual(input.hub, callerHub);
  assert.notEqual(input.ring, caller.ring);
  assert.notEqual(input.ring.self, caller);

  assertCallerUntouched(caller, callerHub);
});

test('async: the same reference-preserving rollback holds through executeWorkflowAsync; the earlier action output survives', async () => {
  // The async scenario uses a workflow with no business operations; a legacy
  // message action between the forms proves previously saved action output is
  // not lost when the later form fails.
  const workflow = failingWorkflow({ withPrep: true });
  const caller = buildCallerInput();
  const callerHub = caller.hub;

  const result = await executeWorkflowAsync(workflow, caller, {});

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.trace.map(n => n.type), ['trigger', 'form', 'action', 'form']);
  assertRestoredGraph(result, {
    traceIds: ['start', 'form-one', 'prep', 'form-bad'],
    output: { prep: 'ready' },
  });

  // No compensable business action ran.
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);

  const input = result.context.input;
  assert.notEqual(input, caller);
  assert.notEqual(input.hub, callerHub);
  assert.notEqual(input.ring, caller.ring);
  assert.notEqual(input.ring.self, caller);

  assertCallerUntouched(caller, callerHub);
});

// Success control: with the same shared/cyclic reference structure, two
// valid forms keep their defaults — including one written into the shared
// object and one behind a newly created parent chain — and a successor
// condition reads the shared-object default through the run input. The
// control guards against rolling back normal default insertion.
function successWorkflow() {
  return {
    id: 'rollback-refs-success',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      formOneNode('form-two'),
      { id: 'form-two', type: 'form', next: 'check', schema: { fields: [
        { path: 'hub.twoDefault', type: 'string', default: 'TWO' },
        { path: 'made.by.form', type: 'string', default: 'TEMP' },
      ] } },
      {
        id: 'check', type: 'condition',
        condition: { field: 'hub.twoDefault', operator: 'eq', value: 'TWO' },
        then: 'good', else: 'bad',
      },
      { id: 'good', type: 'end', result: 'passed' },
      { id: 'bad', type: 'end', result: 'failed' },
    ],
  };
}

function expectedSuccessfulContent() {
  const root = {
    hub: { tag: 'kept', oneDefault: 'ONE', twoDefault: 'TWO' },
    linkA: undefined,
    linkB: undefined,
    ring: {},
    n: 'many',
    made: { by: { form: 'TEMP' } },
  };
  root.linkA = root.hub;
  root.linkB = root.hub;
  root.ring.self = root;
  root.ring.peer = root.hub;
  return root;
}

function assertSuccessfulGraph(result, caller, callerHub) {
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'passed');
  assert.deepEqual(result.trace.map(n => n.nodeId),
    ['start', 'form-one', 'form-two', 'check', 'good']);

  const input = result.context.input;
  assert.deepEqual(input, expectedSuccessfulContent());

  // Both successful forms' defaults survive, visible through every alias and
  // around the cycle; the new parent chain the valid form created stays.
  for (const view of [input.hub, input.linkA, input.linkB, input.ring.peer, input.ring.self.hub]) {
    assert.deepEqual(view, { tag: 'kept', oneDefault: 'ONE', twoDefault: 'TWO' });
  }
  assert.equal(input.made.by.form, 'TEMP');

  // Reference relationships are intact in the completed run input.
  assert.equal(input.linkA, input.hub);
  assert.equal(input.linkB, input.hub);
  assert.equal(input.ring.peer, input.hub);
  assert.equal(input.ring.self, input);
  assert.equal(input.ring.self.ring.self, input);

  // Still an independent copy of the caller graph.
  assert.notEqual(input, caller);
  assert.notEqual(input.hub, callerHub);
  assertCallerUntouched(caller, callerHub);
}

test('sync control: valid forms under the same shared/cyclic graph keep defaults and a successor condition reads them', () => {
  const workflow = successWorkflow();
  const caller = buildCallerInput();
  const callerHub = caller.hub;

  const result = executeWorkflow(workflow, caller);
  assertSuccessfulGraph(result, caller, callerHub);
});

test('async control: the same successful default retention and identity holds through executeWorkflowAsync', async () => {
  const workflow = successWorkflow();
  const caller = buildCallerInput();
  const callerHub = caller.hub;

  const result = await executeWorkflowAsync(workflow, caller, {});
  assert.equal(result.compensationStatus, 'not_needed');
  assertSuccessfulGraph(result, caller, callerHub);
});
