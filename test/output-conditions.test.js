import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

// Workflow: start -> risk-check (action) -> check (condition) -> pass/fail.
function outputConditionWorkflow(condition, { actionProps = {}, sync = false } = {}) {
  return {
    id: 'out-cond',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'risk-check' },
      {
        id: 'risk-check', type: 'action',
        ...(sync ? { message: 'hello' } : { operation: 'risk' }),
        ...actionProps,
        next: 'check',
      },
      { id: 'check', type: 'condition', condition, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
}

const branchOf = async (condition, operations, input = {}) => {
  const result = await executeWorkflowAsync(outputConditionWorkflow(condition), input, operations);
  return result.result;
};

test('routes a condition by an action output path without writing it back to input', async () => {
  const condition = {
    outputField: { nodeId: 'risk-check', path: 'risk.score' },
    operator: 'gte', valueField: 'threshold',
  };
  const high = await executeWorkflowAsync(
    outputConditionWorkflow(condition), { threshold: 80 }, { risk: () => ({ risk: { score: 80 } }) });
  assert.equal(high.result, 'passed');
  // The action output is never written back to the input.
  assert.deepEqual(high.context.input, { threshold: 80 });

  const low = await executeWorkflowAsync(
    outputConditionWorkflow(condition), { threshold: 90 }, { risk: () => ({ risk: { score: 80 } }) });
  assert.equal(low.result, 'failed');
});

test('outputField with no path reads the whole return value', async () => {
  assert.equal(
    await branchOf({ outputField: { nodeId: 'risk-check' }, operator: 'eq', value: 'ok' },
      { risk: () => 'ok' }),
    'passed');
  assert.equal(
    await branchOf({ outputField: { nodeId: 'risk-check' }, operator: 'eq', value: 'ok' },
      { risk: () => 'nope' }),
    'failed');
});

test('valueOutputField compares two action outputs', async () => {
  const workflow = {
    id: 'two-outputs', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'risk-check' },
      { id: 'risk-check', type: 'action', operation: 'risk', next: 'limit-src' },
      { id: 'limit-src', type: 'action', operation: 'limit', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'risk-check', path: 'risk.score' },
        operator: 'gte',
        valueOutputField: { nodeId: 'limit-src', path: 'max' },
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = async (riskValue, limitValue) =>
    (await executeWorkflowAsync(workflow, {}, {
      risk: () => ({ risk: { score: riskValue } }),
      limit: () => ({ max: limitValue }),
    })).result;
  assert.equal(await run(80, 80), 'passed');
  assert.equal(await run(70, 80), 'failed');
  // eq is never coerced: '80' !== 80.
  const eqWorkflow = structuredClone(workflow);
  eqWorkflow.nodes.find(n => n.type === 'condition').condition.operator = 'eq';
  assert.equal(
    (await executeWorkflowAsync(eqWorkflow, {}, {
      risk: () => ({ risk: { score: '80' } }),
      limit: () => ({ max: 80 }),
    })).result,
    'failed');
});

test('new and old references can be mixed on either side', async () => {
  // field (input) vs valueOutputField (action output)
  assert.equal(
    await branchOf({ field: 'score', operator: 'gte', valueOutputField: { nodeId: 'risk-check', path: 'limit' } },
      { risk: () => ({ limit: 5 }) }, { score: 6 }),
    'passed');
  assert.equal(
    await branchOf({ field: 'score', operator: 'gte', valueOutputField: { nodeId: 'risk-check', path: 'limit' } },
      { risk: () => ({ limit: 5 }) }, { score: 4 }),
    'failed');
  // outputField (action output) vs valueField (input)
  assert.equal(
    await branchOf({ outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'lte', valueField: 'cap' },
      { risk: () => ({ score: 3 }) }, { cap: 5 }),
    'passed');
});

test('exists with outputField judges presence of the action output', async () => {
  const present = path => branchOf(
    { outputField: { nodeId: 'risk-check', ...(path ? { path } : {}) }, operator: 'exists' },
    { risk: () => ({ risk: { score: 80 } }) });
  assert.equal(await present('risk.score'), 'passed');
  assert.equal(await present('risk.missing'), 'failed');
  assert.equal(await present('risk.score.deep'), 'failed');
  assert.equal(await present(null), 'passed'); // whole return value present
});

test('successfully saved null, empty string, 0, false and undefined all count as present', async () => {
  for (const value of [null, '', 0, false, undefined]) {
    const result = await executeWorkflowAsync(
      outputConditionWorkflow({ outputField: { nodeId: 'risk-check' }, operator: 'exists' }),
      {}, { risk: () => value });
    assert.equal(result.result, 'passed', `exists should pass for ${String(value)}`);
  }
  // eq against a null output
  const eqNull = await executeWorkflowAsync(
    outputConditionWorkflow({ outputField: { nodeId: 'risk-check' }, operator: 'eq', value: null }),
    {}, { risk: () => null });
  assert.equal(eqNull.result, 'passed');
});

test('a path walking into an array or non-object parent is missing', async () => {
  assert.equal(
    await branchOf({ outputField: { nodeId: 'risk-check', path: 'items.0' }, operator: 'exists' },
      { risk: () => ({ items: [1, 2, 3] }) }),
    'failed');
  assert.equal(
    await branchOf({ outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 0 },
      { risk: () => 'a string' }),
    'failed');
  assert.equal(
    await branchOf({ outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 0 },
      { risk: () => null }),
    'failed');
});

test('an action that has not run is missing: references never activate or wait', async () => {
  const workflow = {
    id: 'not-run', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 80,
      }, then: 'pass', else: 'risk-check' },
      { id: 'risk-check', type: 'action', operation: 'risk', next: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, {}, { risk: () => ({ score: 90 }) });
  // risk-check had not run when check evaluated, so the output was missing and
  // the comparison fell through to the else branch.
  assert.equal(result.result, 'failed');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'check', 'risk-check', 'fail']);
});

