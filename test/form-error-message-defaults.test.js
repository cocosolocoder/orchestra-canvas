import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form defaults that create an Error's own "message"
// during a run. The caller hands a native Error whose received clone carries
// no own message; a form default for failure.message.label then builds the
// message object on the live run input, and later conditions read it. But
// the independent copies handed to business actions and compensations are
// rebuilt from a structured clone, and structuredClone coerces an Error's
// message with String() — the message object came out as "[object Object]"
// (a number/boolean default as "42"/"true") and the validated fields were
// silently lost. These tests pin the fix: a form-created message keeps its
// type, hierarchy and values in every copy, the Error stays an Error,
// retries and compensation snapshots carry the same content, every copy is
// independent, and an already-string message keeps its existing handling
// (a default under it is a type error, never an overwrite).

// An Error that reaches the run without an own message property.
function callerWithoutMessage() {
  const failure = new Error('boom');
  delete failure.message;
  return { failure, note: 'keep' };
}

// start -> form-one (creates failure.message with a label and a nested
// parent) -> act (business + compensation in async runs; a message in sync)
// -> check (condition reading the label) -> seen / missed
function messageDefaultWorkflow(actNode) {
  return {
    id: 'error-message-form-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.message.label', type: 'string', default: 'web' },
        { path: 'failure.message.meta.source', type: 'string', default: 'form' },
      ] } },
      actNode,
      {
        id: 'check', type: 'condition', then: 'seen', else: 'missed',
        condition: { all: [
          { field: 'failure.message.label', operator: 'eq', value: 'web' },
          { field: 'failure.message.meta.source', operator: 'eq', value: 'form' },
        ] },
      },
      { id: 'seen', type: 'end', result: 'default-visible' },
      { id: 'missed', type: 'end', result: 'default-missing' },
    ],
  };
}

function assertMessageDefaults(input) {
  assert.ok(input.failure instanceof Error, 'the value stays an Error');
  assert.equal(typeof input.failure.message, 'object', 'the message keeps its object type');
  assert.equal(input.failure.message.label, 'web');
  assert.deepEqual(input.failure.message.meta, { source: 'form' });
  assert.equal(input.note, 'keep', 'other input content is preserved');
}

test('async: a business action receives the form-created message object intact', async () => {
  const workflow = messageDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    compensation: { operation: 'undo' }, next: 'check',
  });
  const caller = callerWithoutMessage();
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input, output, nodeId, attempt) => {
      assertMessageDefaults(input);
      assert.equal(nodeId, 'act');
      assert.equal(attempt, 1);
      // The copy shares nothing with the caller's Error.
      assert.notEqual(input.failure, caller.failure);
      // Mutating this copy — the message, its fields and a brand-new parent —
      // stays within the copy.
      input.failure.message.label = 'hacked';
      delete input.failure.message.meta;
      input.failure.message.addedByAction = { deep: true };
      input.failure.message = 'rewritten';
      return { ok: true };
    },
    undo: () => 'undone',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible', 'the condition read the label off context.input');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one', 'act', 'check', 'seen']);

  // The run input keeps the defaults; nothing the action did reached it.
  assertMessageDefaults(result.context.input);
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'addedByAction'), false);

  // The caller's Error was never mutated nor given a message.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
});

test('async: number and boolean defaults for a missing failure.message keep their types', async () => {
  const seen = [];
  for (const [type, fallback] of [['number', 42], ['boolean', false], ['string', 'plain']]) {
    const workflow = {
      id: `error-message-${type}`,
      entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'form-one' },
        { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
          { path: 'failure.message', type, default: fallback },
        ] } },
        { id: 'act', type: 'action', operation: 'op', next: 'done' },
        { id: 'done', type: 'end', result: 'ok' },
      ],
    };
    const result = await executeWorkflowAsync(workflow, callerWithoutMessage(), {
      op: (input) => {
        seen.push([input.failure.message, typeof input.failure.message]);
        return 'A';
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.context.input.failure.message, fallback);
    assert.equal(typeof result.context.input.failure.message, type);
  }
  // The action copies carry the exact typed values — never text like "42".
  assert.deepEqual(seen, [[42, 'number'], [false, 'boolean'], ['plain', 'string']]);
});

