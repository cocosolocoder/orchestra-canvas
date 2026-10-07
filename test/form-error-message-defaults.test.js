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

// "toString" is an ordinary data field on the form-written message object —
// legal exactly like "label", never a method to forbid or rename. Before the
// fix it was fatal in a different way than a plain object message: serializing
// an Error runs the message slot through a ToString coercion, which finds the
// non-callable "toString" field and throws "Cannot convert object to
// primitive value", aborting structuredClone before the business operation was
// ever invoked (outside its attempt try/catch, so the run died without a
// single attempt record).
const TOSTRING_MESSAGE_FIELDS = [
  { path: 'failure.message.toString', type: 'string', default: 'web' },
  { path: 'failure.message.label', type: 'string', default: 'web' },
  // Further fields and a whole created parent chain ride on the same object.
  { path: 'failure.message.meta.source', type: 'string', default: 'form' },
  { path: 'failure.message.a.b.c', type: 'string', default: 'deep' },
];

function assertTostringMessage(message) {
  assert.equal(typeof message, 'object', 'the message stays an object, not a string');
  assert.notEqual(message, null);
  assert.equal(message.toString, 'web', 'toString is a plain string data field');
  assert.equal(typeof message.toString, 'string');
  assert.equal(message.label, 'web', 'label reads along the same path');
  assert.deepEqual(message.meta, { source: 'form' });
  assert.deepEqual(message.a, { b: { c: 'deep' } }, 'created parents come whole');
}

test('async: a business action reads failure.message.toString kept as a string data field', async () => {
  const workflow = workflowWith(
    { id: 'act', type: 'action', operation: 'op', compensation: { operation: 'undo' }, next: 'done' },
    TOSTRING_MESSAGE_FIELDS);
  const caller = callerInput();

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input, output, nodeId, attempt) => {
      assert.ok(input.failure instanceof Error, 'failure is still an Error');
      assert.equal(input.failure.name, 'Error', 'the Error keeps its name');
      assert.equal(typeof input.failure.stack, 'string', 'the Error keeps its stack');
      assert.deepEqual(input.failure.cause, { code: 'upstream' }, 'the Error keeps its cause');
      assertTostringMessage(input.failure.message);
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
  // Preparing the legal input produced no failed attempt and consumed no retry.
  assert.equal(result.actionAttempts.length, 1);
  assert.equal(result.actionAttempts[0].attempt, 1);
  assert.equal(result.actionAttempts[0].ok, true);
  assert.equal(result.actionAttempts[0].error, null);

  // The live run input keeps the structured message and its Error identity.
  assert.ok(result.context.input.failure instanceof Error);
  assertTostringMessage(result.context.input.failure.message);
  assert.equal(result.context.input.holder.error, result.context.input.failure);
  const liveDescriptor = Object.getOwnPropertyDescriptor(result.context.input.failure, 'message');
  assert.equal(liveDescriptor.enumerable, true, 'the live own message keeps its descriptor shape');
  assert.equal(liveDescriptor.writable, true);
  assert.equal(liveDescriptor.configurable, true);

  // The caller's Error was never mutated: still no own message, alias intact.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
  assert.equal(caller.failure.message, '');
  assert.equal(caller.holder.error, caller.failure);
});