test('a condition declared before its referenced action does not wait for it', async () => {
  const workflow = {
    id: 'order', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['check', 'risk-check'] },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 80,
      }, then: 'pass', else: 'fail' },
      { id: 'risk-check', type: 'action', operation: 'risk', next: 'wrap' },
      { id: 'pass', type: 'action', message: 'passed', next: 'wrap' },
      { id: 'fail', type: 'action', message: 'failed', next: 'wrap' },
      { id: 'wrap', type: 'end', result: 'done' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, {}, { risk: () => ({ score: 90 }) });
  assert.equal(result.result, 'done');
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'check', 'risk-check', 'fail', 'wrap']);
});

test('an unreferenced-by-edge action is never activated by a reference', async () => {
  let called = 0;
  const workflow = {
    id: 'unreached', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'ghost', path: 'score' }, operator: 'gte', value: 80,
      }, then: 'pass', else: 'fail' },
      { id: 'ghost', type: 'action', operation: 'risk', next: 'done' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, {}, { risk: () => { called += 1; return { score: 90 }; } });
  assert.equal(result.result, 'failed');
  assert.equal(called, 0);
  assert.ok(!result.trace.map(n => n.nodeId).includes('ghost'));
});

test('short-circuited children with bad output references do not error', async () => {
  const condition = { all: [
    { field: 'a', operator: 'gte', value: 5 }, // false: all stops here
    { outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 0 },
  ] };
  const result = await executeWorkflowAsync(
    outputConditionWorkflow(condition), { a: 1 }, { risk: () => ({ score: 'not-a-number' }) });
  assert.equal(result.result, 'failed');

  const anyCondition = { any: [
    { field: 'a', operator: 'gte', value: 0 }, // true: any stops here
    { outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 0 },
  ] };
  const anyResult = await executeWorkflowAsync(
    outputConditionWorkflow(anyCondition), { a: 1 }, { risk: () => ({ score: 'not-a-number' }) });
  assert.equal(anyResult.result, 'passed');
});

