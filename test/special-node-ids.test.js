import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync } from '../src/engine.js';

// "__proto__" is a legal node identifier: the id is only ever matched as a
// whole string. A plain `output[id] = value` assignment for that id invokes the
// inherited Object.prototype.__proto__ setter instead of creating an own
// property, so these workflows pin the engine to storing every successful
// action result under its real node id regardless of spelling.

// Builds an object that really owns a "__proto__" data property — an object
// literal with a quoted __proto__ key would hit the same JS setter and set the
// prototype instead.
function objectWithProtoKey(value) {
  const object = {};
  Object.defineProperty(object, '__proto__', {
    value, writable: true, enumerable: true, configurable: true,
  });
  return object;
}

function protoActionWorkflow(actionNode, extraNodes = []) {
  return {
    id: 'special-id',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', ...actionNode, next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { outputField: { nodeId: '__proto__' }, operator: 'eq', value: 'ok' },
        then: 'pass', else: 'fail',
      },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
      ...extraNodes,
    ],
  };
}

test('a __proto__ business action stores its result as an own enumerable property', async () => {
  const workflow = protoActionWorkflow({ operation: 'score' });
  const execution = await executeWorkflowAsync(workflow, {}, { score: () => 'ok' });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'passed');
  assert.equal(Object.hasOwn(execution.context.output, '__proto__'), true);
  assert.deepEqual(Object.keys(execution.context.output), ['__proto__']);
  assert.deepEqual(execution.context.output, objectWithProtoKey('ok'));
  // The result survives JSON serialization under the real node id.
  assert.equal(JSON.stringify(execution.context.output), '{"__proto__":"ok"}');
});

test('a __proto__ message action stores its result in both entries', async () => {
  const syncWorkflow = protoActionWorkflow({ message: 'ok' });
  const syncRun = executeWorkflow(syncWorkflow, {});
  assert.equal(syncRun.result, 'passed');
  assert.equal(Object.hasOwn(syncRun.context.output, '__proto__'), true);
  assert.equal(JSON.stringify(syncRun.context.output), '{"__proto__":"ok"}');

  const asyncRun = await executeWorkflowAsync(syncWorkflow, {});
  assert.equal(asyncRun.result, 'passed');
  assert.equal(asyncRun.context.output['__proto__'], 'ok');
});

test('inner fields of a __proto__ result belong only to that result', async () => {
  const workflow = protoActionWorkflow({ operation: 'score' });
  const execution = await executeWorkflowAsync(workflow, {}, { score: () => ({ score: 80 }) });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.output['__proto__'], { score: 80 });
  // The stored result never leaks into another node's slot or onto the store.
  assert.equal(execution.context.output.score, undefined);
  assert.equal(Object.getPrototypeOf(execution.context.output), Object.prototype);
  assert.deepEqual(Object.keys(execution.context.output), ['__proto__']);
});

test('conditions read whole result, inner path and valueOutputField for a __proto__ node', async () => {
  const branchOf = async condition => {
    const workflow = {
      id: 'path-reads', entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: '__proto__' },
        { id: '__proto__', type: 'action', operation: 'score', next: 'other' },
        { id: 'other', type: 'action', operation: 'cap', next: 'check' },
        { id: 'check', type: 'condition', condition, then: 'pass', else: 'fail' },
        { id: 'pass', type: 'end', result: 'passed' },
        { id: 'fail', type: 'end', result: 'failed' },
      ],
    };
    const run = await executeWorkflowAsync(workflow, {}, {
      score: () => ({ score: 80 }),
      cap: () => ({ cap: 80 }),
    });
    return run.result;
  };

  // The scenario from the report: score >= 80 takes the satisfied branch.
  assert.equal(
    await branchOf({ outputField: { nodeId: '__proto__', path: 'score' }, operator: 'gte', value: 80 }),
    'passed');
  assert.equal(
    await branchOf({ outputField: { nodeId: '__proto__', path: 'score' }, operator: 'gte', value: 81 }),
    'failed');
  // The whole result is comparable like any node's result.
  assert.equal(
    await branchOf({ outputField: { nodeId: '__proto__' }, operator: 'eq', value: 80 }),
    'failed');
  // The right-hand output reference works the same way.
  assert.equal(
    await branchOf({
      outputField: { nodeId: '__proto__', path: 'score' }, operator: 'gte',
      valueOutputField: { nodeId: 'other', path: 'cap' },
    }),
    'passed');
});

test('a __proto__ node id is matched as a whole string; dots stay literal', async () => {
  const workflow = {
    id: 'dots-and-proto', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__.risk' },
      { id: '__proto__.risk', type: 'action', operation: 'score', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: '__proto__.risk', path: 'score' }, operator: 'gte', value: 80,
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { score: () => ({ score: 80 }) });
  assert.equal(run.result, 'passed');
  assert.deepEqual(Object.keys(run.context.output), ['__proto__.risk']);
});

test('saved null, empty string, 0, false and undefined count as present for a __proto__ node', async () => {
  for (const value of [null, '', 0, false, undefined]) {
    const workflow = protoActionWorkflow({ operation: 'give' });
    workflow.nodes[2].condition = { outputField: { nodeId: '__proto__' }, operator: 'exists' };
    const run = await executeWorkflowAsync(workflow, {}, { give: () => value });
    assert.equal(run.result, 'passed', `exists must pass for ${String(value)}`);
    assert.equal(Object.hasOwn(run.context.output, '__proto__'), true);
  }

  // undefined follows the existing JSON rule (omitted like any undefined
  // property value) while remaining present in the live context.
  const workflow = {
    id: 'undefined-json', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['__proto__', 'plain'] },
      { id: '__proto__', type: 'action', operation: 'give', next: 'join' },
      { id: 'plain', type: 'action', operation: 'other', next: 'join' },
      { id: 'join', type: 'end', result: 'done' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { give: () => undefined, other: () => 'x' });
  assert.equal(Object.hasOwn(run.context.output, '__proto__'), true);
  assert.equal(run.context.output['__proto__'], undefined);
  assert.equal(JSON.stringify(run.context.output), '{"plain":"x"}');
});