test('async: a condition reads failure.message.toString as the data field, not the method', async () => {
  const workflow = {
    id: 'tostring-condition',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'gate', schema: { fields: TOSTRING_MESSAGE_FIELDS } },
      {
        id: 'gate', type: 'condition', then: 'act', else: 'missed',
        condition: { field: 'failure.message.toString', operator: 'eq', value: 'web' },
      },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
      { id: 'missed', type: 'end', result: 'condition-did-not-see-tostring' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, callerInput(), {
    op: input => { assertTostringMessage(input.failure.message); return 'A'; },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
});

test('async: edits to the action copy of a toString message cannot reach the run input or the caller', async () => {
  const workflow = workflowWith(
    { id: 'act', type: 'action', operation: 'op', next: 'done' },
    TOSTRING_MESSAGE_FIELDS);
  const caller = callerInput();

  const result = await executeWorkflowAsync(workflow, caller, {
    op: (input) => {
      // Rewrite the data fields, a created parent and the whole message slot.
      input.failure.message.toString = 'hacked';
      input.failure.message.label = 'hacked';
      input.failure.message.meta.source = 'hacked';
      delete input.failure.message.a;
      input.failure.message.brandNew = { only: 'this-copy' };
      input.failure.message = 'replaced';
      input.failure.cause.code = 'hacked';
      return 'A';
    },
  });

  assert.equal(result.status, 'completed');
  // The live run input is untouched.
  assertTostringMessage(result.context.input.failure.message);
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'brandNew'), false);
  assert.equal(result.context.input.failure.cause.code, 'upstream');
  // The caller is untouched.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
  assert.deepEqual(caller.failure.cause, { code: 'upstream' });
});

test('async: a retried action always gets the pristine toString default', async () => {
  const workflow = workflowWith(
    {
      id: 'act', type: 'action', operation: 'op',
      retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
      next: 'done',
    },
    TOSTRING_MESSAGE_FIELDS);

  const result = await executeWorkflowAsync(workflow, callerInput(), {
    op: (input, output, nodeId, attempt) => {
      assert.ok(input.failure instanceof Error);
      assertTostringMessage(input.failure.message);
      if (attempt === 1) {
        // Ruin this attempt's copy of the message, then fail for real.
        input.failure.message.toString = 'hacked';
        input.failure.message.label = 'hacked';
        input.failure.message.attemptOnly = { deep: 'hacked' };
        throw new Error('first attempt fails');
      }
      return { ok: true };
    },
  });

  assert.equal(result.status, 'completed');
  // Only the genuine business failure was recorded; the input copy never was.
  assert.deepEqual(result.actionAttempts.map(r => [r.attempt, r.ok, r.error]), [
    [1, false, 'first attempt fails'],
    [2, true, null],
  ]);
  // The second attempt saw the pristine form-written value; the failed
  // attempt's changes were discarded with its copy.
  assertTostringMessage(result.context.input.failure.message);
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'attemptOnly'), false);
});

test('async: compensation keeps the success-moment toString message and an isolated, retry-pristine copy', async () => {
  const workflow = {
    id: 'error-tostring-comp-snapshot',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: TOSTRING_MESSAGE_FIELDS } },
      {
        id: 'act', type: 'action', operation: 'op',
        compensation: {
          operation: 'undo',
          retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        },
        next: 'form-two',
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
      assertTostringMessage(input.failure.message);
      return { id: 'tx-1' };
    },
    undo: (input, output, returned, nodeId, attempt) => {
      assert.ok(input.failure instanceof Error);
      assert.equal(input.failure.name, 'Error');
      assert.deepEqual(input.failure.cause, { code: 'upstream' });
      assertTostringMessage(input.failure.message);
      assert.equal(Object.hasOwn(input.failure.message, 'after'), false,
        'a default added after the success moment is not in the snapshot');
      compensationSeen.push({
        toString: input.failure.message.toString,
        label: input.failure.message.label,
        meta: JSON.parse(JSON.stringify(input.failure.message.meta)),
        a: JSON.parse(JSON.stringify(input.failure.message.a)),
      });
      // Mutating this compensation copy stays within it.
      input.failure.message.toString = 'comp-hacked';
      input.failure.message.label = 'comp-hacked';
      input.failure.message.compOnly = true;
      if (attempt === 1) throw new Error('compensation first attempt fails');
      return 'released';
    },
    boom: () => { throw new Error('boom'); },
  });

  // The original failure result and the compensation records are both kept.
  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'boom');
  assert.equal(result.error, 'boom');
  assert.equal(result.compensationStatus, 'completed');
  assert.equal(result.compensationAttempts.length, 2);
  assert.deepEqual(result.compensationAttempts.map(r => [r.attempt, r.ok, r.result, r.error]), [
    [1, false, null, 'compensation first attempt fails'],
    [2, true, 'released', null],
  ]);
  // Both compensation attempts received the pristine success-moment message.
  assert.equal(compensationSeen.length, 2);
  for (const seen of compensationSeen) {
    assert.equal(seen.toString, 'web');
    assert.equal(seen.label, 'web');
    assert.deepEqual(seen.meta, { source: 'form' });
    assert.deepEqual(seen.a, { b: { c: 'deep' } });
  }

  // The run input keeps both forms' writes; nothing compensation did rolls
  // anything back or leaks out.
  assertTostringMessage(result.context.input.failure.message);
  assert.equal(result.context.input.failure.message.after, 'late');
  assert.equal(result.context.input.failure.message.label, 'web');
  assert.equal(Object.hasOwn(result.context.input.failure.message, 'compOnly'), false);

  // The caller stays untouched.
  assert.equal(Object.hasOwn(caller.failure, 'message'), false);
});

