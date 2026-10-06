import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form defaults a successful form attaches to a Date
// that is reached through an Error's "cause". The receiving structured clone
// preserves a native Error's own "cause" even though the Error constructor
// installs it as a NON-enumerable own property; the input-copy walk used to
// follow only enumerable own properties, so it never crossed the cause edge
// and dropped defaults attached past it (and the multi-level parents a form
// created there) from every business-action and compensation copy. These
// tests pin the fix for every shape of the path — cause directly a Date,
// cause through a plain object, cause through another Error, and a Date
// reachable only via cause — together with identity, independence,
// compensation-snapshot timing, rollback and the unchanged reception rules.

const WHEN = Date.parse('2024-01-02T03:04:05.000Z');

const THROUGH_OBJECT_FIELDS = [
  // Leaf default on the Date reached via failure -> Error.cause -> object.
  { path: 'failure.cause.createdAt.channel', type: 'string', default: 'web' },
  // A whole multi-level parent chain created on that Date during the run.
  { path: 'failure.cause.createdAt.meta.source', type: 'string', default: 'form' },
  { path: 'failure.cause.createdAt.meta.kind', type: 'string', default: 'kind-default' },
  // Plain-object defaults keep their existing behavior.
  { path: 'plain.pair.x', type: 'string', default: 'X' },
];

// start -> form-one -> act -> check -> seen / missed. `datePath` is the path
// to the Date the defaults attach to; both the form fields and the condition
// derive from it, so every cause-chain shape checks its own real path.
function causeDefaultWorkflow(actNode, datePath = 'failure.cause.createdAt') {
  const fields = [
    { path: `${datePath}.channel`, type: 'string', default: 'web' },
    { path: `${datePath}.meta.source`, type: 'string', default: 'form' },
    { path: `${datePath}.meta.kind`, type: 'string', default: 'kind-default' },
    { path: 'plain.pair.x', type: 'string', default: 'X' },
  ];
  return {
    id: 'cause-form-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields } },
      actNode,
      {
        id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { all: [
          { field: `${datePath}.channel`, operator: 'eq', value: 'web' },
          { field: `${datePath}.meta.source`, operator: 'eq', value: 'form' },
        ] },
      },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
}

function dateAt(input, datePath) {
  return datePath.split('.').reduce((current, part) => current[part], input);
}

function assertCauseDateDefaults(input, datePath = 'failure.cause.createdAt') {
  const date = dateAt(input, datePath);
  assert.ok(date instanceof Date, `the value at ${datePath} stays a Date`);
  assert.equal(date.getTime(), WHEN, 'the Date keeps its time value');
  assert.equal(date.channel, 'web');
  assert.deepEqual(date.meta, { source: 'form', kind: 'kind-default' });
  assert.equal(input.plain.pair.x, 'X');
  return date;
}

test('async: action reads a default on a Date reached through a non-enumerable Error cause', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    compensation: { operation: 'undo' }, next: 'check',
  });
  const createdAt = new Date(WHEN);
  const caller = { failure: new TypeError('boom', { cause: { createdAt } }) };
  // Sanity-check the premise: the Error constructor installs cause
  // non-enumerably, and the form still navigates it via own-property lookups.
  assert.equal(Object.getOwnPropertyDescriptor(caller.failure, 'cause').enumerable, false);

  const seen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input, output, nodeId, attempt) => {
      seen.push({ nodeId, attempt });
      assert.ok(input.failure instanceof Error, 'the failure stays an Error');
      assert.ok(input.failure instanceof TypeError, 'the concrete Error type is preserved');
      assert.equal(input.failure.message, 'boom', 'the Error message is preserved');
      // cause stays its own, still non-enumerable, and still carries the Date.
      const causeDescriptor = Object.getOwnPropertyDescriptor(input.failure, 'cause');
      assert.equal(causeDescriptor.enumerable, false, 'cause stays non-enumerable in the copy');
      const date = assertCauseDateDefaults(input);
      // The copy is detached from the caller's graph.
      assert.notEqual(date, createdAt);
      assert.notEqual(input.failure, caller.failure);
      assert.notEqual(input.failure.cause, caller.failure.cause);
      return { ok: true };
    },
    undo: () => 'undone',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible', 'the condition read the default straight off context.input');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one', 'act', 'check', 'seen']);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { nodeId: 'act', attempt: 1 });

  // The live run input carries the defaults and the caller is untouched.
  assertCauseDateDefaults(result.context.input);
  assert.equal(result.context.input.failure.message, 'boom');
  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.meta, undefined);
  assert.equal(Object.hasOwn(caller, 'plain'), false);
});

