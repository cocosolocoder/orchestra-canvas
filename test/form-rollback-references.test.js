import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form rollback when the caller's input is a legal
// plain-object graph with shared and circular references: two fields point at
// the same ordinary object, and a field points back at the root. These are
// ordinary references, not shared memory — structuredClone preserves the
// topology, so the run input, the per-form snapshot and the rollback restore
// must all keep it intact.
//
// Shared shape for both entry points (neither workflow names a business
// operation, so the asynchronous run needs no implementations):
//
//   start -> prep (message action) -> form-one (succeeds, applies defaults)
//         -> form-two (writes into the shared object and creates fresh parent
//                      chains, then fails validation)
//         -> after (end, never reached)
//
// The failing form exercises every rollback boundary under references:
// - left.temp lands in the shared object the caller supplied — visible through
//   input.right and through the cycle input.self.left as well;
// - fresh.parent.deep creates a wholly new parent chain;
// - missing.required is a missing required value;
// - count is present but wrong-typed despite carrying a default.
function referenceRollbackWorkflow() {
  return {
    id: 'form-rollback-references',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'form-two', schema: { fields: [
        { path: 'one.top', type: 'string', default: 'A' },
        { path: 'left.fromOne', type: 'string', default: 'L1' },
      ] } },
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        { path: 'left.temp', type: 'string', default: 'T' },
        { path: 'fresh.parent.deep', type: 'string', default: 'deep' },
        { path: 'missing.required', type: 'string', required: true },
        { path: 'count', type: 'integer', default: 7 },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
}

// left and right are the same object; self points back at the root, so the
// shared object is also reachable as self.left / self.right.
const callerInput = () => {
  const shared = { original: 'kept' };
  const root = {
    raw: 'value',
    left: shared,
    right: shared,
    count: 'many',
  };
  root.self = root;
  return root;
};

// The run input once form-two fails: caller data verbatim, form-one's
// defaults retained (including the one written into the shared object),
// everything form-two wrote undone — with the original reference topology.
const expectedRolledBackInput = () => {
  const shared = { original: 'kept', fromOne: 'L1' };
  const root = {
    raw: 'value',
    left: shared,
    right: shared,
    count: 'many',
    one: { top: 'A' },
  };
  root.self = root;
  return root;
};

const expectedErrors = () => ([
  { nodeId: 'form-two', path: 'missing.required', code: 'required' },
  { nodeId: 'form-two', path: 'count', code: 'type' },
]);

const expectedTraceIds = ['start', 'prep', 'form-one', 'form-two'];

function assertRolledBackReferences(input) {
  assert.deepEqual(input, expectedRolledBackInput());

  // The restored input is not just field-equal: the reference relationships
  // survive the rollback. Fields that pointed at the same object still do,
  // and the cycle still returns to the restored root — no stale reference to
  // the pre-rollback (temporarily mutated) graph remains.
  assert.equal(input.self, input);
  assert.equal(input.left, input.right);
  assert.equal(input.self.left, input.right);
  assert.equal(input.self.self, input);

  // The failed form's leaf is gone from the shared object no matter which
  // reference reaches it: the direct one, the sibling alias, or the cycle.
  for (const view of [input.left, input.right, input.self.left]) {
    assert.equal(Object.hasOwn(view, 'temp'), false);
  }
  // The parent chain created solely for the failed form's default is gone
  // entirely, again also when reached through the cycle.
  assert.equal(Object.hasOwn(input, 'fresh'), false);
  assert.equal(Object.hasOwn(input, 'missing'), false);
  assert.equal(Object.hasOwn(input.self, 'fresh'), false);

  // The pre-existing shared parent keeps its original child and the earlier
  // successful form's default; only the failed form's write was undone.
  assert.deepEqual(input.left, { original: 'kept', fromOne: 'L1' });
  // The parent the successful form created survives with its child.
  assert.deepEqual(input.one, { top: 'A' });

  // The present-but-wrong-typed value is kept as-is: it was not treated as
  // missing, so the integer default never replaced it.
  assert.equal(input.count, 'many');
}

