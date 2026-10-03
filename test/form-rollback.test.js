import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Shared shape for both entry points:
//
//   start -> prep (message action) -> form-one (succeeds, applies defaults)
//         -> reserve (business action + compensation in async runs; a message
//                    action in sync runs)
//         -> form-two (succeeds, applies more defaults)
//         -> form-three (applies several defaults, then fails validation)
//         -> after (end, never reached)
//
// The failing form exercises every rollback boundary:
// - brand.new.deep / fresh.pair.x / fresh.pair.y create wholly new parent
//   chains, one with two sibling fields written by the failed form itself;
// - shared.leaf lands in a parent object the caller supplied;
// - later.temp lands in a parent an earlier successful form created;
// - missing.required is a missing required value;
// - count is present but wrong-typed despite carrying a default;
// - sized is present but violates its length constraint.
function rollbackWorkflow(reserveNode) {
  return {
    id: 'form-rollback-regression',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'reserve', schema: { fields: [
        { path: 'one.top', type: 'string', default: 'A' },
        { path: 'flat', type: 'integer', default: 1 },
      ] } },
      reserveNode,
      { id: 'form-two', type: 'form', next: 'form-three', schema: { fields: [
        { path: 'later.keep', type: 'string', default: 'B' },
      ] } },
      { id: 'form-three', type: 'form', next: 'after', schema: { fields: [
        { path: 'brand.new.deep', type: 'string', default: 'deep' },
        { path: 'fresh.pair.x', type: 'string', default: 'x' },
        { path: 'fresh.pair.y', type: 'string', default: 'y' },
        { path: 'shared.leaf', type: 'string', default: 'leaf' },
        { path: 'later.temp', type: 'string', default: 'T' },
        { path: 'missing.required', type: 'string', required: true },
        { path: 'count', type: 'integer', default: 7 },
        { path: 'sized', type: 'string', maxLength: 3 },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
}

const callerInput = () => ({
  raw: 'value',
  extra: { nested: 1 },
  shared: { original: 'kept' },
  count: 'many',
  sized: 'toolong',
});

// The run input once form-three fails: caller data verbatim, defaults of the
// two successful forms retained, everything the failed form wrote undone.
const expectedRolledBackInput = () => ({
  raw: 'value',
  extra: { nested: 1 },
  shared: { original: 'kept' },
  count: 'many',
  sized: 'toolong',
  one: { top: 'A' },
  flat: 1,
  later: { keep: 'B' },
});

const expectedErrors = () => ([
  { nodeId: 'form-three', path: 'missing.required', code: 'required' },
  { nodeId: 'form-three', path: 'count', code: 'type' },
  { nodeId: 'form-three', path: 'sized', code: 'length' },
]);

const expectedTraceIds = ['start', 'prep', 'form-one', 'reserve', 'form-two', 'form-three'];

function assertRolledBackInput(result) {
  assert.deepEqual(result.context.input, expectedRolledBackInput());

  // Parent chains created solely for the failed form's defaults disappear
  // completely — including a parent that held two of that form's defaults.
  assert.equal(Object.hasOwn(result.context.input, 'brand'), false);
  assert.equal(Object.hasOwn(result.context.input, 'fresh'), false);
  assert.equal(Object.hasOwn(result.context.input, 'missing'), false);

  // A pre-existing parent keeps its original children but loses the leaf the
  // failed form added.
  assert.deepEqual(result.context.input.shared, { original: 'kept' });
  // A parent an earlier form created survives with that form's child; the
  // failed form's sibling is gone.
  assert.deepEqual(result.context.input.later, { keep: 'B' });

  // The present-but-wrong-typed value is kept as-is: it was not treated as
  // missing, so the integer default never replaced it.
  assert.equal(result.context.input.count, 'many');
}

test('async run: a failed form rolls back only its own defaults while compensation uses the success-time snapshot', async () => {
  const workflow = rollbackWorkflow({
    id: 'reserve', type: 'action', operation: 'reserve',
    compensation: { operation: 'release' }, next: 'form-two',
  });
  const caller = callerInput();
  const callerSnapshot = structuredClone(caller);

  const reserveSeen = [];
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    reserve: (input, output, nodeId, attempt) => {
      reserveSeen.push({ input: structuredClone(input), output: structuredClone(output), nodeId, attempt });
      return { id: 'tx-7' };
    },
    release: (input, output, returned, nodeId, attempt) => {
      compensationSeen.push({
        input: structuredClone(input),
        output: structuredClone(output),
        result: structuredClone(returned),
        nodeId, attempt,
      });
      return 'released';
    },
  });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());

  assert.deepEqual(result.trace.map(node => node.nodeId), expectedTraceIds);
  assert.equal(result.trace.some(node => node.nodeId === 'after'), false);
  assert.deepEqual(result.trace.map(node => node.type),
    ['trigger', 'action', 'form', 'action', 'form', 'form']);

  assertRolledBackInput(result);

  // The earlier business action's successful output stays in place.
  assert.deepEqual(result.context.output, { prep: 'prepared', reserve: { id: 'tx-7' } });

  // The caller's original object is never mutated.
  assert.deepEqual(caller, callerSnapshot);

  // The business action itself saw the input as of its own success: with
  // form-one's defaults, before form-two ran.
  assert.equal(reserveSeen.length, 1);
  assert.deepEqual(reserveSeen[0].input, {
    raw: 'value', extra: { nested: 1 }, shared: { original: 'kept' },
    count: 'many', sized: 'toolong',
    one: { top: 'A' }, flat: 1,
  });
  assert.deepEqual(reserveSeen[0].output, { prep: 'prepared' });
  assert.equal(reserveSeen[0].nodeId, 'reserve');
  assert.equal(reserveSeen[0].attempt, 1);

  // The earlier successful action is compensated once under the usual rules.
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['reserve', 'release', 1, true, 'released'],
  ]);

  assert.equal(compensationSeen.length, 1);
  // Compensation input is frozen at the action's success moment: form-one's
  // defaults are in it; form-two's defaults and anything the failed form
  // temporarily wrote never leak in.
  assert.deepEqual(compensationSeen[0].input, {
    raw: 'value', extra: { nested: 1 }, shared: { original: 'kept' },
    count: 'many', sized: 'toolong',
    one: { top: 'A' }, flat: 1,
  });
  assert.equal(Object.hasOwn(compensationSeen[0].input, 'later'), false);
  assert.equal(Object.hasOwn(compensationSeen[0].input, 'brand'), false);
  assert.equal(Object.hasOwn(compensationSeen[0].input, 'fresh'), false);
  assert.deepEqual(compensationSeen[0].output, { prep: 'prepared' });
  assert.deepEqual(compensationSeen[0].result, { id: 'tx-7' });
  assert.equal(compensationSeen[0].nodeId, 'reserve');
  assert.equal(compensationSeen[0].attempt, 1);

  // After compensation finishes, the run input still carries form-two's
  // successful defaults, and the original failure status and errors stand.
  assert.equal(result.context.input.later.keep, 'B');
  assert.equal(Object.hasOwn(result.context.input, 'later') && !Object.hasOwn(result.context.input.later, 'temp'), true);
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());
});

test('sync run: the same form rollback rules hold through executeWorkflow', () => {
  const workflow = rollbackWorkflow({
    id: 'reserve', type: 'action', message: 'reserved', next: 'form-two',
  });
  const caller = callerInput();
  const callerSnapshot = structuredClone(caller);

  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, expectedErrors());
  assert.deepEqual(result.trace.map(node => node.nodeId), expectedTraceIds);
  assert.equal(result.trace.some(node => node.nodeId === 'after'), false);

  assertRolledBackInput(result);
  assert.deepEqual(result.context.output, { prep: 'prepared', reserve: 'reserved' });
  assert.deepEqual(caller, callerSnapshot);
});

test('a present wrong-typed value triggers type, not a default substitution, and its form rollback still clears created parents', () => {
  const workflow = {
    id: 'wrong-type-kept',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'a.b', type: 'string', default: 'defaulted' },
        { path: 'n', type: 'integer', default: 7 },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = { n: 'oops' };
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [{ nodeId: 'collect', path: 'n', code: 'type' }]);
  // The default for n never landed; the caller value survived the rollback;
  // the parent chain the other field created was removed with its form.
  assert.deepEqual(result.context.input, { n: 'oops' });
  assert.deepEqual(caller, { n: 'oops' });
});