test('async: default works when cause is directly the Date', async () => {
  const datePath = 'failure.cause';
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op', next: 'check',
  }, datePath);
  const date = new Date(WHEN);
  const caller = { failure: new Error('direct', { cause: date }) };

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assertCauseDateDefaults(input, datePath);
      assert.notEqual(input.failure.cause, date);
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assertCauseDateDefaults(result.context.input, datePath);
  assert.equal(caller.failure.cause.channel, undefined);
});

test('async: default works through another layer of Error in the cause chain', async () => {
  const datePath = 'failure.cause.cause.createdAt';
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op', next: 'check',
  }, datePath);
  const date = new Date(WHEN);
  const caller = {
    failure: new Error('outer', { cause: new TypeError('inner', { cause: { createdAt: date } }) }),
  };

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assert.equal(input.failure.message, 'outer');
      assert.ok(input.failure.cause instanceof Error);
      assert.equal(input.failure.cause.message, 'inner');
      assertCauseDateDefaults(input, datePath);
      assert.notEqual(input.failure.cause.cause.createdAt, date);
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assert.equal(caller.failure.cause.cause.createdAt.channel, undefined);
});

test('async: a Date reachable ONLY through cause keeps within-cause aliases, cycles and copy independence', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    next: 'check',
  });
  const date = new Date(WHEN);
  // The Date has no route outside the cause graph; it is reachable from two
  // keys inside it, and the plain portion cycles back to the Error. This is
  // the shape the old enumerable-only walk could never follow.
  const cause = { createdAt: date, again: date };
  const failure = new Error('cyc', { cause });
  cause.loop = failure;
  const caller = { failure };

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input, output, nodeId, attempt) => {
      const viaCause = input.failure.cause.createdAt;
      assertCauseDateDefaults(input);
      // The two in-cause positions share the one copied Date.
      assert.equal(input.failure.cause.again, viaCause);
      assert.equal(input.failure.cause.again.meta.source, 'form');
      // The circular reference through cause survives.
      assert.equal(input.failure.cause.loop, input.failure);
      // Nothing is shared with the caller or the live run input.
      assert.notEqual(viaCause, date);
      assert.notEqual(input.failure, failure);
      assert.notEqual(input.failure.cause, cause);

      // Attempt 1 ruins its own copy and fails; attempt 2 sees none of it.
      if (attempt === 1) {
        viaCause.setTime(0);
        viaCause.channel = 'hacked';
        delete viaCause.meta.kind;
        viaCause.added = { deep: true };
        input.plain.pair.x = 'Z';
        throw new Error('first attempt fails');
      }
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  const liveDate = result.context.input.failure.cause.createdAt;
  assert.equal(liveDate.getTime(), WHEN);
  assert.equal(liveDate.channel, 'web');
  assert.equal(liveDate.meta.kind, 'kind-default');
  assert.equal(Object.hasOwn(liveDate, 'added'), false);
  assert.equal(result.context.input.plain.pair.x, 'X');
  assert.equal(result.context.input.failure.cause.again, liveDate);
  assert.equal(result.context.input.failure.cause.loop, result.context.input.failure);
  // The caller is pristine.
  assert.equal(caller.failure.cause.createdAt.getTime(), WHEN);
  assert.equal(caller.failure.cause.createdAt.channel, undefined);
});

test('async: one Date reached via both cause and a plain path stays one copied Date carrying the default', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op', next: 'check',
  });
  const date = new Date(WHEN);
  const failure = new Error('e', { cause: { createdAt: date } });
  const caller = { failure, other: date };

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      const viaCause = input.failure.cause.createdAt;
      // Both routes land on the single copied Date, and the default is
      // readable from either one.
      assert.equal(input.other, viaCause);
      assert.equal(viaCause.channel, 'web');
      assert.equal(input.other.meta.kind, 'kind-default');
      assert.notEqual(viaCause, date);
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assert.equal(result.context.input.other, result.context.input.failure.cause.createdAt);
});

