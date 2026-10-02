import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

// A workflow where a condition branches on the output of an earlier action:
// the action's saved { risk: { score } } is compared against the input's
// threshold without writing anything back into the input.
function riskWorkflow(condition) {
  return {
    id: 'risk',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'risk-check' },
      { id: 'risk-check', type: 'action', operation: 'assess', next: 'decide' },
      { id: 'decide', type: 'condition', condition, then: 'approve', else: 'reject' },
      { id: 'approve', type: 'end', result: 'approved' },
      { id: 'reject', type: 'end', result: 'rejected' },
    ],
  };
}

const assesses = score => ({ assess: async () => ({ risk: { score } }) });

test('branches on an action output compared against an input field', async () => {
  const condition = {
    outputField: { nodeId: 'risk-check', path: 'risk.score' },
    operator: 'gte',
    valueField: 'threshold',
  };
  const high = await executeWorkflowAsync(riskWorkflow(condition), { threshold: 70 }, assesses(80));
  assert.equal(high.result, 'approved');
  const low = await executeWorkflowAsync(riskWorkflow(condition), { threshold: 90 }, assesses(80));
  assert.equal(low.result, 'rejected');
});

test('reads the whole return value when the reference omits path', async () => {
  const condition = {
    outputField: { nodeId: 'risk-check' },
    operator: 'eq',
    value: 'ok',
  };
  const run = await executeWorkflowAsync(riskWorkflow(condition), {}, { assess: async () => 'ok' });
  assert.equal(run.result, 'approved');
});

test('compares two action outputs through valueOutputField', async () => {
  const workflow = {
    id: 'two-outputs',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'left' },
      { id: 'left', type: 'action', operation: 'leftOp', next: 'right' },
      { id: 'right', type: 'action', operation: 'rightOp', next: 'decide' },
      {
        id: 'decide', type: 'condition',
        condition: {
          outputField: { nodeId: 'left', path: 'score' },
          operator: 'lte',
          valueOutputField: { nodeId: 'right', path: 'limit' },
        },
        then: 'within', else: 'beyond',
      },
      { id: 'within', type: 'end', result: 'within' },
      { id: 'beyond', type: 'end', result: 'beyond' },
    ],
  };
  const operations = { leftOp: async () => ({ score: 5 }), rightOp: async () => ({ limit: 10 }) };
  const run = await executeWorkflowAsync(workflow, {}, operations);
  assert.equal(run.result, 'within');
});

test('mixes output references with classic input references on either side', async () => {
  const leftOutput = await executeWorkflowAsync(
    riskWorkflow({ outputField: { nodeId: 'risk-check', path: 'risk.score' }, operator: 'gte', value: 80 }),
    {}, assesses(80));
  assert.equal(leftOutput.result, 'approved');
  const rightOutput = await executeWorkflowAsync(
    riskWorkflow({ field: 'threshold', operator: 'lte', valueOutputField: { nodeId: 'risk-check', path: 'risk.score' } }),
    { threshold: 70 }, assesses(80));
  assert.equal(rightOutput.result, 'approved');
});

test('a missing referenced output makes a plain comparison false, never an error', async () => {
  // The condition runs before the referenced action could ever execute.
  const workflow = {
    id: 'not-run-yet',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'decide' },
      {
        id: 'decide', type: 'condition',
        condition: { outputField: { nodeId: 'later', path: 'x' }, operator: 'eq', value: 1 },
        then: 'yes', else: 'no',
      },
      { id: 'later', type: 'action', operation: 'noop', next: 'yes' },
      { id: 'yes', type: 'end', result: 'yes' },
      { id: 'no', type: 'end', result: 'no' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { noop: async () => ({ x: 1 }) });
  assert.equal(run.result, 'no');
  assert.deepEqual(run.trace.map(n => n.nodeId), ['start', 'decide', 'no']);
});

test('exists on an output reference only checks presence on the left side', async () => {
  const presentValues = [null, '', 0, false, undefined];
  for (const value of presentValues) {
    const condition = { outputField: { nodeId: 'risk-check', path: 'risk.score' }, operator: 'exists' };
    const run = await executeWorkflowAsync(riskWorkflow(condition), {}, { assess: async () => ({ risk: { score: value } }) });
    assert.equal(run.result, 'approved', `saved ${String(value)} counts as present`);
  }
  const missing = await executeWorkflowAsync(
    riskWorkflow({ outputField: { nodeId: 'risk-check', path: 'risk.absent' }, operator: 'exists' }),
    {}, assesses(1));
  assert.equal(missing.result, 'rejected');
});

