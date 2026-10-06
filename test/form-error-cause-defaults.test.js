import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form defaults that land on a Date reachable only
// through an Error's "cause". Forms apply defaults on the live run input, so
// context.input and later conditions always saw them; but the independent
// copies handed to business actions and compensations are rebuilt from a
// structured clone, and the reattachment walk followed only enumerable own
// properties — an Error's cause is non-enumerable, so every default under it
// was silently lost in those copies. These tests pin the fix: defaults under
// cause chains (cause is the Date itself, a plain object holding the Date, or
// another Error whose cause continues the chain) reach every copy, the Date
// keeps its type and time, the Error keeps its message and cause content,
// aliases stay aliases within one copy, and every copy stays independent of
// the run input, the caller's input and every other copy.

const WHEN = Date.parse('2024-01-02T03:04:05.000Z');

// start -> form-one (adds defaults onto the Date inside failure's cause)
//       -> act (business + compensation in async runs; a message in sync)
//       -> check (condition reading the defaults through the cause)
//       -> seen / missed (two ends)
function causeDefaultWorkflow(actNode, extraFormFields = []) {
  return {
    id: 'error-cause-form-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        // A default landing directly on the Date inside the Error's cause.
        { path: 'failure.cause.createdAt.channel', type: 'string', default: 'web' },
        // A multi-level path whose parents are created on that Date.
        { path: 'failure.cause.createdAt.meta.source', type: 'string', default: 'form' },
        ...extraFormFields,
      ] } },
      actNode,
      {
        id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { all: [
          { field: 'failure.cause.createdAt.channel', operator: 'eq', value: 'web' },
          { field: 'failure.cause.createdAt.meta.source', operator: 'eq', value: 'form' },
        ] },
      },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
}

// The failure Error carries a non-enumerable cause holding the Date; a second
// input field aliases the same Date from outside the cause chain.
function callerInput() {
  const createdAt = new Date(WHEN);
  const failure = new Error('boom', { cause: { createdAt } });
  return { failure, note: { at: createdAt } };
}

function assertCauseDefaults(input) {
  assert.ok(input.failure instanceof Error, 'the value stays an Error');
  assert.equal(input.failure.message, 'boom', 'the Error keeps its message');
  const { createdAt } = input.failure.cause;
  assert.ok(createdAt instanceof Date, 'the cause Date stays a Date');
  assert.equal(createdAt.getTime(), WHEN, 'the Date keeps its time value');
  assert.equal(createdAt.channel, 'web');
  assert.deepEqual(createdAt.meta, { source: 'form' });
}

test('async: a business action reads defaults attached to a Date inside an Error cause', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    compensation: { operation: 'undo' }, next: 'check',
  });
  const caller = callerInput();
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input, output, nodeId, attempt) => {
      assertCauseDefaults(input);
      assert.equal(nodeId, 'act');
      assert.equal(attempt, 1);
      // The Date aliased from outside the cause chain is the same copied Date.
      assert.equal(input.note.at, input.failure.cause.createdAt);
      assert.equal(input.note.at.channel, 'web');
      // The copy shares nothing with the caller's objects.
      assert.notEqual(input.failure, caller.failure);
      assert.notEqual(input.failure.cause.createdAt, caller.failure.cause.createdAt);
      // Mutating this copy — the Date, the defaults, a created parent and a
      // brand-new property — stays within the copy.
      input.failure.cause.createdAt.setTime(0);
      input.failure.cause.createdAt.channel = 'hacked';
      delete input.failure.cause.createdAt.meta;
      input.failure.cause.createdAt.addedByAction = true;
      input.failure.message = 'rewritten';
      return { ok: true };
    },
    undo: () => 'undone',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible', 'the condition read the defaults straight off context.input');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one', 'act', 'check', 'seen']);

  // The run input keeps the defaults; nothing the action did reached it.
  assertCauseDefaults(result.context.input);
  assert.equal(result.context.input.note.at, result.context.input.failure.cause.createdAt);
  assert.equal(Object.hasOwn(result.context.input.failure.cause.createdAt, 'addedByAction'), false);
  assert.equal(result.context.input.failure.message, 'boom');

  // The caller's Error, cause and Date were never mutated nor given defaults.
  assert.equal(caller.failure.message, 'boom');
  assert.equal(caller.failure.cause.createdAt.getTime(), WHEN);
  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.meta, undefined);
  assert.equal(caller.note.at, caller.failure.cause.createdAt);
});

