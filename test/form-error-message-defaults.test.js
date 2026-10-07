import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for form defaults that turn a native Error's "message"
// slot into a structured value. A caller may hand in a raw Error whose
// "message" is not an own property at reception (new Error() carries the
// empty-string message on the prototype), and a successful form can then
// either create a message object (a default at failure.message.label, with
// further defaults nested under it) or write a number/boolean/string default
// directly at failure.message. The live run input kept that value correctly,
// but the independent copies handed to business attempts and to compensation
// are rebuilt from a structured clone — and structuredClone serializes an
// Error's message slot as a STRING: an object became "[object Object]", a
// number "5" and a boolean "false", so the already-validated fields vanished
// from the action's input. These tests pin the repair: the form-written
// message reaches every independent copy with its original type, structure
// and value, multi-level parents come whole, the value stays an Error, and
// every copy remains independent of the run input, the caller and the other
// copies.

// start -> form-one (writes the structured failure.message) -> gate
//       -> act (business op; a compensation in the runs that need one)
//       -> done
function workflowWith(actNode, formFields, extraNodes = []) {
  return {
    id: 'error-message-form-defaults',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'gate', schema: { fields: formFields } },
      {
        id: 'gate', type: 'condition', then: 'act', else: 'missed',
        condition: { field: 'failure.message.label', operator: 'eq', value: 'web' },
      },
      actNode,
      ...extraNodes,
      { id: 'done', type: 'end', result: 'finished' },
      { id: 'missed', type: 'end', result: 'condition-did-not-see-label' },
    ],
  };
}

const OBJECT_MESSAGE_FIELDS = [
  { path: 'failure.message.label', type: 'string', default: 'web' },
  // A whole multi-level parent chain created underneath the new message.
  { path: 'failure.message.meta.source', type: 'string', default: 'form' },
  { path: 'failure.message.a.b.c', type: 'string', default: 'deep' },
];

function assertStructuredMessage(message) {
  assert.equal(typeof message, 'object', 'the message stays an object, not a string');
  assert.notEqual(message, null);
  assert.equal(message.label, 'web', 'label reads along the same path');
  assert.deepEqual(message.meta, { source: 'form' });
  assert.deepEqual(message.a, { b: { c: 'deep' } }, 'created parents come whole');
}

function callerInput() {
  // A raw Error with NO own message property (the empty string lives on the
  // prototype) and a cause the copy must keep.
  const failure = new Error(undefined, { cause: { code: 'upstream' } });
  // A second input field aliases the very same Error.
  return { failure, holder: { error: failure }, note: 'kept' };
}

test('async: a business action reads the object-valued failure.message a form created', async () => {
  const workflow = workflowWith(
    { id: 'act', type: 'action', operation: 'op', compensation: { operation: 'undo' }, next: 'done' },
    OBJECT_MESSAGE_FIELDS);
  const caller = callerInput();

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input, output, nodeId, attempt) => {
      assert.ok(input.failure instanceof Error, 'failure is still an Error');
      assert.equal(input.failure.name, 'Error');
      assert.deepEqual(input.failure.cause, { code: 'upstream' }, 'the Error keeps its cause');
      assertStructuredMessage(input.failure.message);
      assert.equal(input.note, 'kept', 'the other inputs are retained');
      assert.equal(nodeId, 'act');
      assert.equal(attempt, 1);
      // The alias resolves to the same copied Error and the same repaired
      // message object inside this one copy.
      assert.equal(input.holder.error, input.failure);
      assert.equal(input.holder.error.message, input.failure.message);
      // Nothing is shared with the caller's objects.
      assert.notEqual(input.failure, caller.failure);
      assert.notEqual(input.failure.message, caller.failure.message);
      return { ok: true };
    },
    undo: () => 'undone',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished', 'the condition read failure.message.label off the live input');
  assert.deepEqual(result.trace.map(n => n.nodeId),
    ['start', 'form-one', 'gate', 'act', 'done']);

  // The live run input keeps the structured message.
  assert.ok(result.context.input.failure instanceof Error);
  assertStructuredMessage(result.context.input.failure.message);
  assert.equal(result.context.input.holder.error, result.context.input.failure);

  // The caller's Error was never mutated: still no own message, alias intact.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
  assert.equal(caller.failure.message, '');
  assert.equal(caller.holder.error, caller.failure);
});