test('an array or non-object parent on the reference path counts as missing', async () => {
  const condition = { outputField: { nodeId: 'risk-check', path: 'risk.score.value' }, operator: 'exists' };
  const arrayParent = await executeWorkflowAsync(riskWorkflow(condition), {}, { assess: async () => ({ risk: { score: [1] } }) });
  assert.equal(arrayParent.result, 'rejected');
  const scalarParent = await executeWorkflowAsync(riskWorkflow(condition), {}, { assess: async () => ({ risk: { score: 7 } }) });
  assert.equal(scalarParent.result, 'rejected');
});

test('a node id containing dots is matched as a whole string, not as a path', async () => {
  const workflow = {
    id: 'dotted',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'risk.check' },
      { id: 'risk.check', type: 'action', operation: 'assess', next: 'decide' },
      {
        id: 'decide', type: 'condition',
        condition: { outputField: { nodeId: 'risk.check', path: 'score' }, operator: 'eq', value: 1 },
        then: 'yes', else: 'no',
      },
      { id: 'yes', type: 'end', result: 'yes' },
      { id: 'no', type: 'end', result: 'no' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { assess: async () => ({ score: 1 }) });
  assert.equal(run.result, 'yes');
});

test('the synchronous entry resolves outputs saved by legacy message actions', () => {
  const workflow = {
    id: 'sync-outputs',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'notify' },
      { id: 'notify', type: 'action', message: 'ready', next: 'decide' },
      {
        id: 'decide', type: 'condition',
        condition: { outputField: { nodeId: 'notify' }, operator: 'eq', value: 'ready' },
        then: 'yes', else: 'no',
      },
      { id: 'yes', type: 'end', result: 'yes' },
      { id: 'no', type: 'end', result: 'no' },
    ],
  };
  assert.equal(executeWorkflow(workflow, {}).result, 'yes');
});

test('a numeric comparison against a non-numeric output fails with invalid_condition and compensates', async () => {
  const workflow = riskWorkflow({
    outputField: { nodeId: 'risk-check', path: 'risk.score' },
    operator: 'gte',
    value: 10,
  });
  workflow.nodes.splice(2, 0, {
    id: 'compensated', type: 'action', operation: 'book',
    compensation: { operation: 'unbook' },
    next: 'risk-check',
  });
  workflow.nodes[0].next = 'compensated';
  const calls = [];
  const run = await executeWorkflowAsync(workflow, {}, {
    book: async () => 'booked',
    unbook: async (input, output, result, nodeId) => { calls.push([result, nodeId]); return 'undone'; },
    assess: async () => ({ risk: { score: 'not-a-number' } }),
  });
  assert.equal(run.status, 'invalid_condition');
  assert.match(run.error, /condition node decide at \$: value at outputField cannot convert to a finite number/);
  assert.deepEqual(run.trace.map(n => n.nodeId), ['start', 'compensated', 'risk-check', 'decide']);
  assert.deepEqual(calls, [['booked', 'compensated']]);
  assert.equal(run.compensationStatus, 'completed');
});

test('a non-numeric output on the right side fails through valueOutputField', async () => {
  const run = await executeWorkflowAsync(
    riskWorkflow({ field: 'threshold', operator: 'lte', valueOutputField: { nodeId: 'risk-check', path: 'risk.score' } }),
    { threshold: 5 }, { assess: async () => ({ risk: { score: {} } }) });
  assert.equal(run.status, 'invalid_condition');
  assert.match(run.error, /value at valueOutputField cannot convert to a finite number/);
});

test('short-circuited output comparisons never raise invalid_condition', async () => {
  const condition = {
    all: [
      { field: 'skip', operator: 'eq', value: true },
      { outputField: { nodeId: 'risk-check', path: 'risk.score' }, operator: 'gte', value: 1 },
    ],
  };
  const run = await executeWorkflowAsync(riskWorkflow(condition), { skip: false }, { assess: async () => ({ risk: { score: {} } }) });
  assert.equal(run.result, 'rejected');
});

