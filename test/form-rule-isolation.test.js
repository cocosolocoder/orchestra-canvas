import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Regression coverage for form-rule isolation across validations.
//
// start -> act (business action + compensation, held pending externally)
//       -> collect (form: amount number min 10; channel string default "web")
//       -> done (end)
//
// The compiled form rules used to live in a module-level WeakMap keyed by the
// node object, so re-validating an edited definition overwrote the rules a
// run suspended inside "act" was about to use when it reached "collect". Each
// run must keep using the rules its own start-time validation accepted.
function buildWorkflow() {
  return {
    id: 'form-rule-isolation',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'act' },
      {
        id: 'act', type: 'action', operation: 'act',
        compensation: { operation: 'undo' }, next: 'collect',
      },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'amount', type: 'number', min: 10 },
        { path: 'channel', type: 'string', default: 'web' },
      ] } },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

function formNode(workflow) {
  return workflow.nodes.find(node => node.id === 'collect');
}

// Rewrites the same form object's field list constraints/default in place:
// amount's lower bound moves 10 -> 20 and the channel default "web" -> "api".
function tightenDefinition(workflow) {
  const fields = formNode(workflow).schema.fields;
  fields[0].min = 20;
  fields[1].default = 'api';
}

function operationsWithHeldAction() {
  let release;
  const operations = {
    act: () => new Promise(resolve => { release = () => resolve('acted'); }),
    undo: () => 'undone',
  };
  return { operations, release: () => release() };
}

const immediateOperations = () => ({
  act: async () => 'acted',
  undo: () => 'undone',
});

test('a suspended run keeps the rules its start-time validation accepted after the definition is edited and re-validated', async () => {
  const workflow = buildWorkflow();
  const { operations, release } = operationsWithHeldAction();

  // amount 15 passes under the original rules (number, min 10); a missing
  // channel is to be defaulted to "web".
  const pendingRun = executeWorkflowAsync(workflow, { amount: 15 }, operations);
  await sleep(5); // let the run park inside the pending business action

  // While the earlier run has not returned from its business action, tighten
  // the same form object and independently re-validate the edited definition.
  tightenDefinition(workflow);
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.equal(formNode(workflow).schema.fields[0].min, 20);
  assert.equal(formNode(workflow).schema.fields[1].default, 'api');

  // The earlier run resumes and still processes the form with the rules it
  // started under: amount 15 passes and the channel default is still "web".
  release();
  const result = await pendingRun;

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.context.input, { amount: 15, channel: 'web' });
  assert.deepEqual(result.context.output, { act: 'acted' });
  assert.deepEqual(result.trace.map(node => `${node.nodeId}:${node.type}`), [
    'start:trigger', 'act:action', 'collect:form', 'done:end',
  ]);
  assert.equal(result.compensationStatus, 'not_needed');
});

test('a later run uses the edited rules: amount 15 fails range, earlier records survive and the failed default is rolled back', async () => {
  const workflow = buildWorkflow();
  tightenDefinition(workflow);
  assert.doesNotThrow(() => validateWorkflow(workflow));

  const callerInput = { amount: 15 };
  const result = await executeWorkflowAsync(workflow, callerInput, immediateOperations());

  assert.equal(result.status, 'invalid_input');
  // Field errors follow the adopted fields' declaration order.
  assert.deepEqual(result.errors, [
    { nodeId: 'collect', path: 'amount', code: 'range' },
  ]);
  // The business action's record produced before the form survives; the
  // default ("api") the failed form wrote is undone, so the input is exactly
  // what the caller submitted.
  assert.deepEqual(result.context.input, { amount: 15 });
  assert.deepEqual(result.context.output, { act: 'acted' });
  assert.deepEqual(callerInput, { amount: 15 });
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'act', 'collect']);
  // Form failure still triggers compensation of the earlier success.
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(result.compensationAttempts.map(r => [r.nodeId, r.operation, r.ok]), [
    ['act', 'undo', true],
  ]);
});

test('a later run with amount 25 and no channel passes and receives the new "api" default', async () => {
  const workflow = buildWorkflow();
  tightenDefinition(workflow);
  assert.doesNotThrow(() => validateWorkflow(workflow));

  const result = await executeWorkflowAsync(workflow, { amount: 25 }, immediateOperations());

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.context.input, { amount: 25, channel: 'api' });
  assert.deepEqual(result.context.output, { act: 'acted' });
  assert.equal(result.compensationStatus, 'not_needed');
});

test('an independent validation that fails on another node after reading this form still cannot change the suspended run', async () => {
  const workflow = buildWorkflow();
  const { operations, release } = operationsWithHeldAction();

  const pendingRun = executeWorkflowAsync(workflow, { amount: 15 }, operations);
  await sleep(5);

  // Edit the form as before, but also make a different node invalid: an
  // orphan condition node the entry cannot reach still fails validation.
  tightenDefinition(workflow);
  workflow.nodes.push({
    id: 'ghost', type: 'condition', then: 'done', else: 'done',
    condition: { field: 42, operator: 'eq', value: 1 },
  });
  assert.throws(() => validateWorkflow(workflow), /condition node ghost/);

  // The failed validation published no rules at all; the suspended run still
  // owns the rules accepted when it started and finishes under them.
  release();
  const result = await pendingRun;

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.context.input, { amount: 15, channel: 'web' });
  assert.deepEqual(result.context.output, { act: 'acted' });

  // The edited definition is still rejected under the existing rules.
  assert.throws(() => validateWorkflow(workflow), /condition node ghost/);
});

test('starting a new run over the edited definition does not replace a still-suspended earlier run\'s rules', async () => {
  const workflow = buildWorkflow();
  const { operations, release } = operationsWithHeldAction();

  const firstRun = executeWorkflowAsync(workflow, { amount: 15 }, operations);
  await sleep(5);

  // Edit without a separate validateWorkflow call; the new run's own start
  // performs the validation and accepts the tightened rules only for itself.
  tightenDefinition(workflow);
  const secondRun = await executeWorkflowAsync(workflow, { amount: 15 }, immediateOperations());
  assert.equal(secondRun.status, 'invalid_input');
  assert.deepEqual(secondRun.errors, [
    { nodeId: 'collect', path: 'amount', code: 'range' },
  ]);
  assert.deepEqual(secondRun.context.input, { amount: 15 });

  // The earlier run still passes its form with the original bound/default.
  release();
  const firstResult = await firstRun;
  assert.equal(firstResult.status, 'completed');
  assert.deepEqual(firstResult.context.input, { amount: 15, channel: 'web' });
});

test('validation and execution never mutate the caller definition or input while pinning rules', async () => {
  const workflow = buildWorkflow();
  const definitionSnapshot = structuredClone(workflow);
  const input = { amount: 15, channel: 'web' };
  const inputSnapshot = structuredClone(input);

  validateWorkflow(workflow);
  const result = await executeWorkflowAsync(workflow, input, immediateOperations());

  assert.equal(result.status, 'completed');
  assert.deepEqual(workflow, definitionSnapshot);
  assert.deepEqual(input, inputSnapshot);
  assert.notEqual(result.context.input, input);
});