test('async: retries each receive the complete message content as of their own moment', async () => {
  const workflow = messageDefaultWorkflow({
    id: 'act', type: 'action', operation: 'op',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    next: 'check',
  });
  const result = await executeWorkflowAsync(workflow, callerWithoutMessage(), {
    op: (input, output, nodeId, attempt) => {
      assertMessageDefaults(input);
      if (attempt === 1) {
        // Ruin every part of this attempt's copy, then fail.
        input.failure.message.label = 'hacked';
        input.failure.message.meta.source = 'hacked';
        input.failure.message.newParent = { deep: 'hacked' };
        throw new Error('first attempt fails');
      }
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  // Attempt 2 still saw the pristine form-written content — the failed
  // attempt's copy was discarded whole.
  assertMessageDefaults(result.context.input);
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'newParent'), false);
});

test('async: compensation keeps the success-moment message content, independently', async () => {
  const workflow = {
    id: 'error-message-comp-snapshot',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.message.label', type: 'string', default: 'web' },
      ] } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: { operation: 'undo' }, next: 'form-two',
      },
      // A second successful form adds more content under the same message
      // strictly AFTER act succeeded.
      { id: 'form-two', type: 'form', next: 'boom', schema: { fields: [
        { path: 'failure.message.after', type: 'string', default: 'late' },
      ] } },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = callerWithoutMessage();
  const compensationSeen = [];
  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assert.equal(input.failure.message.label, 'web');
      return { id: 'tx-1' };
    },
    undo: (input, output, returned, nodeId, attempt) => {
      compensationSeen.push(input);
      // Frozen at act's success moment: form-one's message object is here,
      // form-two's later addition can never enter.
      assert.ok(input.failure instanceof Error);
      assert.equal(typeof input.failure.message, 'object');
      assert.equal(input.failure.message.label, 'web');
      assert.equal(Object.hasOwn(input.failure.message, 'after'), false);
      assert.equal(nodeId, 'act');
      assert.equal(attempt, 1);
      // The compensation copy is detached from everything: ruin it.
      input.failure.message.label = 'hacked';
      input.failure.message = 'rewritten';
      return 'released';
    },
    boom: () => { throw new Error('boom'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'boom');
  assert.equal(result.compensationStatus, 'completed');
  assert.equal(compensationSeen.length, 1);

  // The run input carries both forms' successful defaults — the
  // compensation's rewrites never reached it.
  assert.equal(result.context.input.failure.message.label, 'web');
  assert.equal(result.context.input.failure.message.after, 'late');

  // The caller's Error never gained a message.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
});

test('async: an existing string message is never overwritten — the default is a type error', async () => {
  const workflow = {
    id: 'error-message-string-kept',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'after', schema: { fields: [
        { path: 'failure.message.label', type: 'string', default: 'web' },
        { path: 'other.default', type: 'string', default: 'added' },
      ] } },
      { id: 'after', type: 'end', result: 'done' },
    ],
  };
  const caller = { failure: new Error('keep me') };
  const result = await executeWorkflowAsync(workflow, caller, {});

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'form-one', path: 'failure.message.label', code: 'type' },
  ]);
  // The original string message survives and the failed form's other
  // default is rolled back.
  assert.equal(result.context.input.failure.message, 'keep me');
  assert.equal(Object.hasOwn(result.context.input, 'other'), false);
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one']);
  assert.equal(caller.failure.message, 'keep me');
});

test('sync: form defaults creating an Error message work through executeWorkflow', () => {
  const workflow = messageDefaultWorkflow({
    id: 'act', type: 'action', message: 'go', next: 'check',
  });
  const caller = callerWithoutMessage();
  const result = executeWorkflow(workflow, caller);

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'default-visible');
  assertMessageDefaults(result.context.input);
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
});
