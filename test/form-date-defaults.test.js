import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for defaults a successful form attaches to a host object
// (a Date) during a run. Forms apply defaults directly on the live run input,
// so context.input and later conditions always saw them; but business-action
// argument copies and compensation snapshots used to be plain structured
// clones, and structuredClone reproduces a Date from its time value alone,
// silently dropping every attached own property — so the action and its
// compensation lost exactly the run-time form defaults. These tests pin the
// fix: the same defaults are visible in every copy, the Date keeps its type
// and time, aliases stay aliases within one copy, and every copy is
// independent of the run input, the caller's input and every other copy.

const WHEN = Date.parse('2024-01-02T03:04:05.000Z');

// start -> form-one (adds defaults, including onto the input Date)
//       -> act (business + compensation in async runs; a message in sync)
//       -> check (condition reading a default attached to the Date)
//       -> seen / missed (two ends)
function dateDefaultWorkflow(actNode) {
  return {
    id: 'date-form-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        // A default landing directly on the caller's Date.
        { path: 'request.createdAt.channel', type: 'string', default: 'web' },
        // A multi-level path where every parent above the leaf is created on
        // the Date during the run.
        { path: 'request.createdAt.meta.source', type: 'string', default: 'form' },
        { path: 'request.createdAt.meta.kind', type: 'string', default: 'kind-default' },
        // Plain-object defaults keep their existing behavior.
        { path: 'plain.pair.x', type: 'string', default: 'X' },
      ] } },
      actNode,
      {
        id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { all: [
          { field: 'request.createdAt.channel', operator: 'eq', value: 'web' },
          { field: 'request.createdAt.meta.source', operator: 'eq', value: 'form' },
        ] },
      },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
}

// Two input fields point at the same Date; both must keep aliasing the one
// copied Date inside each independent copy.
function callerInput() {
  const createdAt = new Date(WHEN);
  return { request: { createdAt }, note: { at: createdAt } };
}

function assertDateWithDefaults(input) {
  assert.ok(input.request.createdAt instanceof Date, 'the value stays a Date');
  assert.equal(input.request.createdAt.getTime(), WHEN, 'the Date keeps its time value');
  assert.equal(input.request.createdAt.channel, 'web');
  // The whole newly-created multi-level path is readable.
  assert.deepEqual(input.request.createdAt.meta, { source: 'form', kind: 'kind-default' });
  assert.equal(input.plain.pair.x, 'X');
}

test('async: a business action reads defaults a form attached to a Date, with type and time preserved', async () => {
  const workflow = dateDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    compensation: { operation: 'undo' }, next: 'check',
  });
  const caller = callerInput();
  const seen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input, output, nodeId, attempt) => {
      seen.push({ alias: input.request.createdAt === input.note.at, output: structuredClone(output), nodeId, attempt });
      assertDateWithDefaults(input);
      // Two input fields aliasing one Date still alias the one copied Date
      // inside this invocation's copy.
      assert.equal(input.request.createdAt, input.note.at);
      assert.equal(input.note.at.meta.source, 'form');
      // The copy is independent of the caller's Date.
      assert.notEqual(input.request.createdAt, caller.request.createdAt);
      // Mutating this attempt's copy: the time, the attached defaults, the
      // created parent and a brand-new own property all stay within the copy.
      input.request.createdAt.setTime(0);
      input.request.createdAt.channel = 'hacked';
      delete input.request.createdAt.meta.kind;
      input.request.createdAt.addedByAction = true;
      input.plain.pair.x = 'Z';
      return { ok: true };
    },
    undo: () => 'undone',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible', 'the condition read the defaults straight off context.input');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one', 'act', 'check', 'seen']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].alias, true);
  assert.equal(seen[0].nodeId, 'act');
  assert.equal(seen[0].attempt, 1);

  // The run result keeps the same defaults on the live Date.
  assertDateWithDefaults(result.context.input);
  assert.equal(result.context.input.note.at, result.context.input.request.createdAt);
  // Nothing the action did to its own copy reached the run input.
  assert.equal(result.context.input.request.createdAt.getTime(), WHEN);
  assert.equal(Object.hasOwn(result.context.input.request.createdAt, 'addedByAction'), false);

  // The caller's object and Date were never mutated, nor given the defaults.
  assert.equal(caller.request.createdAt.getTime(), WHEN);
  assert.equal(caller.request.createdAt.channel, undefined);
  assert.equal(caller.request.createdAt.meta, undefined);
  assert.equal(Object.hasOwn(caller, 'plain'), false);
  assert.equal(caller.note.at, caller.request.createdAt);
});