test('async: compensation keeps only the cause-reached defaults effective at success moment', async () => {
  const workflow = {
    id: 'cause-comp-snapshot',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: THROUGH_OBJECT_FIELDS } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: {
          operation: 'undo',
          retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        },
        next: 'form-two',
      },
      // A second successful form adds more onto the same Date after act.
      { id: 'form-two', type: 'form', next: 'boom', schema: { fields: [
        { path: 'failure.cause.createdAt.after', type: 'string', default: 'late' },
        { path: 'later.only', type: 'string', default: 'late' },
      ] } },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const date = new Date(WHEN);
  const caller = { failure: new Error('boom', { cause: { createdAt: date } }) };
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assertCauseDateDefaults(input);
      return { id: 'tx-1' };
    },
    undo: (input, output, returned, nodeId, attempt) => {
      const d = input.failure.cause.createdAt;
      compensationSeen.push({
        time: d.getTime(),
        channel: d.channel,
        source: d.meta.source,
        kind: d.meta.kind,
        plain: input.plain.pair.x,
        message: input.failure.message,
        after: Object.hasOwn(d, 'after') ? d.after : undefined,
        later: Object.hasOwn(input, 'later') ? input.later.only : undefined,
        alias: input.failure.cause.createdAt === d,
        nodeId,
        attempt,
      });
      assert.ok(d instanceof Date);
      assert.equal(d.getTime(), WHEN);
      assert.equal(d.channel, 'web');
      assert.equal(d.meta.source, 'form');
      assert.equal(input.plain.pair.x, 'X');
      assert.equal(input.failure.message, 'boom');
      // form-two ran strictly after act succeeded: its additions are frozen
      // out of the snapshot.
      assert.equal(Object.hasOwn(d, 'after'), false);
      assert.equal(Object.hasOwn(input, 'later'), false);
      // Detach-destroy on the failed attempts.
      d.setTime(0);
      d.channel = 'hacked';
      delete d.meta.source;
      d.addedByUndo = true;
      input.plain.pair.x = 'Z';
      if (attempt < 3) throw new Error(`undo fail ${attempt}`);
      return 'released';
    },
    boom: () => { throw new Error('run boom'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'boom');
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]), [
    ['act', 'undo', 1, false, null],
    ['act', 'undo', 2, false, null],
    ['act', 'undo', 3, true, 'released'],
  ]);
  assert.equal(compensationSeen.length, 3);
  for (const seen of compensationSeen) {
    assert.equal(seen.time, WHEN);
    assert.equal(seen.channel, 'web');
    assert.equal(seen.source, 'form');
    assert.equal(seen.kind, 'kind-default');
    assert.equal(seen.plain, 'X');
    assert.equal(seen.message, 'boom');
    assert.equal(seen.after, undefined);
    assert.equal(seen.later, undefined);
    assert.equal(seen.nodeId, 'act');
  }

  // The run input keeps both forms' successful defaults; no compensation
  // rewrite reached it.
  const liveDate = result.context.input.failure.cause.createdAt;
  assert.equal(liveDate.getTime(), WHEN);
  assert.equal(liveDate.channel, 'web');
  assert.equal(liveDate.after, 'late');
  assert.equal(result.context.input.later.only, 'late');
  assert.equal(Object.hasOwn(liveDate, 'addedByUndo'), false);

  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.after, undefined);
});