test('async: a number default written at failure.message reaches the action as a number', async () => {
  const workflow = {
    id: 'numeric-message-default',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.message', type: 'number', default: 5 },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  let saw;
  const result = await executeWorkflowAsync(workflow, { failure: new Error() }, {
    op: (input) => { saw = input.failure.message; assert.ok(input.failure instanceof Error); return 'A'; },
  });
  assert.equal(result.status, 'completed');
  assert.equal(saw, 5);
  assert.equal(typeof saw, 'number', 'it is a number, never the text "5"');
  assert.equal(result.context.input.failure.message, 5);
});

test('async: boolean defaults at failure.message keep their boolean type', async () => {
  const workflow = value => ({
    id: `boolean-message-default-${value}`,
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.message', type: 'boolean', default: value },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  });
  for (const value of [false, true]) {
    let saw;
    const result = await executeWorkflowAsync(workflow(value), { failure: new Error() }, {
      op: (input) => { saw = input.failure.message; return 'A'; },
    });
    assert.equal(result.status, 'completed');
    assert.equal(saw, value);
    assert.equal(typeof saw, 'boolean', `${value} stays a boolean, never "false"/"true" text`);
  }
});

test('async: a string default at failure.message still arrives as a string', async () => {
  const workflow = {
    id: 'string-message-default',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.message', type: 'string', default: 'web' },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  let saw;
  const result = await executeWorkflowAsync(workflow, { failure: new Error() }, {
    op: (input) => { saw = input.failure.message; return 'A'; },
  });
  assert.equal(result.status, 'completed');
  assert.equal(saw, 'web');
  assert.equal(typeof saw, 'string');
});

test('async: edits to the action copy message cannot reach the run input or the caller', async () => {
  const workflow = workflowWith(
    { id: 'act', type: 'action', operation: 'op', next: 'done' },
    OBJECT_MESSAGE_FIELDS);
  const caller = callerInput();

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      // Rewrite the message, a field, a created parent and add a new one.
      input.failure.message.label = 'hacked';
      input.failure.message.meta.source = 'hacked';
      delete input.failure.message.a;
      input.failure.message.brandNew = { only: 'this-copy' };
      input.failure.message = 'replaced';
      return 'A';
    },
  });

  assert.equal(result.status, 'completed');
  // The live run input is untouched.
  assertStructuredMessage(result.context.input.failure.message);
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'brandNew'), false);
  // The caller is untouched.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
});

test('async: a retried action always gets the pristine form-written message', async () => {
  const workflow = workflowWith(
    {
      id: 'act', type: 'action', operation: 'op',
      retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
      next: 'done',
    },
    OBJECT_MESSAGE_FIELDS);

  const result = await executeWorkflowAsync(workflow, callerInput(), {
    op: (input, output, nodeId, attempt) => {
      assert.ok(input.failure instanceof Error);
      assertStructuredMessage(input.failure.message);
      if (attempt === 1) {
        // Ruin this attempt's copy of the message, then fail.
        input.failure.message.label = 'hacked';
        input.failure.message.meta.source = 'hacked';
        input.failure.message.attemptOnly = { deep: 'hacked' };
        throw new Error('first attempt fails');
      }
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  // The second attempt saw the pristine form-written value; the failed
  // attempt's changes were discarded with its copy.
  assertStructuredMessage(result.context.input.failure.message);
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'attemptOnly'), false);
});

test('async: compensation keeps the complete success-moment message and its own independent copy', async () => {
  const workflow = {
    id: 'error-message-comp-snapshot',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: OBJECT_MESSAGE_FIELDS } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: { operation: 'undo' }, next: 'form-two',
      },
      // A second successful form adds to the same message strictly AFTER act
      // succeeded; it must never enter the compensation snapshot.
      { id: 'form-two', type: 'form', next: 'boom', schema: { fields: [
        { path: 'failure.message.after', type: 'string', default: 'late' },
      ] } },
      { id: 'boom', type: 'action', operation: 'boom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const caller = callerInput();
  const compensationSeen = [];

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      assertStructuredMessage(input.failure.message);
      return { id: 'tx-1' };
    },
    undo: (input) => {
      assert.ok(input.failure instanceof Error);
      assertStructuredMessage(input.failure.message);
      assert.equal(Object.hasOwn(input.failure.message, 'after'), false,
        'a default added after the success moment is not in the snapshot');
      // Record the pristine success-moment message before this copy is
      // mutated below.
      compensationSeen.push({
        label: input.failure.message.label,
        meta: JSON.parse(JSON.stringify(input.failure.message.meta)),
        a: JSON.parse(JSON.stringify(input.failure.message.a)),
      });
      // Mutating the compensation copy stays within it.
      input.failure.message.label = 'comp-hacked';
      input.failure.message.compOnly = true;
      return 'released';
    },
    boom: () => { throw new Error('boom'); },
  });

  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'boom');
  assert.equal(result.compensationStatus, 'completed');
  assert.equal(compensationSeen.length, 1);
  assert.equal(compensationSeen[0].label, 'web');
  assert.deepEqual(compensationSeen[0].meta, { source: 'form' });
  assert.deepEqual(compensationSeen[0].a, { b: { c: 'deep' } });

  // The run input keeps both forms' writes; nothing compensation did rolls
  // anything back or leaks out.
  assertStructuredMessage(result.context.input.failure.message);
  assert.equal(result.context.input.failure.message.after, 'late');
  assert.equal(result.context.input.failure.message.label, 'web');
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'compOnly'), false);

  // The caller stays untouched.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
});