test('async: retries each receive the complete independent copy as of their own moment', async () => {
  const workflow = dateDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    next: 'check',
  });
  const result = await executeWorkflowAsync(workflow, callerInput(), {
    op: (input, output, nodeId, attempt) => {
      assertDateWithDefaults(input);
      assert.equal(input.request.createdAt, input.note.at);
      if (attempt === 1) {
        // Ruin every part of this attempt's copy, then fail.
        input.request.createdAt.setTime(0);
        input.request.createdAt.channel = 'hacked';
        input.request.createdAt.meta.source = 'hacked';
        input.request.createdAt.newParent = { deep: 'hacked' };
        input.plain.pair.x = 'Z';
        throw new Error('first attempt fails');
      }
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  // Attempt 2 still saw the pristine time and defaults — the failed
  // attempt's copy was discarded whole.
  assert.equal(result.context.input.request.createdAt.getTime(), WHEN);
  assert.equal(result.context.input.request.createdAt.channel, 'web');
  assert.equal(result.context.input.request.createdAt.meta.source, 'form');
  assert.equal(Object.hasOwn(result.context.input.request.createdAt, 'newParent'), false);
  assert.equal(result.context.input.plain.pair.x, 'X');
});

test('async: compensation keeps only the defaults effective before the action succeeded', async () => {
  const workflow = {
    id: 'date-comp-snapshot',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'request.createdAt.channel', type: 'string', default: 'web' },
        { path: 'request.createdAt.meta.source', type: 'string', default: 'form' },
        { path: 'request.createdAt.meta.kind', type: 'string', default: 'kind-default' },
        { path: 'plain.pair.x', type: 'string', default: 'X' },
      ] } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: {
          operation: 'undo',
          retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        },
        next: 'form-two',
      },
      // A second successful form adds more defaults — onto the same Date and
      // on a fresh plain parent — strictly AFTER act succeeded.
      { id: 'form-two', type: 'form', next: 'boom', schema: { fields: [
        { path: 'request.createdAt.after', type: 'string', default: 'late' },
        { path: 'later.only', type: 'string', default: 'late' },
      ] } },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = callerInput();
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assertDateWithDefaults(input);
      return { id: 'tx-1' };
    },
    undo: (input, output, returned, nodeId, attempt) => {
      // Record the pristine fields before this attempt mutates its own copy.
      compensationSeen.push({
        time: input.request.createdAt.getTime(),
        channel: input.request.createdAt.channel,
        source: input.request.createdAt.meta.source,
        plain: input.plain.pair.x,
        after: Object.hasOwn(input.request.createdAt, 'after') ? input.request.createdAt.after : undefined,
        later: Object.hasOwn(input, 'later') ? input.later.only : undefined,
        addedByUndo: Object.hasOwn(input.request.createdAt, 'addedByUndo'),
        alias: input.request.createdAt === input.note.at,
        output: structuredClone(output),
        returned: structuredClone(returned),
        nodeId,
        attempt,
      });
      // Frozen at act's success moment: form-one's defaults (including on
      // the Date) are here, form-two's additions can never enter.
      assert.ok(input.request.createdAt instanceof Date);
      assert.equal(input.request.createdAt.getTime(), WHEN);
      assert.equal(input.request.createdAt.channel, 'web');
      assert.equal(input.request.createdAt.meta.source, 'form');
      assert.equal(input.plain.pair.x, 'X');
      assert.equal(Object.hasOwn(input.request.createdAt, 'after'), false);
      assert.equal(Object.hasOwn(input, 'later'), false);
      // Aliases survive inside the compensation copy too.
      assert.equal(input.request.createdAt, input.note.at);
      assert.equal(input.note.at.channel, 'web');
      // The compensation copy is detached from everything: ruin it on the
      // first two attempts, which then fail and retry.
      input.request.createdAt.setTime(0);
      input.request.createdAt.channel = 'hacked';
      delete input.request.createdAt.meta.source;
      input.request.createdAt.addedByUndo = true;
      input.plain.pair.x = 'Z';
      if (attempt < 3) throw new Error(`undo fail ${attempt}`);
      return 'released';
    },
    boom: () => { throw new Error('boom'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'boom');
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['act', 'undo', 1, false, null],
    ['act', 'undo', 2, false, null],
    ['act', 'undo', 3, true, 'released'],
  ]);

  // Every attempt received the same pristine success-moment input — the
  // earlier attempts' rewrites were discarded.
  assert.equal(compensationSeen.length, 3);
  for (const seen of compensationSeen) {
    assert.equal(seen.time, WHEN);
    assert.equal(seen.channel, 'web');
    assert.equal(seen.source, 'form');
    assert.equal(seen.plain, 'X');
    assert.equal(seen.after, undefined);
    assert.equal(seen.addedByUndo, false);
    assert.equal(seen.later, undefined);
    assert.equal(seen.alias, true);
    // The output snapshot precedes act's own result landing, and no earlier
    // business action existed here; the stored result comes separately.
    assert.deepEqual(seen.output, {});
    assert.deepEqual(seen.returned, { id: 'tx-1' });
    assert.equal(seen.nodeId, 'act');
  }

  // The run input itself carries both forms' successful defaults — nothing
  // about the action failure rolls a successful form back.
  assert.equal(result.context.input.request.createdAt.getTime(), WHEN);
  assert.equal(result.context.input.request.createdAt.channel, 'web');
  assert.equal(result.context.input.request.createdAt.after, 'late');
  assert.equal(result.context.input.later.only, 'late');
  // Compensation rewrites never reached it.
  assert.equal(Object.hasOwn(result.context.input.request.createdAt, 'addedByUndo'), false);

  // The caller stays untouched.
  assert.equal(caller.request.createdAt.getTime(), WHEN);
  assert.equal(caller.request.createdAt.channel, undefined);
  assert.equal(caller.request.createdAt.after, undefined);
  assert.equal(Object.hasOwn(caller, 'later'), false);
});