test('async: a failed form rolls back its cause-reached additions and keeps earlier ones', async () => {
  const workflow = {
    id: 'cause-form-rollback',
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
        { path: 'failure.cause.createdAt.temp', type: 'string', default: 'T' },
        { path: 'failure.cause.createdAt.branch.deep', type: 'string', default: 'deep' },
        { path: 'brand.new.deep', type: 'string', default: 'deep' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
  const caller = { failure: new Error('e', { cause: { createdAt: new Date(WHEN) } }) };
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      const d = input.failure.cause.createdAt;
      assert.ok(d instanceof Date);
      assert.equal(d.channel, 'web');
      assert.equal(Object.hasOwn(d, 'temp'), false);
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

  const liveDate = result.context.input.failure.cause.createdAt;
  assert.ok(liveDate instanceof Date);
  assert.equal(liveDate.getTime(), WHEN);
  assert.equal(liveDate.channel, 'web');
  assert.equal(Object.hasOwn(liveDate, 'temp'), false);
  assert.equal(Object.hasOwn(liveDate, 'branch'), false);
  assert.equal(Object.hasOwn(result.context.input, 'brand'), false);
  assert.equal(Object.hasOwn(result.context.input, 'missing'), false);

  // Compensation ran at the pre-form-two success moment: form-one's default
  // is in its copy, the failed form's writes are not.
  assert.equal(compensationSeen.length, 1);
  const compDate = compensationSeen[0].failure.cause.createdAt;
  assert.ok(compDate instanceof Date);
  assert.equal(compDate.getTime(), WHEN);
  assert.equal(compDate.channel, 'web');
  assert.equal(Object.hasOwn(compDate, 'temp'), false);
  assert.equal(Object.hasOwn(compDate, 'branch'), false);

  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.temp, undefined);
});

test('async: caller-attached non-cause Error props and Date props are still dropped at reception', async () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op', next: 'check',
  });
  const date = new Date(WHEN);
  date.callerAux = 'dropped-at-reception';
  date.channel = 'caller-wins?';
  const failure = new Error('e', { cause: { createdAt: date } });
  // An enumerable own property of the Error itself: only "cause" is cloned.
  failure.errorAux = { n: 1 };
  Object.defineProperty(failure, 'hidden', {
    value: 2, enumerable: false, configurable: true, writable: true,
  });

  await executeWorkflowAsync(workflow, { failure }, {
    op: (received) => {
      assert.ok(received.failure instanceof Error);
      assert.equal(received.failure.message, 'e');
      assert.equal(received.failure.errorAux, undefined, 'enumerable non-cause Error prop dropped');
      assert.equal(received.failure.hidden, undefined, 'non-enumerable Error prop dropped');
      const d = received.failure.cause.createdAt;
      assert.ok(d instanceof Date);
      assert.equal(d.getTime(), WHEN);
      assert.equal(d.callerAux, undefined, 'caller-attached Date prop dropped');
      assert.equal(d.channel, 'web', 'missing field still takes the form default');
      assert.equal(d.meta.source, 'form');
      return 'A';
    },
  });

  assert.equal(date.channel, 'caller-wins?', 'the caller object is never mutated');
});

test('sync: cause-reached Date defaults work through executeWorkflow', () => {
  const workflow = causeDefaultWorkflow({
    id: 'act', type: 'action', message: 'go', next: 'check',
  });
  const date = new Date(WHEN);
  const caller = { failure: new Error('e', { cause: { createdAt: date } }) };
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assertCauseDateDefaults(result.context.input);
  assert.equal(result.context.input.failure.message, 'e');
  assert.equal(caller.failure.cause.createdAt.channel, undefined);
  assert.equal(caller.failure.cause.createdAt.meta, undefined);
});

test('sync: a failed form rolls back its cause-reached additions in executeWorkflow too', () => {
  const workflow = {
    id: 'cause-form-rollback-sync',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'form-two', schema: { fields: [
        { path: 'failure.cause.createdAt.channel', type: 'string', default: 'web' },
      ] } },
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        { path: 'failure.cause.createdAt.temp', type: 'string', default: 'T' },
        { path: 'failure.cause.createdAt.branch.deep', type: 'string', default: 'deep' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
  const caller = { failure: new Error('e', { cause: { createdAt: new Date(WHEN) } }) };
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'form-two', path: 'missing.required', code: 'required' },
  ]);
  const d = result.context.input.failure.cause.createdAt;
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), WHEN);
  assert.equal(d.channel, 'web');
  assert.equal(Object.hasOwn(d, 'temp'), false);
  assert.equal(Object.hasOwn(d, 'branch'), false);
  assert.equal(Object.hasOwn(result.context.input, 'missing'), false);

  assert.equal(caller.failure.cause.createdAt.channel, undefined);
});