test('async: the same shielding reaches bad-toString errors nested under a cause and plain-object holders', async () => {
  const workflow = {
    id: 'tostring-nested-errors',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.message.toString', type: 'string', default: 'outer' },
        // The inner Error sits only behind the non-enumerable cause link.
        { path: 'failure.cause.inner.message.toString', type: 'string', default: 'inner' },
        // A third Error reached through an ordinary own-property chain.
        { path: 'bag.mapped.message.toString', type: 'string', default: 'mapped' },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  // None of the three carries an own message (the empty string lives on the
  // prototype), so each form creates the message object itself.
  const inner = new Error();
  const failure = new Error(undefined, { cause: { inner } });
  const mapped = new Error();
  // An Error whose message is genuinely a string sits right next to the
  // shielded one; the shield must leave the slot and its prototype method alone.
  const textual = new Error('kept-text');
  const input = { failure, bag: { mapped, textual } };

  const result = await executeWorkflowAsync(workflow, input, {
    op: (received) => {
      assert.ok(received.failure instanceof Error);
      assert.equal(received.failure.name, 'Error');
      assert.equal(received.failure.message.toString, 'outer');
      assert.ok(received.failure.cause.inner instanceof Error);
      assert.equal(received.failure.cause.inner.message.toString, 'inner');
      assert.ok(received.bag.mapped instanceof Error);
      assert.equal(received.bag.mapped.message.toString, 'mapped');
      assert.ok(received.bag.textual instanceof Error);
      assert.equal(received.bag.textual.message, 'kept-text',
        'a string message slot is never touched by the shield');
      assert.equal(received.bag.textual.message.toString(), 'kept-text',
        'the String.prototype.toString method still works on it');
      return 'A';
    },
  });
  assert.equal(result.status, 'completed');
  // Live input kept the form-written values; the caller's objects are intact.
  assert.equal(result.context.input.failure.message.toString, 'outer');
  assert.equal(result.context.input.failure.cause.inner.message.toString, 'inner');
  assert.equal(result.context.input.bag.mapped.message.toString, 'mapped');
  // The caller's own objects were never mutated: the inner Error still has no
  // own message and the shielded slots are exactly as handed in.
  assert.equal(Object.hasOwn(failure.cause.inner, 'message'), false);
  assert.equal(failure.cause.inner.message, '');
  assert.equal(Object.hasOwn(failure, 'message'), false);
  assert.equal(textual.message, 'kept-text');
});

test('async: an Error aliased through a Map value and a Set member keeps one identity and its repaired message', async () => {
  // Form paths cannot cross a Map/Set, so the defaults land through a plain
  // object alias; the Map/Set only make the Error reachable through their
  // internal entries — exactly where the pre-clone shield must follow.
  const workflow = {
    id: 'tostring-mapset-errors',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'alias.message.toString', type: 'string', default: 'web' },
        { path: 'alias.message.label', type: 'string', default: 'web' },
      ] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const failure = new Error();
  const viaMap = new Map([['error', failure]]);
  const viaSet = new Set([failure]);
  const input = { alias: failure, viaMap, viaSet };

  const result = await executeWorkflowAsync(workflow, input, {
    op: (received) => {
      assert.equal(received.viaMap.get('error'), received.alias,
        'the Map entry aliases the single copied Error');
      assert.ok(received.viaSet.has(received.alias), 'the Set member is the same Error');
      assert.equal(received.alias.message.toString, 'web');
      assert.equal(received.alias.message.label, 'web');
      return 'A';
    },
  });
  assert.equal(result.status, 'completed');
  // The caller's containers and Error were never mutated.
  assert.equal(Object.hasOwn(failure, 'message'), false);
  assert.equal(viaMap.get('error'), failure);
  assert.ok(viaSet.has(failure));
});