test('async: the cause itself is the Date carrying the defaults', async () => {
  const workflow = {
    id: 'error-cause-is-date',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.cause.channel', type: 'string', default: 'web' },
        { path: 'failure.cause.meta.source', type: 'string', default: 'form' },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const failure = new Error('boom', { cause: new Date(WHEN) });
  const result = await executeWorkflowAsync(workflow, { failure }, {
    op: (input) => {
      assert.ok(input.failure.cause instanceof Date);
      assert.equal(input.failure.cause.getTime(), WHEN);
      assert.equal(input.failure.cause.channel, 'web');
      assert.deepEqual(input.failure.cause.meta, { source: 'form' });
      return 'A';
    },
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.context.input.failure.cause instanceof Date);
  assert.equal(result.context.input.failure.cause.channel, 'web');
});

test('async: a cause chain through another Error reaches the Date', async () => {
  const workflow = {
    id: 'error-cause-chain',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.cause.cause.createdAt.channel', type: 'string', default: 'web' },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  // The Date sits behind two non-enumerable cause links.
  const inner = new Error('inner', { cause: { createdAt: new Date(WHEN) } });
  const failure = new Error('outer', { cause: inner });
  const result = await executeWorkflowAsync(workflow, { failure }, {
    op: (input) => {
      assert.ok(input.failure instanceof Error);
      assert.equal(input.failure.message, 'outer');
      assert.ok(input.failure.cause instanceof Error);
      assert.equal(input.failure.cause.message, 'inner');
      const { createdAt } = input.failure.cause.cause;
      assert.ok(createdAt instanceof Date);
      assert.equal(createdAt.getTime(), WHEN);
      assert.equal(createdAt.channel, 'web');
      return 'A';
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.failure.cause.cause.createdAt.channel, 'web');
});

test('async: retries each receive the complete independent copy as of their own moment', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    next: 'check',
  });
  const result = await executeWorkflowAsync(workflow, callerInput(), {
    op: (input, output, nodeId, attempt) => {
      assertCauseDefaults(input);
      if (attempt === 1) {
        // Ruin every part of this attempt's copy, then fail.
        input.failure.cause.createdAt.setTime(0);
        input.failure.cause.createdAt.channel = 'hacked';
        input.failure.cause.createdAt.meta.source = 'hacked';
        input.failure.cause.createdAt.newParent = { deep: 'hacked' };
        throw new Error('first attempt fails');
      }
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  // Attempt 2 still saw the pristine time and defaults — the failed
  // attempt's copy was discarded whole.
  assert.equal(result.context.input.failure.cause.createdAt.getTime(), WHEN);
  assert.equal(result.context.input.failure.cause.createdAt.channel, 'web');
  assert.equal(result.context.input.failure.cause.createdAt.meta.source, 'form');
  assert.equal(Object.hasOwn(result.context.input.failure.cause.createdAt, 'newParent'), false);
});

test('async: compensation keeps only the defaults effective before the action succeeded', async () => {
  const workflow = {
    id: 'error-cause-comp-snapshot',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.cause.createdAt.channel', type: 'string', default: 'web' },
        { path: 'failure.cause.createdAt.meta.source', type: 'string', default: 'form' },
      ] } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: { operation: 'undo' },
        next: 'form-two',
      },
      // A second successful form adds more defaults — onto the same Date
      // inside the cause — strictly AFTER act succeeded.
      { id: 'form-two', type: 'form', next: 'boom', schema: { fields: [
        { path: 'failure.cause.createdAt.after', type: 'string', default: 'late' },
      ] } },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = callerInput();
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assertCauseDefaults(input);
      return { id: 'tx-1' };
    },
    undo: (input, output, returned, nodeId, attempt) => {
      compensationSeen.push({
        time: input.failure.cause.createdAt.getTime(),
        channel: input.failure.cause.createdAt.channel,
        source: input.failure.cause.createdAt.meta.source,
        after: Object.hasOwn(input.failure.cause.createdAt, 'after')
          ? input.failure.cause.createdAt.after : undefined,
        alias: input.note.at === input.failure.cause.createdAt,
        message: input.failure.message,
        nodeId,
        attempt,
      });
      // Frozen at act's success moment: form-one's defaults on the cause
      // Date are here, form-two's addition can never enter.
      assert.ok(input.failure instanceof Error);
      assert.equal(input.failure.message, 'boom');
      assert.ok(input.failure.cause.createdAt instanceof Date);
      assert.equal(input.failure.cause.createdAt.getTime(), WHEN);
      assert.equal(input.failure.cause.createdAt.channel, 'web');
      assert.equal(input.failure.cause.createdAt.meta.source, 'form');
      assert.equal(Object.hasOwn(input.failure.cause.createdAt, 'after'), false);
      assert.equal(input.note.at, input.failure.cause.createdAt);
      // The compensation copy is detached from everything: ruin it.
      input.failure.cause.createdAt.setTime(0);
      input.failure.cause.createdAt.channel = 'hacked';
      return 'released';
    },
    boom: () => { throw new Error('boom'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'boom');
  assert.equal(result.compensationStatus, 'completed');
  assert.equal(compensationSeen.length, 1);
  assert.deepEqual(compensationSeen[0], {
    time: WHEN, channel: 'web', source: 'form', after: undefined,
    alias: true, message: 'boom', nodeId: 'act', attempt: 1,
  });

  // The run input carries both forms' successful defaults — nothing about
  // the action failure or the compensation's rewrites rolls a form back.
  assert.equal(result.context.input.failure.cause.createdAt.getTime(), WHEN);
  assert.equal(result.context.input.failure.cause.createdAt.channel, 'web');
  assert.equal(result.context.input.failure.cause.createdAt.after, 'late');

  // The caller stays untouched.
  assert.equal(caller.failure.cause.createdAt.getTime(), WHEN);
  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.after, undefined);
});

test('async: a failed form rolls back only its own cause additions while earlier defaults survive', async () => {
  const workflow = {
    id: 'error-cause-form-rollback',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.cause.createdAt.channel', type: 'string', default: 'web' },
      ] } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: { operation: 'undo' }, next: 'form-two',
      },
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        // Leaf directly on the cause Date.
        { path: 'failure.cause.createdAt.temp', type: 'string', default: 'T' },
        // A whole new parent chain hung off that Date.
        { path: 'failure.cause.createdAt.branch.deep', type: 'string', default: 'deep' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
  const caller = callerInput();
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assert.equal(input.failure.cause.createdAt.channel, 'web');
      assert.equal(Object.hasOwn(input.failure.cause.createdAt, 'temp'), false);
      return { id: 'tx-2' };
    },
    undo: (input) => {
      compensationSeen.push(input);
      return 'released';
    },
  });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'form-two', path: 'missing.required', code: 'required' },
  ]);
  // The failed form ends the run: no successor of form-two executed.
  assert.deepEqual(result.trace.map(n => n.nodeId),
    ['start', 'form-one', 'act', 'form-two']);

  // The cause Date survives with its original time and form-one's default;
  // everything the failed form attached is gone.
  const runDate = result.context.input.failure.cause.createdAt;
  assert.ok(runDate instanceof Date);
  assert.equal(runDate.getTime(), WHEN);
  assert.equal(runDate.channel, 'web');
  assert.equal(Object.hasOwn(runDate, 'temp'), false);
  assert.equal(Object.hasOwn(runDate, 'branch'), false);
  assert.equal(Object.hasOwn(result.context.input, 'missing'), false);

  // Compensation ran with the pre-form-two success moment: form-one's
  // default on the cause Date is in it, the failed form's writes are not.
  assert.equal(compensationSeen.length, 1);
  const compDate = compensationSeen[0].failure.cause.createdAt;
  assert.ok(compDate instanceof Date);
  assert.equal(compDate.getTime(), WHEN);
  assert.equal(compDate.channel, 'web');
  assert.equal(Object.hasOwn(compDate, 'temp'), false);
  assert.equal(Object.hasOwn(compDate, 'branch'), false);

  // The caller's Error and Date are untouched.
  assert.equal(caller.failure.cause.createdAt.getTime(), WHEN);
  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.temp, undefined);
});