test('rejects malformed output references before any node executes', () => {
  const base = riskWorkflow({ outputField: { nodeId: 'risk-check' }, operator: 'exists' });
  const invalid = [
    [{ outputField: 'risk-check', operator: 'exists' }, /output reference must be an object/],
    [{ outputField: ['risk-check'], operator: 'exists' }, /output reference must be an object/],
    [{ outputField: { nodeId: 5 }, operator: 'exists' }, /nodeId must be a non-empty string/],
    [{ outputField: { nodeId: '' }, operator: 'exists' }, /nodeId must be a non-empty string/],
    [{ outputField: { nodeId: 'ghost' }, operator: 'exists' }, /must name an action node/],
    [{ outputField: { nodeId: 'decide' }, operator: 'exists' }, /must name an action node/],
    [{ outputField: { nodeId: 'risk-check', path: '' }, operator: 'exists' }, /path must be a non-empty string/],
    [{ outputField: { nodeId: 'risk-check', path: 'a..b' }, operator: 'exists' }, /empty segments/],
    [{ outputField: { nodeId: 'risk-check', path: 'a.__proto__' }, operator: 'exists' }, /__proto__/],
    [{ outputField: { nodeId: 'risk-check', path: 'constructor' }, operator: 'exists' }, /constructor/],
    [{ field: 'x', outputField: { nodeId: 'risk-check' }, operator: 'exists' }, /exactly one of field or outputField/],
    [{ outputField: { nodeId: 'risk-check' }, operator: 'eq', value: 1, valueOutputField: { nodeId: 'risk-check' } }, /exactly one of value, valueField or valueOutputField/],
    [{ outputField: { nodeId: 'risk-check' }, operator: 'eq' }, /exactly one of value, valueField or valueOutputField/],
    [{ outputField: { nodeId: 'risk-check' }, operator: 'exists', valueOutputField: { nodeId: 'risk-check' } }, /exists only takes a left side/],
    [{ field: 'x', operator: 'eq', valueOutputField: { nodeId: 'nope' } }, /must name an action node/],
    [{ all: [{ outputField: { nodeId: 'risk-check' }, operator: 'exists' }], outputField: { nodeId: 'risk-check' } }, /must not mix in/],
  ];
  for (const [condition, matcher] of invalid) {
    const workflow = riskWorkflow(condition);
    assert.throws(() => validateWorkflow(workflow), matcher, JSON.stringify(condition));
    assert.throws(() => executeWorkflow(workflow, {}), matcher);
  }
  assert.doesNotThrow(() => validateWorkflow(base));
});

test('definition errors name the condition node and the nested child position', () => {
  const condition = {
    all: [
      { field: 'x', operator: 'exists' },
      { not: { outputField: { nodeId: 'ghost' }, operator: 'exists' } },
    ],
  };
  try {
    validateWorkflow(riskWorkflow(condition));
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /condition node decide at \$\.all\[1\]\.not outputField: .*must name an action node/);
  }
});

test('output references do not activate, wait for, or add dependencies on their target', async () => {
  // The referenced action sits on the other branch and never runs; the
  // condition simply sees a missing output and takes the else branch.
  const workflow = {
    id: 'no-activation',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'decide' },
      {
        id: 'decide', type: 'condition',
        condition: { outputField: { nodeId: 'other', path: 'x' }, operator: 'exists' },
        then: 'yes', else: 'no',
      },
      { id: 'yes', type: 'action', operation: 'noop', next: 'end' },
      { id: 'no', type: 'end', result: 'no' },
      { id: 'other', type: 'action', operation: 'noop', next: 'end' },
      { id: 'end', type: 'end', result: 'end' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { noop: async () => ({ x: 1 }) });
  assert.equal(run.result, 'no');
  assert.deepEqual(run.trace.map(n => n.nodeId), ['start', 'decide', 'no']);
});

test('failed attempts and compensation results never become readable outputs', async () => {
  const workflow = {
    id: 'no-failed-outputs',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'flaky' },
      {
        id: 'flaky', type: 'action', operation: 'flaky',
        retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        next: 'decide',
      },
      {
        id: 'decide', type: 'condition',
        condition: { outputField: { nodeId: 'flaky', path: 'attempt' }, operator: 'eq', value: 2 },
        then: 'yes', else: 'no',
      },
      { id: 'yes', type: 'end', result: 'yes' },
      { id: 'no', type: 'end', result: 'no' },
    ],
  };
  let calls = 0;
  const run = await executeWorkflowAsync(workflow, {}, {
    flaky: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient failure'); // its "output" is never saved
      return { attempt: 2 };
    },
  });
  // Only the successful attempt's saved output is visible to the condition.
  assert.equal(run.result, 'yes');
  assert.equal(calls, 2);
});