test('async: a form-written non-string failure.name with a toString data field is repaired the same way', async () => {
  const workflow = {
    id: 'tostring-name-default',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'gate', schema: { fields: [
        { path: 'failure.name.toString', type: 'string', default: 'CustomKind' },
        { path: 'failure.name.label', type: 'string', default: 'CustomKind' },
      ] } },
      {
        id: 'gate', type: 'condition', then: 'act', else: 'missed',
        condition: { field: 'failure.name.toString', operator: 'eq', value: 'CustomKind' },
      },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
      { id: 'missed', type: 'end', result: 'condition-did-not-see-name' },
    ],
  };
  const failure = new Error('boom');
  const result = await executeWorkflowAsync(workflow, { failure }, {
    op: (input) => {
      assert.ok(input.failure instanceof Error);
      assert.equal(input.failure.message, 'boom', 'the message slot is untouched');
      assert.equal(typeof input.failure.name, 'object', 'name keeps the form-written object');
      assert.equal(input.failure.name.toString, 'CustomKind', 'toString stays a data field');
      assert.equal(input.failure.name.label, 'CustomKind');
      return 'A';
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.equal(typeof result.context.input.failure.name, 'object');
  assert.equal(result.context.input.failure.name.toString, 'CustomKind');
  // The caller's Error keeps its string name.
  assert.equal(failure.name, 'Error');
});

test('an already-string failure.message makes a toString default invalid_input too, with the sibling default rolled back', async () => {
  // toString is not special: beneath an existing string message the path is
  // the same type error as failure.message.label, and the failed form's other
  // defaults roll back; no operation runs.
  const workflow = {
    id: 'existing-string-message-tostring',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [
        { path: 'failure.message.toString', type: 'string', default: 'web' },
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
    { nodeId: 'form-one', path: 'failure.message.toString', code: 'type' },
  ]);
  assert.equal(opRan, false, 'the action never ran');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'form-one']);
  assert.equal(result.context.input.failure.message, 'boom');
  assert.equal(typeof result.context.input.failure.message, 'string');
  assert.equal(result.context.input.failure.message.toString(), 'boom',
    'the real prototype method is still intact on the live input');
  assert.equal(Object.hasOwn(result.context.input.failure, 'code'), false);
  assert.equal(failure.message, 'boom');
});

test('reception: a caller-attached message object carrying a toString data field is still rejected before any node runs', async () => {
  // The clone-time shielding exists only for form-written values; the
  // receiving clone follows the ordinary structuredClone rules and rejects
  // such a CALLER-attached message with its raw failure.
  const workflow = {
    id: 'caller-bad-tostring-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'form-one' },
      { id: 'form-one', type: 'form', next: 'act', schema: { fields: [] } },
      { id: 'act', type: 'action', operation: 'op', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const failure = new Error();
  Object.defineProperty(failure, 'message', {
    value: { toString: 'web' }, writable: true, enumerable: true, configurable: true,
  });
  let opRan = false;
  await assert.rejects(
    executeWorkflowAsync(workflow, { failure }, { op: () => { opRan = true; return 'A'; } }),
    error => error instanceof TypeError && /Cannot convert object to primitive value/.test(error.message));
  assert.equal(opRan, false);
  assert.deepEqual(failure.message, { toString: 'web' }, 'caller object left as given');
});
