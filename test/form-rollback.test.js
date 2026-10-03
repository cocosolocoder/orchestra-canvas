import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Scenario shared by the sync and async regression runs:
//
//   start -> prep (message) -> first-form (defaults) -> reserve
//   -> second-form (defaults) -> final-form (fails after applying defaults)
//   -> after-form (must never run) -> done
//
// The async variant turns `reserve` into a real compensable business action;
// the sync/parity variant keeps it a legacy message action.
//
// The caller input deliberately covers every rollback edge:
// - undeclared top-level values (callerField, note) must survive untouched,
// - an existing parent (`existing`) gains a defaulted child in the failed
//   form: only the child may disappear, the parent and its own key remain,
// - a parent (`shared`) holding caller data and defaults from the two
//   successful forms gains another child in the failed form: only that last
//   child is removed,
// - a present-but-wrong-typed value (`zzWrong`) must be reported as a type
//   error and never replaced by its declared default.
function callerInput() {
  return {
    callerField: 'kept',
    note: 'caller-note',
    existing: { kept: 1 },
    shared: { callerSibling: 'x' },
    zzWrong: 123,
  };
}

function scenarioWorkflow({ compensable }) {
  const reserve = compensable
    ? { id: 'reserve', type: 'action', operation: 'reserve', compensation: { operation: 'release' }, next: 'second-form' }
    : { id: 'reserve', type: 'action', message: 'reserved', next: 'second-form' };
  return {
    id: 'form-rollback',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'first-form' },
      { id: 'first-form', type: 'form', next: 'reserve', schema: { fields: [
        { path: 'first.one', type: 'string', default: 'F1' },
        { path: 'firstTop', type: 'string', default: 'top1' },
        { path: 'shared.fromFirst', type: 'boolean', default: true },
      ] } },
      reserve,
      { id: 'second-form', type: 'form', next: 'final-form', schema: { fields: [
        { path: 'second.deep.value', type: 'integer', default: 42 },
        { path: 'secondTop', type: 'integer', default: 9 },
        { path: 'shared.fromSecond', type: 'string', default: 's2' },
      ] } },
      { id: 'final-form', type: 'form', next: 'after-form', schema: { fields: [
        // Applied before the form fails. The newChain parent chain is created
        // by this form alone and must vanish wholesale; the other two land in
        // pre-existing parents and only the added keys are removed.
        { path: 'newChain.a.b.c', type: 'string', default: 'temp' },
        { path: 'existing.added', type: 'string', default: 'temp2' },
        { path: 'shared.fromFailed', type: 'string', default: 'temp3' },
        { path: 'zzRequired', type: 'string', required: true },
        // Present in the caller with the wrong type: this must be a type
        // error, not a missing value the default gets to replace.
        { path: 'zzWrong', type: 'string', default: 'should-not-apply' },
      ] } },
      { id: 'after-form', type: 'action', message: 'should-not-run', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
}

// Run input after the failed form: caller data verbatim plus exactly the
// defaults of the two successful forms; nothing from final-form remains.
function rolledBackInput() {
  return {
    callerField: 'kept',
    note: 'caller-note',
    existing: { kept: 1 },
    shared: { callerSibling: 'x', fromFirst: true, fromSecond: 's2' },
    zzWrong: 123,
    first: { one: 'F1' },
    firstTop: 'top1',
    second: { deep: { value: 42 } },
    secondTop: 9,
  };
}

const expectedErrors = [
  { nodeId: 'final-form', path: 'zzRequired', code: 'required' },
  { nodeId: 'final-form', path: 'zzWrong', code: 'type' },
];

const expectedTrace = [
  ['start', 'trigger'],
  ['prep', 'action'],
  ['first-form', 'form'],
  ['reserve', 'action'],
  ['second-form', 'form'],
  ['final-form', 'form'],
];

test('a failed form rolls back only its own defaults, keeping caller data and earlier successful forms', () => {
  const input = callerInput();
  const execution = executeWorkflow(scenarioWorkflow({ compensable: false }), input);

  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.errors, expectedErrors);
  assert.deepEqual(execution.context.input, rolledBackInput());

  // The multi-level parent chain the failed form created disappears...
  assert.equal(Object.hasOwn(execution.context.input, 'newChain'), false);
  // ...while a successful form's multi-level created chain stays, and the
  // parents that already existed are never deleted for one bad child.
  assert.deepEqual(execution.context.input.second, { deep: { value: 42 } });
  assert.deepEqual(execution.context.input.existing, { kept: 1 });
  assert.deepEqual(execution.context.input.shared, {
    callerSibling: 'x', fromFirst: true, fromSecond: 's2',
  });
  // The wrong-typed present value is retained, never replaced by a default.
  assert.equal(execution.context.input.zzWrong, 123);

  // The trace ends at the failing form; later ordinary nodes do not run, but
  // the earlier action output is preserved.
  assert.deepEqual(execution.trace.map(n => [n.nodeId, n.type]), expectedTrace);
  assert.equal(execution.context.output['after-form'], undefined);
  assert.deepEqual(execution.context.output, { prep: 'prepared', reserve: 'reserved' });

  // The caller's own object stays byte-for-byte as passed in.
  assert.deepEqual(input, callerInput());
});