test('a numeric comparison on an unconvertible output is invalid_condition', async () => {
  const result = await executeWorkflowAsync(
    outputConditionWorkflow({ outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 0 }),
    {}, { risk: () => ({ score: 'not-a-number' }) });
  assert.equal(result.status, 'invalid_condition');
  assert.match(result.error, /condition node check at \$/);
  assert.match(result.error, /outputField/);
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'risk-check', 'check']);

  const rightBad = await executeWorkflowAsync(
    outputConditionWorkflow({ field: 'score', operator: 'lte', valueOutputField: { nodeId: 'risk-check', path: 'limit' } }),
    { score: 1 }, { risk: () => ({ limit: {} }) });
  assert.equal(rightBad.status, 'invalid_condition');
  assert.match(rightBad.error, /valueOutputField/);
});

test('invalid_condition on an output numeric comparison compensates earlier successful actions', async () => {
  const compensated = [];
  const workflow = {
    id: 'comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'charge' },
      { id: 'charge', type: 'action', operation: 'charge', compensation: { operation: 'refund' }, next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'charge', path: 'amount' }, operator: 'gte', value: 0,
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, {}, {
    charge: () => ({ amount: 'not-a-number' }),
    refund: (input, output, stored) => { compensated.push(stored); },
  });
  assert.equal(result.status, 'invalid_condition');
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(compensated, [{ amount: 'not-a-number' }]);
  assert.deepEqual(result.trace.map(n => n.nodeId), ['start', 'charge', 'check']);
});

test('the synchronous entry reads message action outputs', () => {
  const passed = executeWorkflow(
    outputConditionWorkflow({ outputField: { nodeId: 'risk-check' }, operator: 'eq', value: 'hello' }, { sync: true }),
    {});
  assert.equal(passed.result, 'passed');

  // A message action output is a string; a path into it is missing.
  const failed = executeWorkflow(
    outputConditionWorkflow({ outputField: { nodeId: 'risk-check', path: 'score' }, operator: 'gte', value: 0 }, { sync: true }),
    {});
  assert.equal(failed.result, 'failed');
});

test('node ids are matched as whole strings: dots are not path separators', async () => {
  const workflow = {
    id: 'dots', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'risk.check' },
      { id: 'risk.check', type: 'action', operation: 'risk', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'risk.check', path: 'score' }, operator: 'gte', value: 80,
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, {}, { risk: () => ({ score: 80 }) });
  assert.equal(result.result, 'passed');
});