test('async: caller-attached properties on the cause Date and the Error are still dropped at reception', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op', next: 'check',
  });
  const caller = callerInput();
  caller.failure.cause.createdAt.callerAux = 'dropped-at-reception';
  caller.failure.callerNote = 'dropped-at-reception';

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assertCauseDefaults(input);
      // Reception-time handling is unchanged: own properties the caller
      // attached to the Date or the Error before the run never survive
      // cloneRunInput — only the run-time form defaults are reattached.
      assert.equal(input.failure.cause.createdAt.callerAux, undefined);
      assert.equal(input.failure.callerNote, undefined);
      return 'A';
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.failure.cause.createdAt.callerAux, undefined);
  assert.equal(result.context.input.failure.callerNote, undefined);
});

test('async: circular and repeated references around the cause survive in every copy', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op', next: 'check',
  });
  const caller = callerInput();
  // A circular reference through the cause and a repeated reference to the
  // same Date from two positions.
  caller.failure.cause.owner = caller.failure;
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assertCauseDefaults(input);
      // The cycle and the alias are intact inside this copy.
      assert.equal(input.failure.cause.owner, input.failure);
      assert.equal(input.note.at, input.failure.cause.createdAt);
      // ...but the copy shares no objects with the run input.
      return 'A';
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.context.input.failure.cause.owner, result.context.input.failure);
  assert.equal(result.context.input.note.at, result.context.input.failure.cause.createdAt);
});

test('sync: form defaults on a Date inside an Error cause work through executeWorkflow', () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', message: 'go', next: 'check',
  });
  const caller = callerInput();
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assertCauseDefaults(result.context.input);
  assert.equal(result.context.input.note.at, result.context.input.failure.cause.createdAt);

  assert.equal(caller.failure.cause.createdAt.getTime(), WHEN);
  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.meta, undefined);
});