test('sync and async entries apply the identical failed-form rollback rules', async () => {
  const workflow = scenarioWorkflow({ compensable: false });

  const syncInput = callerInput();
  const asyncInput = callerInput();
  const syncRun = executeWorkflow(workflow, syncInput);
  const asyncRun = await executeWorkflowAsync(workflow, asyncInput, {});

  for (const execution of [syncRun, asyncRun]) {
    assert.equal(execution.status, 'invalid_input');
    assert.deepEqual(execution.errors, expectedErrors);
    assert.deepEqual(execution.context.input, rolledBackInput());
    assert.deepEqual(execution.trace.map(n => [n.nodeId, n.type]), expectedTrace);
    assert.equal(execution.context.output['after-form'], undefined);
  }
  assert.deepEqual(syncInput, callerInput());
  assert.deepEqual(asyncInput, callerInput());
});

test('the compensation snapshot stays at the business action success moment and the post-compensation run keeps later form defaults', async () => {
  const seen = [];
  const input = callerInput();
  const execution = await executeWorkflowAsync(scenarioWorkflow({ compensable: true }), input, {
    reserve: () => ({ reservationId: 'r-1' }),
    release: (compInput, compOutput, result, nodeId, attempt) => {
      seen.push({
        input: structuredClone(compInput),
        output: structuredClone(compOutput),
        result: structuredClone(result),
        nodeId, attempt,
      });
      // Mutations of the fresh copies must not leak back into the run.
      compInput.injectedByCompensation = true;
      compInput.second = { hijacked: true };
      compOutput.tampered = true;
      result.reservationId = 'changed';
      return 'released';
    },
  });

  // The run still ends on the failed form, with status and errors untouched
  // by compensation.
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.errors, expectedErrors);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.trace.map(n => [n.nodeId, n.type]), expectedTrace);
  assert.equal(execution.context.output['after-form'], undefined);

  // The earlier business action's success output is retained through both
  // the form failure and the compensation.
  assert.deepEqual(execution.context.output, {
    prep: 'prepared',
    reserve: { reservationId: 'r-1' },
  });
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['reserve', 1, true],
  ]);

  // Compensation ran exactly once for reserve, with the snapshot captured
  // when reserve succeeded: the first form's defaults are present...
  assert.equal(seen.length, 1);
  assert.equal(seen[0].nodeId, 'reserve');
  assert.equal(seen[0].attempt, 1);
  assert.deepEqual(seen[0].input, {
    callerField: 'kept',
    note: 'caller-note',
    existing: { kept: 1 },
    shared: { callerSibling: 'x', fromFirst: true },
    zzWrong: 123,
    first: { one: 'F1' },
    firstTop: 'top1',
  });
  // ...but defaults the second form applied after the action succeeded, and
  // anything the failed form briefly wrote, never enter the snapshot.
  assert.equal(Object.hasOwn(seen[0].input, 'second'), false);
  assert.equal(Object.hasOwn(seen[0].input, 'secondTop'), false);
  assert.equal(Object.hasOwn(seen[0].input, 'newChain'), false);
  assert.equal(seen[0].input.shared.fromSecond, undefined);
  assert.equal(seen[0].input.shared.fromFailed, undefined);
  assert.deepEqual(seen[0].output, { prep: 'prepared' });
  assert.deepEqual(seen[0].result, { reservationId: 'r-1' });

  // After compensation finishes the run input still carries the second
  // successful form's defaults and the failure rollback, immune to the
  // compensation's argument mutations.
  assert.deepEqual(execution.context.input, rolledBackInput());
  assert.equal(Object.hasOwn(execution.context.input, 'newChain'), false);
  assert.equal(Object.hasOwn(execution.context.input, 'injectedByCompensation'), false);
  assert.equal(execution.context.output.tampered, undefined);

  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['reserve', 'release', 1, true, 'released'],
  ]);
  assert.deepEqual(input, callerInput());
});

test('a parent chain created and shared by several fields of the failed form disappears entirely', () => {
  const workflow = {
    id: 'shared-created-parent',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'p.q', type: 'string', default: 'Q' },
        { path: 'p.r', type: 'string', default: 'R' },
        { path: 'needed', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.errors, [{ nodeId: 'collect', path: 'needed', code: 'required' }]);
  assert.deepEqual(execution.context.input, {});
  assert.equal(Object.hasOwn(execution.context.input, 'p'), false);
});

test('errors keep field declaration order across codes and a successful first form survives the second form failure', () => {
  const workflow = {
    id: 'ordered-errors',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'first' },
      { id: 'first', type: 'form', next: 'second', schema: { fields: [
        { path: 'earlier.defaulted', type: 'string', default: 'stay' },
      ] } },
      { id: 'second', type: 'form', next: 'done', schema: { fields: [
        // Creates a parent before the errors below are collected; it must be
        // rolled back with this form only.
        { path: 'created.x', type: 'string', default: 'gone' },
        // Declared first among the bad fields, type code.
        { path: 'badType', type: 'string' },
        // Declared second, range code.
        { path: 'tooSmall', type: 'integer', min: 10 },
        // Declared last, required code — order follows declaration, not the
        // required -> type -> range priority within a single field.
        { path: 'needMe', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, { badType: 5, tooSmall: 1 });
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.errors, [
    { nodeId: 'second', path: 'badType', code: 'type' },
    { nodeId: 'second', path: 'tooSmall', code: 'range' },
    { nodeId: 'second', path: 'needMe', code: 'required' },
  ]);
  // The first form's created parent stays; the failed form's own created
  // parent and defaulted value are gone, caller values retained.
  assert.deepEqual(execution.context.input, {
    badType: 5,
    tooSmall: 1,
    earlier: { defaulted: 'stay' },
  });
  assert.equal(Object.hasOwn(execution.context.input, 'created'), false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'first', 'second']);
});
