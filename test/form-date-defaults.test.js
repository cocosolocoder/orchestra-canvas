import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for defaults a successful form attaches to a host
// value — most importantly a Date — that the JavaScript entry supplied.
//
// Input reception structured-clones the caller's input once, so own
// properties the caller attached to a Date are dropped there (unchanged
// reception behavior). During the run a form can then add a missing field
// to that very Date (request.createdAt.channel), possibly creating fresh
// plain parent objects along a multi-level path
// (request.createdAt.meta.source). context.input and the following
// conditions always saw those writes live; the bug was that every input
// *copy* delivered afterwards — a business attempt's argument, the
// compensation snapshot at an action's success moment, and a compensation
// attempt's argument — went through another plain structuredClone, which
// silently drops a Date's attached properties again. The copies therefore
// disagreed with context.input: the action could not read a default the
// form had applied, and compensation lost the pre-success defaults.

const WHEN = Date.parse('2024-01-02T03:04:05.000Z');
const ZERO_DELAY_RETRY = { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };

// start -> form (adds channel + meta.source on the Date)
//       -> act  (business action with compensation)
//       -> form2 (adds an "after" field on the Date)
//       -> boom (fails, triggering compensation) -> done
function workflow(retry) {
  return {
    id: 'form-date-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form' },
      { id: 'form', type: 'form', next: 'act', schema: { fields: [
        { path: 'request.createdAt.channel', type: 'string', default: 'web' },
        { path: 'request.createdAt.meta.source', type: 'string', default: 'form' },
        { path: 'request.kind', type: 'string', default: 'order' },
      ] } },
      {
        id: 'act', type: 'action', operation: 'do',
        compensation: { operation: 'undo' },
        ...(retry ? { retry } : {}),
        next: 'form2',
      },
      { id: 'form2', type: 'form', next: 'boom', schema: { fields: [
        { path: 'request.createdAt.after', type: 'string', default: 'late' },
      ] } },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

function callerInput() {
  return { request: { createdAt: new Date(WHEN) } };
}

test('a business action reads the defaults a form attached to a Date, and the Date keeps its time', async () => {
  const caller = callerInput();
  const seen = [];
  const result = await executeWorkflowAsync(workflow(), caller, {
    do: (input, output, nodeId, attempt) => {
      seen.push({
        isDate: input.request.createdAt instanceof Date,
        time: input.request.createdAt.getTime(),
        channel: input.request.createdAt.channel,
        metaSource: input.request.createdAt.meta.source,
        kind: input.request.kind,
        nodeId, attempt,
      });
      return { tx: 1 };
    },
    undo: () => 'undone',
    boom: () => { throw new Error('downstream failure'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.deepEqual(seen, [{
    isDate: true, time: WHEN, channel: 'web', metaSource: 'form', kind: 'order',
    nodeId: 'act', attempt: 1,
  }]);

  // The run result keeps the defaults both forms applied, on the Date.
  const saved = result.context.input.request.createdAt;
  assert.ok(saved instanceof Date);
  assert.equal(saved.getTime(), WHEN);
  assert.equal(saved.channel, 'web');
  assert.equal(saved.meta.source, 'form');
  assert.equal(saved.after, 'late');
  assert.equal(result.context.input.request.kind, 'order');

  // The caller's Date is untouched: original time, no attached properties.
  assert.ok(caller.request.createdAt instanceof Date);
  assert.equal(caller.request.createdAt.getTime(), WHEN);
  assert.equal(caller.request.createdAt.channel, undefined);
  assert.equal(caller.request.createdAt.meta, undefined);
  assert.equal(caller.request.createdAt.after, undefined);
  assert.equal(caller.request.kind, undefined);
});

test('a condition after the form can branch on a field defaulted onto the Date', async () => {
  const wf = {
    id: 'date-condition', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form' },
      { id: 'form', type: 'form', next: 'check', schema: { fields: [
        { path: 'when.channel', type: 'string', default: 'web' },
      ] } },
      { id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { field: 'when.channel', operator: 'eq', value: 'web' } },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
  const result = await executeWorkflowAsync(wf, { when: new Date(WHEN) }, {});
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
});

test('compensation keeps the defaults applied before the action succeeded and never sees a later form’s field', async () => {
  const caller = callerInput();
  const compSeen = [];
  const result = await executeWorkflowAsync(workflow(), caller, {
    do: () => ({ tx: 1 }),
    undo: (input, output, returned, nodeId, attempt) => {
      compSeen.push({
        isDate: input.request.createdAt instanceof Date,
        time: input.request.createdAt.getTime(),
        channel: input.request.createdAt.channel,
        metaSource: input.request.createdAt.meta.source,
        after: input.request.createdAt.after,
        kind: input.request.kind,
        result: structuredClone(returned), nodeId, attempt,
      });
      return 'undone';
    },
    boom: () => { throw new Error('downstream failure'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(compSeen, [{
    isDate: true, time: WHEN, channel: 'web', metaSource: 'form',
    after: undefined, kind: 'order', result: { tx: 1 },
    nodeId: 'act', attempt: 1,
  }]);
  // The later successful form's default stays on the run input even though
  // it never entered the compensation snapshot.
  assert.equal(result.context.input.request.createdAt.after, 'late');
});

test('mutating the received Date time, a default field or a created parent never reaches the run input, the caller or the next retry', async () => {
  const caller = callerInput();
  const seen = [];
  const result = await executeWorkflowAsync(workflow(ZERO_DELAY_RETRY), caller, {
    do: (input, output, nodeId, attempt) => {
      seen.push({
        time: input.request.createdAt.getTime(),
        channel: input.request.createdAt.channel,
        metaSource: input.request.createdAt.meta.source,
      });
      input.request.createdAt.setTime(0);
      input.request.createdAt.channel = 'hacked';
      input.request.createdAt.meta.source = 'hacked';
      input.request.createdAt.meta.added = true;
      input.request.kind = 'hacked';
      if (attempt === 1) throw new Error('first attempt fails');
      return { tx: 2 };
    },
    undo: input => {
      // Compensation also gets a pristine success-moment copy.
      assert.equal(input.request.createdAt.getTime(), WHEN);
      assert.equal(input.request.createdAt.channel, 'web');
      assert.equal(input.request.createdAt.meta.source, 'form');
      assert.equal(input.request.createdAt.meta.added, undefined);
      return 'undone';
    },
    boom: () => { throw new Error('downstream failure'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.deepEqual(seen, [
    { time: WHEN, channel: 'web', metaSource: 'form' },
    { time: WHEN, channel: 'web', metaSource: 'form' },
  ]);
  // The run input is unaffected by either attempt.
  assert.equal(result.context.input.request.createdAt.getTime(), WHEN);
  assert.equal(result.context.input.request.createdAt.channel, 'web');
  assert.equal(result.context.input.request.createdAt.meta.source, 'form');
  assert.equal(result.context.input.request.createdAt.meta.added, undefined);
  assert.equal(result.context.input.request.kind, 'order');
  // The caller is unaffected.
  assert.equal(caller.request.createdAt.getTime(), WHEN);
  assert.equal(caller.request.createdAt.channel, undefined);
  assert.equal(caller.request.createdAt.meta, undefined);
  assert.equal(caller.request.kind, undefined);
});

test('two input fields pointing at the same Date still share one copied Date within each delivered copy', async () => {
  const date = new Date(WHEN);
  const caller = { a: date, b: date };
  const identities = [];
  const result = await executeWorkflowAsync({
    id: 'aliased-date', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form' },
      { id: 'form', type: 'form', next: 'act', schema: { fields: [
        { path: 'a.channel', type: 'string', default: 'web' },
      ] } },
      { id: 'act', type: 'action', operation: 'do',
        compensation: { operation: 'undo' }, next: 'boom' },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  }, caller, {
    do: input => {
      identities.push({
        sameRef: input.a === input.b,
        channelVisibleViaAlias: input.b.channel,
      });
      return 'done';
    },
    undo: input => {
      identities.push({ compSameRef: input.a === input.b, compChannel: input.b.channel });
      return 'u';
    },
    boom: () => { throw new Error('downstream failure'); },
  });

  assert.equal(result.status, 'action_failed');
  // The default attached through `a` is visible through the aliased `b` in
  // the same copy, and compensation agrees.
  assert.deepEqual(identities, [
    { sameRef: true, channelVisibleViaAlias: 'web' },
    { compSameRef: true, compChannel: 'web' },
  ]);
  // context.input keeps the alias too.
  assert.equal(result.context.input.a, result.context.input.b);
  assert.equal(result.context.input.b.channel, 'web');
  // The copy is disjoint from the caller's Date.
  assert.notEqual(result.context.input.a, caller.a);
});

test('a failed form rolls back only its own Date-attached defaults and keeps an earlier form’s', async () => {
  const wf = {
    id: 'date-rollback', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'form-two', schema: { fields: [
        { path: 'when.keep', type: 'string', default: 'K1' },
      ] } },
      { id: 'form-two', type: 'form', next: 'after', schema: { fields: [
        { path: 'when.temp', type: 'string', default: 'T' },
        { path: 'when.brand.new.deep', type: 'string', default: 'deep' },
        { path: 'missing.required', type: 'string', required: true },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
  const caller = { when: new Date(WHEN) };
  const result = executeWorkflow(wf, caller);

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'form-two', path: 'missing.required', code: 'required' },
  ]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'form-one', 'form-two']);

  const when = result.context.input.when;
  assert.ok(when instanceof Date);
  assert.equal(when.getTime(), WHEN);
  // Earlier successful form's default survives; the failed form's writes —
  // leaf and the whole created parent chain — are gone.
  assert.equal(when.keep, 'K1');
  assert.equal(when.temp, undefined);
  assert.equal(when.brand, undefined);
  assert.equal(Object.hasOwn(result.context.input, 'missing'), false);

  // Caller untouched.
  assert.equal(caller.when.getTime(), WHEN);
  assert.equal(caller.when.keep, undefined);
  assert.equal(caller.when.temp, undefined);
});

test('defaults on ordinary objects and the rest of the clone graph keep their existing behavior', async () => {
  const detail = { id: 'detail' };
  const caller = { plain: { nested: {} }, detail, again: detail };
  const result = await executeWorkflowAsync({
    id: 'plain-defaults', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form' },
      { id: 'form', type: 'form', next: 'act', schema: { fields: [
        { path: 'plain.nested.channel', type: 'string', default: 'web' },
        { path: 'flat', type: 'integer', default: 3 },
      ] } },
      { id: 'act', type: 'action', operation: 'do',
        compensation: { operation: 'undo' }, next: 'boom' },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  }, caller, {
    do: input => {
      assert.equal(input.plain.nested.channel, 'web');
      assert.equal(input.flat, 3);
      // Existing reference topology survives in the delivered copy.
      assert.equal(input.detail, input.again);
      return 'ok';
    },
    undo: input => {
      assert.equal(input.plain.nested.channel, 'web');
      assert.equal(input.detail, input.again);
      return 'u';
    },
    boom: () => { throw new Error('downstream'); },
  });
  assert.equal(result.status, 'action_failed');
  assert.equal(result.context.input.plain.nested.channel, 'web');
  assert.equal(result.context.input.detail, result.context.input.again);
});