function assertCallerUntouched(caller, callerSnapshot) {
  // The caller's original object is never mutated — data and reference
  // relationships alike — and the successful form's defaults never leak into
  // it; they exist only in the run input.
  assert.deepEqual(caller, callerSnapshot);
  assert.equal(caller.self, caller);
  assert.equal(caller.left, caller.right);
  assert.deepEqual(caller.left, { original: 'kept' });
  assert.equal(Object.hasOwn(caller, 'one'), false);
  assert.equal(Object.hasOwn(caller, 'fresh'), false);
}

function assertIndependentCopy(input, caller) {
  // The returned run input is an independent copy of the caller's input at
  // every level of the shared structure.
  assert.notEqual(input, caller);
  assert.notEqual(input.left, caller.left);
  assert.notEqual(input.self, caller);
}

test('async run: a failed form rolls back its own writes across shared and circular references', async () => {
  const workflow = referenceRollbackWorkflow();
  const caller = callerInput();
  const callerSnapshot = structuredClone(caller);

  const result = await executeWorkflowAsync(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  // Errors keep their declaration order, node id, field path and usual code.
  assert.deepEqual(result.errors, expectedErrors());

  // The failed form is traced; its successor never runs; the earlier
  // action's saved output is not lost.
  assert.deepEqual(result.trace.map(node => node.nodeId), expectedTraceIds);
  assert.equal(result.trace.some(node => node.nodeId === 'after'), false);
  assert.deepEqual(result.context.output, { prep: 'prepared' });
  assert.deepEqual(result.actionAttempts, []);
  assert.equal(result.compensationStatus, 'not_needed');

  assertRolledBackReferences(result.context.input);
  assertCallerUntouched(caller, callerSnapshot);
  assertIndependentCopy(result.context.input, caller);
});

test('sync run: the same reference-aware rollback rules hold through executeWorkflow', () => {
  const workflow = referenceRollbackWorkflow();
  const caller = callerInput();
  const callerSnapshot = structuredClone(caller);

  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());
  assert.deepEqual(result.trace.map(node => node.nodeId), expectedTraceIds);
  assert.equal(result.trace.some(node => node.nodeId === 'after'), false);
  assert.deepEqual(result.context.output, { prep: 'prepared' });

  assertRolledBackReferences(result.context.input);
  assertCallerUntouched(caller, callerSnapshot);
  assertIndependentCopy(result.context.input, caller);
});

// Control under the same reference structure: when validation succeeds, the
// defaults the form wrote — including the one landing in the shared object —
// stay in place and a successor reads them through the other alias.
function referenceSuccessWorkflow() {
  return {
    id: 'form-references-success',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'check', schema: { fields: [
        { path: 'left.fromOne', type: 'string', default: 'L1' },
        { path: 'one.top', type: 'string', default: 'A' },
      ] } },
      // Reads the default through `right`, the alias the form never wrote to.
      { id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { field: 'right.fromOne', operator: 'eq', value: 'L1' } },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
}

function assertSuccessReferences(input) {
  // The successful defaults are present on every view of the shared object,
  // and the caller's reference topology is intact in the run input.
  assert.equal(input.self, input);
  assert.equal(input.left, input.right);
  assert.equal(input.left.fromOne, 'L1');
  assert.equal(input.right.fromOne, 'L1');
  assert.equal(input.self.left.fromOne, 'L1');
  assert.deepEqual(input.left, { original: 'kept', fromOne: 'L1' });
  assert.deepEqual(input.one, { top: 'A' });
  assert.equal(input.count, 'many');
}

test('sync control: a successful form keeps its defaults across shared and circular references', () => {
  const caller = callerInput();
  const callerSnapshot = structuredClone(caller);

  const result = executeWorkflow(referenceSuccessWorkflow(), caller);

  // The successor condition saw the default through the sibling alias, so
  // the run took the "seen" branch — normal default application is not
  // rolled back together with the failing-form protection.
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'form-one', 'check', 'seen']);

  assertSuccessReferences(result.context.input);
  assertCallerUntouched(caller, callerSnapshot);
  assertIndependentCopy(result.context.input, caller);
});

test('async control: the same successful defaults survive executeWorkflowAsync', async () => {
  const caller = callerInput();
  const callerSnapshot = structuredClone(caller);

  const result = await executeWorkflowAsync(referenceSuccessWorkflow(), caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'form-one', 'check', 'seen']);

  assertSuccessReferences(result.context.input);
  assertCallerUntouched(caller, callerSnapshot);
  assertIndependentCopy(result.context.input, caller);
});