test('sync: the structured failure.message is present on the run input after a form', () => {
  const workflow = workflowWith(
    { id: 'act', type: 'action', message: 'go', next: 'done' },
    OBJECT_MESSAGE_FIELDS);
  const caller = callerInput();

  const result = executeWorkflow(workflow, caller);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.ok(result.context.input.failure instanceof Error);
  assertStructuredMessage(result.context.input.failure.message);
  assert.equal(result.context.input.note, 'kept');
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
});

test('an existing string failure.message makes a label default invalid_input and rolls other defaults back', async () => {
  const workflow = {
    id: 'existing-string-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        // Descending into the existing string is a type error.
        { path: 'failure.message.label', type: 'string', default: 'web' },
        // A sibling default the failed form must roll back too.
        { path: 'failure.code', type: 'string', default: 'E' },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'should-not-happen' },
    ],
  };
  const failure = new Error('boom');
  let opRan = false;
  const result = await executeWorkflowAsync(workflow, { failure }, {
    op: () => { opRan = true; return 'A'; },
  });

  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(result.errors, [
    { nodeId: 'form-one', path: 'failure.message.label', code: 'type' },
  ]);
  assert.equal(opRan, false, 'the action never ran');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one']);
  // The original string survives; the object was never installed, the sibling
  // default rolled back.
  assert.equal(result.context.input.failure.message, 'boom');
  assert.equal(typeof result.context.input.failure.message, 'string');
  assert.equal(Object.hasOwn(result.context.input.failure, 'code'), false);
  assert.equal(failure.message, 'boom');
});

test('reception: a caller-attached object/number own message is not resurrected as structured data', async () => {
  // Only form-written values are repaired. An own non-string message the
  // CALLER attached before the run is stringified by the receiving structured
  // clone exactly as before; the repair must not bring the caller object back.
  const workflow = {
    id: 'caller-object-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };

  const objectFailure = new Error();
  Object.defineProperty(objectFailure, 'message', {
    value: { caller: 'object' }, writable: true, enumerable: true, configurable: true,
  });
  let objectSaw;
  const objectRun = await executeWorkflowAsync(workflow, { failure: objectFailure }, {
    op: (input) => { objectSaw = input.failure.message; return 'A'; },
  });
  assert.equal(objectRun.status, 'completed');
  assert.equal(objectSaw, '[object Object]');
  assert.equal(typeof objectSaw, 'string', 'the pre-existing reception rule stringifies it');
  assert.equal(objectRun.context.input.failure.message, '[object Object]');
  assert.deepEqual(objectFailure.message, { caller: 'object' }, 'caller object left as given');

  const numberFailure = new Error();
  Object.defineProperty(numberFailure, 'message', {
    value: 42, writable: true, enumerable: true, configurable: true,
  });
  let numberSaw;
  const numberRun = await executeWorkflowAsync(workflow, { failure: numberFailure }, {
    op: (input) => { numberSaw = input.failure.message; return 'A'; },
  });
  assert.equal(numberRun.status, 'completed');
  assert.equal(numberSaw, '42');
  assert.equal(typeof numberSaw, 'string');
});