test('async: a failed form rolls back only its own Date additions while earlier defaults survive', async () => {
  const workflow = {
    id: 'date-form-rollback',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'request.createdAt.channel', type: 'string', default: 'web' },
      ] } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: { operation: 'undo' }, next: 'form-two',
      },
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        // Leaf directly on the Date.
        { path: 'request.createdAt.temp', type: 'string', default: 'T' },
        // A whole new parent chain hung off the Date.
        { path: 'request.createdAt.branch.deep', type: 'string', default: 'deep' },
        // A wholly new plain chain at the root.
        { path: 'brand.new.deep', type: 'string', default: 'deep' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
  const caller = callerInput();
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assert.ok(input.request.createdAt instanceof Date);
      assert.equal(input.request.createdAt.channel, 'web');
      assert.equal(Object.hasOwn(input.request.createdAt, 'temp'), false);
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
  assert.deepEqual(result.trace.map(n => n.nodeId),
    ['start', 'form-one', 'act', 'form-two']);

  // The Date survives as a Date with its original time and form-one's
  // default; everything the failed form attached is gone.
  assert.ok(result.context.input.request.createdAt instanceof Date);
  assert.equal(result.context.input.request.createdAt.getTime(), WHEN);
  assert.equal(result.context.input.request.createdAt.channel, 'web');
  assert.equal(Object.hasOwn(result.context.input.request.createdAt, 'temp'), false);
  assert.equal(Object.hasOwn(result.context.input.request.createdAt, 'branch'), false);
  assert.equal(Object.hasOwn(result.context.input, 'brand'), false);
  assert.equal(Object.hasOwn(result.context.input, 'missing'), false);

  // Compensation ran with the pre-form-two success moment: form-one's
  // Date default is in it, the failed form's writes are not.
  assert.equal(compensationSeen.length, 1);
  const compInput = compensationSeen[0];
  assert.ok(compInput.request.createdAt instanceof Date);
  assert.equal(compInput.request.createdAt.getTime(), WHEN);
  assert.equal(compInput.request.createdAt.channel, 'web');
  assert.equal(Object.hasOwn(compInput.request.createdAt, 'temp'), false);
  assert.equal(Object.hasOwn(compInput.request.createdAt, 'branch'), false);
  assert.equal(Object.hasOwn(compInput, 'brand'), false);

  // The caller's Date is untouched.
  assert.equal(caller.request.createdAt.getTime(), WHEN);
  assert.equal(caller.request.createdAt.channel, undefined);
  assert.equal(caller.request.createdAt.temp, undefined);
});