test('rejects malformed output references and source conflicts before execution', () => {
  const invalid = [
    // outputField shape
    [{ outputField: null, operator: 'gte', value: 1 }, /output reference must be a non-array object/],
    [{ outputField: [], operator: 'gte', value: 1 }, /output reference must be a non-array object/],
    [{ outputField: 'risk-check', operator: 'gte', value: 1 }, /output reference must be a non-array object/],
    [{ outputField: {}, operator: 'gte', value: 1 }, /nodeId must be a non-empty string/],
    [{ outputField: { nodeId: 5 }, operator: 'gte', value: 1 }, /nodeId must be a non-empty string/],
    [{ outputField: { nodeId: '' }, operator: 'gte', value: 1 }, /nodeId must be a non-empty string/],
    [{ outputField: { nodeId: 'ghost' }, operator: 'gte', value: 1 }, /does not name a node/],
    [{ outputField: { nodeId: 'start' }, operator: 'gte', value: 1 }, /must name an action node/],
    [{ outputField: { nodeId: 'check' }, operator: 'gte', value: 1 }, /must name an action node/],
    [{ outputField: { nodeId: 'pass' }, operator: 'gte', value: 1 }, /must name an action node/],
    [{ outputField: { nodeId: 'risk-check', path: '' }, operator: 'gte', value: 1 }, /path must be a non-empty string/],
    [{ outputField: { nodeId: 'risk-check', path: 'a..b' }, operator: 'gte', value: 1 }, /empty segments/],
    [{ outputField: { nodeId: 'risk-check', path: '__proto__' }, operator: 'gte', value: 1 }, /__proto__/],
    [{ outputField: { nodeId: 'risk-check', path: 'a.prototype' }, operator: 'gte', value: 1 }, /prototype/],
    [{ outputField: { nodeId: 'risk-check', path: 'constructor.x' }, operator: 'gte', value: 1 }, /constructor/],
    // left source conflict
    [{ field: 'a', outputField: { nodeId: 'risk-check' }, operator: 'gte', value: 1 }, /exactly one of field or outputField/],
    // right source conflicts
    [{ outputField: { nodeId: 'risk-check' }, operator: 'gte', value: 1, valueField: 'a' }, /exactly one of value or valueField/],
    [{ outputField: { nodeId: 'risk-check' }, operator: 'gte', value: 1, valueOutputField: { nodeId: 'risk-check' } }, /exactly one of value or valueField/],
    [{ outputField: { nodeId: 'risk-check' }, operator: 'gte', valueField: 'a', valueOutputField: { nodeId: 'risk-check' } }, /exactly one of value or valueField/],
    // exists rejects any right side
    [{ outputField: { nodeId: 'risk-check' }, operator: 'exists', value: 1 }, /exists only takes field and operator/],
    [{ outputField: { nodeId: 'risk-check' }, operator: 'exists', valueField: 'a' }, /exists only takes field and operator/],
    [{ outputField: { nodeId: 'risk-check' }, operator: 'exists', valueOutputField: { nodeId: 'risk-check' } }, /exists only takes field and operator/],
    // compound conditions cannot mix comparison keys
    [{ all: [{ outputField: { nodeId: 'risk-check' }, operator: 'gte', value: 1 }], outputField: { nodeId: 'risk-check' } }, /must not mix in/],
    // valueOutputField shape
    [{ field: 'a', operator: 'gte', valueOutputField: null }, /output reference must be a non-array object/],
    [{ field: 'a', operator: 'gte', valueOutputField: { nodeId: 'ghost' } }, /does not name a node/],
    [{ field: 'a', operator: 'gte', valueOutputField: { nodeId: 'start' } }, /must name an action node/],
    [{ field: 'a', operator: 'gte', valueOutputField: { nodeId: 'risk-check', path: 'a..b' } }, /empty segments/],
  ];
  for (const [condition, matcher] of invalid) {
    assert.throws(() => validateWorkflow(outputConditionWorkflow(condition)), matcher);
  }
});

test('definition errors inside nested conditions report the child position', () => {
  const condition = { all: [
    { field: 'a', operator: 'gte', value: 0 },
    { not: { outputField: { nodeId: 'ghost' }, operator: 'gte', value: 0 } },
  ] };
  assert.throws(
    () => validateWorkflow(outputConditionWorkflow(condition)),
    error => /condition node check at \$\.all\[1\]\.not/.test(error.message)
      && /does not name a node/.test(error.message));
});

test('output references on untaken and unreachable branches are still validated', async () => {
  const workflow = {
    id: 'untaken', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'route', operator: 'eq', value: 'a' }, then: 'a', else: 'b' },
      { id: 'a', type: 'condition', condition: { outputField: { nodeId: 'missing-action' }, operator: 'gte', value: 1 }, then: 'end', else: 'end' },
      { id: 'b', type: 'end', result: 'b' },
      { id: 'end', type: 'end', result: 'end' },
    ],
  };
  await assert.rejects(() => executeWorkflowAsync(workflow, { route: 'b' }, {}), /does not name a node/);
});

test('references do not add dependencies', async () => {
  const workflow = {
    id: 'deps', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['check', 'slow'] },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'slow', path: 'score' }, operator: 'gte', value: 80,
      }, then: 'pass', else: 'fail' },
      { id: 'slow', type: 'action', operation: 'slow', next: 'wrap' },
      { id: 'pass', type: 'action', message: 'passed', next: 'wrap' },
      { id: 'fail', type: 'action', message: 'failed', next: 'wrap' },
      { id: 'wrap', type: 'end', result: 'done' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, {}, { slow: () => ({ score: 90 }) });
  assert.equal(result.status, 'completed');
  // check has no dependency on slow, so it is eligible before slow completes;
  // the reference itself never gates scheduling.
  const trace = result.trace.map(n => n.nodeId);
  assert.ok(trace.indexOf('check') < trace.indexOf('slow'));
  // check ran first and saw no output, so it took the else branch.
  assert.ok(trace.indexOf('fail') !== -1);
});