test('a failed __proto__ action stores nothing and references stay missing', async () => {
  const workflow = {
    id: 'failed-special', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'give', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: '__proto__' }, operator: 'exists',
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { give: () => { throw new Error('boom'); } });
  assert.equal(run.status, 'action_failed');
  assert.equal(Object.hasOwn(run.context.output, '__proto__'), false);
  assert.deepEqual(Object.keys(run.context.output), []);
  assert.equal(JSON.stringify(run.context.output), '{}');
});

test('a __proto__ result is visible to later business actions and survives output-copy mutation', async () => {
  const workflow = {
    id: 'copy-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'score', next: 'use' },
      { id: 'use', type: 'action', operation: 'consume', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    score: () => ({ score: 80 }),
    consume: (input, output) => {
      assert.equal(Object.hasOwn(output, '__proto__'), true);
      assert.deepEqual(output['__proto__'], { score: 80 });
      output['__proto__'].score = 1;
      output['__proto__'] = 'tampered';
      output.added = true;
      return 'used';
    },
  });
  assert.equal(run.status, 'completed');
  // The stored success result is independent of the per-call clone.
  assert.deepEqual(run.context.output['__proto__'], { score: 80 });
  assert.equal(run.context.output.added, undefined);
  assert.equal(run.context.output.use, 'used');
});

test('compensation receives the __proto__ output captured at the success moment', async () => {
  const seen = [];
  const workflow = {
    id: 'comp-special', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'score',
        compensation: { operation: 'undoScore' }, next: 'later' },
      { id: 'later', type: 'action', operation: 'laterOp', next: 'boom' },
      { id: 'boom', type: 'action', operation: 'boomOp', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    score: () => ({ score: 80 }),
    laterOp: (input, output) => {
      assert.deepEqual(output['__proto__'], { score: 80 });
      return 'later';
    },
    boomOp: () => { throw new Error('boom'); },
    undoScore: (input, output, result) => {
      seen.push({
        input: structuredClone(input), output: structuredClone(output),
        result: structuredClone(result),
      });
    },
  });
  assert.equal(run.status, 'action_failed');
  // The failing terminal keeps the earlier successful outputs...
  assert.deepEqual(run.context.output['__proto__'], { score: 80 });
  assert.equal(run.context.output.later, 'later');
  assert.equal(Object.hasOwn(run.context.output, 'boom'), false);
  // ...and compensation sees the outputs that existed before the original
  // action's own key landed (its own result is the third argument instead).
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].output, {});
  assert.equal(Object.hasOwn(seen[0].output, '__proto__'), false);
  assert.deepEqual(seen[0].result, { score: 80 });
});

test('a later compensable action sees the earlier __proto__ output in its compensation copy', async () => {
  const seen = [];
  const workflow = {
    id: 'comp-chain', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'score',
        compensation: { operation: 'undoScore' }, next: 'later' },
      { id: 'later', type: 'action', operation: 'laterOp',
        compensation: { operation: 'undoLater' }, next: 'boom' },
      { id: 'boom', type: 'action', operation: 'boomOp', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    score: () => ({ score: 80 }),
    laterOp: () => 'later',
    boomOp: () => { throw new Error('boom'); },
    undoLater: (input, output, result) => {
      seen.push({ name: 'later', output: structuredClone(output), result: structuredClone(result) });
      // Mutating the copy must not touch the run's stored outputs.
      output['__proto__'].score = 0;
    },
    undoScore: (input, output, result) => {
      seen.push({ name: 'score', output: structuredClone(output), result: structuredClone(result) });
    },
  });
  assert.equal(run.status, 'action_failed');
  // Most-recent-first: later's snapshot already contains the __proto__ result.
  assert.equal(seen[0].name, 'later');
  assert.equal(Object.hasOwn(seen[0].output, '__proto__'), true);
  assert.deepEqual(seen[0].output['__proto__'], { score: 80 });
  assert.equal(seen[0].output.later, undefined);
  assert.deepEqual(seen[0].result, 'later');
  // The earlier action's snapshot still predates both keys.
  assert.equal(seen[1].name, 'score');
  assert.deepEqual(seen[1].output, {});
  assert.deepEqual(seen[1].result, { score: 80 });
  // Copy isolation: stored results were not mutated.
  assert.deepEqual(run.context.output['__proto__'], { score: 80 });
});

test('constructor and other legal identifiers keep working identically', async () => {
  const workflow = {
    id: 'ctor-id', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'constructor' },
      { id: 'constructor', type: 'action', operation: 'build', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'constructor', path: 'ready' }, operator: 'eq', value: true,
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { build: () => ({ ready: true }) });
  assert.equal(run.result, 'passed');
  assert.deepEqual(run.context.output.constructor, { ready: true });
});

test('dangerous segments stay forbidden in input paths and result paths with special node ids', async () => {
  const workflow = specialPath => ({
    id: 'forbidden-segments', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'score', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: '__proto__', path: specialPath }, operator: 'exists',
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  });
  await assert.rejects(
    () => executeWorkflowAsync(workflow('__proto__'), {}, { score: () => 1 }), /__proto__/);
  await assert.rejects(
    () => executeWorkflowAsync(workflow('constructor.x'), {}, { score: () => 1 }), /constructor/);
});