test('async: a property the caller attached to the input Date is still dropped at reception', async () => {
  const workflow = dateDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op', next: 'check',
  });
  const input = callerInput();
  input.request.createdAt.callerAux = 'dropped-at-reception';
  input.request.createdAt.channel = 'caller-wins?';

  await executeWorkflowAsync(workflow, input, {
    op: (received) => {
      assert.ok(received.request.createdAt instanceof Date);
      assert.equal(received.request.createdAt.getTime(), WHEN);
      // Reception-time handling is unchanged: caller-attached own properties
      // never survive cloneRunInput — including one under the same key a form
      // later defaults, which then applies as a normal missing-field default.
      assert.equal(received.request.createdAt.callerAux, undefined);
      assert.equal(received.request.createdAt.channel, 'web');
      assert.equal(received.request.createdAt.meta.source, 'form');
      return 'A';
    },
  });
});

test('sync: form defaults on a Date work through executeWorkflow and stay independent of the caller', () => {
  const workflow = dateDefaultWorkflow({
    id: 'act', type: 'action', message: 'go', next: 'check',
  });
  const caller = callerInput();
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assertDateWithDefaults(result.context.input);
  assert.equal(result.context.input.request.createdAt, result.context.input.note.at);

  assert.equal(caller.request.createdAt.getTime(), WHEN);
  assert.equal(caller.request.createdAt.channel, undefined);
  assert.equal(caller.request.createdAt.meta, undefined);
  assert.equal(Object.hasOwn(caller, 'plain'), false);
});

test('sync: a failed form rolls back its own Date additions in executeWorkflow too', () => {
  const workflow = {
    id: 'date-form-rollback-sync',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'form-two', schema: { fields: [
        { path: 'request.createdAt.channel', type: 'string', default: 'web' },
      ] } },
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        { path: 'request.createdAt.temp', type: 'string', default: 'T' },
        { path: 'request.createdAt.branch.deep', type: 'string', default: 'deep' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
  const caller = callerInput();
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'form-two', path: 'missing.required', code: 'required' },
  ]);
  assert.ok(result.context.input.request.createdAt instanceof Date);
  assert.equal(result.context.input.request.createdAt.getTime(), WHEN);
  assert.equal(result.context.input.request.createdAt.channel, 'web');
  assert.equal(Object.hasOwn(result.context.input.request.createdAt, 'temp'), false);
  assert.equal(Object.hasOwn(result.context.input.request.createdAt, 'branch'), false);
  assert.equal(Object.hasOwn(result.context.input, 'missing'), false);

  assert.equal(caller.request.createdAt.getTime(), WHEN);
  assert.equal(caller.request.createdAt.channel, undefined);
});
