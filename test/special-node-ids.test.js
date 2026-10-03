import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow as validate } from '../src/engine.js';

// A node id of "__proto__" is a legal identifier; its successful result must
// be stored under that exact key as an own enumerable property and be usable
// from conditions, just like any ordinary node id.

function protoScoreWorkflow(condition) {
  return {
    id: 'proto-id', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'score', next: 'check' },
      { id: 'check', type: 'condition', condition, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
}

test('__proto__ action result is an own enumerable, JSON-serializable output key', async () => {
  const workflow = protoScoreWorkflow({
    outputField: { nodeId: '__proto__', path: 'score' }, operator: 'gte', value: 80,
  });
  const run = await executeWorkflowAsync(workflow, {}, { score: () => ({ score: 80 }) });
  assert.equal(run.status, 'completed');
  assert.equal(run.result, 'passed');

  const output = run.context.output;
  assert.ok(Object.hasOwn(output, '__proto__'));
  assert.deepEqual(output['__proto__'], { score: 80 });
  // The result's internal fields belong to that result, never to another slot.
  assert.equal(output.score, undefined);
  assert.deepEqual(Object.keys(output), ['__proto__']);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), JSON.parse('{"__proto__":{"score":80}}'));
});

test('a score below the threshold takes the other branch', async () => {
  const workflow = protoScoreWorkflow({
    outputField: { nodeId: '__proto__', path: 'score' }, operator: 'gte', value: 80,
  });
  const run = await executeWorkflowAsync(workflow, {}, { score: () => ({ score: 79 }) });
  assert.equal(run.result, 'failed');
});

test('conditions may read the whole result or compare against valueOutputField', async () => {
  // Whole-result exists.
  const exists = protoScoreWorkflow({
    outputField: { nodeId: '__proto__' }, operator: 'exists',
  });
  assert.equal(
    (await executeWorkflowAsync(exists, {}, { score: () => ({ score: 80 }) })).result,
    'passed');

  // valueOutputField on the right side reads a special-id node like any other.
  const workflow = {
    id: 'right-side', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'score', next: 'limit' },
      { id: 'limit', type: 'action', operation: 'limit', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'limit' }, operator: 'gte',
        valueOutputField: { nodeId: '__proto__', path: 'score' },
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    score: () => ({ score: 80 }), limit: () => 80,
  });
  assert.equal(run.result, 'passed');
});

test('dots in a node id are matched as the whole string', async () => {
  const workflow = {
    id: 'dotted-id', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a.b.c' },
      { id: 'a.b.c', type: 'action', operation: 'dotted', next: 'check' },
      // A node id containing dots is a single key, not a path: referencing
      // "a" must fail validation even though "a.b.c" exists.
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'a.b.c' }, operator: 'eq', value: 'x',
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { dotted: () => 'x' });
  assert.equal(run.result, 'passed');
  assert.deepEqual(run.context.output['a.b.c'], 'x');

  const bad = {
    id: 'dotted-bad', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a.b.c' },
      { id: 'a.b.c', type: 'action', operation: 'dotted', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'a' }, operator: 'exists',
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  await assert.rejects(() => executeWorkflowAsync(bad, {}, { dotted: () => 'x' }),
    /does not name a node/);
});

test('constructor is also usable as a node id', async () => {
  const workflow = {
    id: 'ctor-id', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'constructor' },
      { id: 'constructor', type: 'action', operation: 'build', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: 'constructor', path: 'v' }, operator: 'gte', value: 1,
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { build: () => ({ v: 1 }) });
  assert.equal(run.result, 'passed');
  assert.ok(Object.hasOwn(run.context.output, 'constructor'));
  assert.deepEqual(run.context.output.constructor, { v: 1 });
});

test('danger-segment restrictions on input and result paths are unchanged', () => {
  const make = condition => ({
    id: 'forbidden-paths', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'score', next: 'check' },
      { id: 'check', type: 'condition', condition, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  });
  assert.throws(
    () => validate(make({ field: '__proto__', operator: 'exists' })),
    /__proto__/);
  assert.throws(
    () => validate(make({
      outputField: { nodeId: '__proto__', path: 'constructor.x' }, operator: 'gte', value: 1,
    })),
    /constructor/);
});

test('falsy successful results (null, "", 0, false, undefined) still count as present', async () => {
  const workflow = protoScoreWorkflow({
    outputField: { nodeId: '__proto__' }, operator: 'exists',
  });
  for (const value of [null, '', 0, false, undefined]) {
    const run = await executeWorkflowAsync(workflow, {}, { score: () => value });
    assert.equal(run.result, 'passed', `value ${String(value)} must be present`);
    assert.ok(Object.hasOwn(run.context.output, '__proto__'));
  }
});

test('an undefined result stays an own key while JSON omits it, per the usual rule', async () => {
  const workflow = {
    id: 'undef-json', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'v', next: 'end' },
      { id: 'end', type: 'end' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { v: () => undefined });
  assert.ok(Object.hasOwn(run.context.output, '__proto__'));
  assert.equal(run.context.output['__proto__'], undefined);
  assert.equal(JSON.stringify(run.context.output), '{}');
});

test('message actions named __proto__ save in both sync and async entries', async () => {
  const workflow = {
    id: 'message-proto', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', message: 'm-result', next: 'end' },
      { id: 'end', type: 'end' },
    ],
  };
  const sync = executeWorkflow(workflow, {});
  assert.equal(sync.context.output['__proto__'], 'm-result');
  assert.ok(Object.hasOwn(sync.context.output, '__proto__'));
  assert.deepEqual(Object.keys(sync.context.output), ['__proto__']);

  const asynced = await executeWorkflowAsync(workflow, {});
  assert.equal(asynced.context.output['__proto__'], 'm-result');
  assert.ok(Object.hasOwn(asynced.context.output, '__proto__'));
});

test('a failed special-id action produces no output and cannot satisfy a reference', async () => {
  const workflow = {
    id: 'failed-proto', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'boom', next: 'check' },
      { id: 'check', type: 'condition', condition: {
        outputField: { nodeId: '__proto__' }, operator: 'exists',
      }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, { boom: () => { throw new Error('boom'); } });
  assert.equal(run.status, 'action_failed');
  assert.ok(!Object.hasOwn(run.context.output, '__proto__'));
});

test('later business actions receive special-id results in their output copy', async () => {
  let received;
  const workflow = {
    id: 'copy-proto', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'first', next: 'second' },
      { id: 'second', type: 'action', operation: 'second', next: 'end' },
      { id: 'end', type: 'end' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    first: () => ({ score: 80 }),
    second: (_input, output) => {
      received = output;
      assert.deepEqual(output['__proto__'], { score: 80 });
      assert.ok(Object.hasOwn(output, '__proto__'));
      return 'done';
    },
  });
  assert.equal(run.status, 'completed');
  assert.ok(received);
});

test('mutating a business output copy never rewrites the stored run output', async () => {
  const workflow = {
    id: 'isolate-proto', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'first', next: 'second' },
      { id: 'second', type: 'action', operation: 'second', next: 'end' },
      { id: 'end', type: 'end' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    first: () => ({ score: 80 }),
    second: (_input, output) => {
      output['__proto__'] = { replaced: true };
      output['__proto__'].score = 1;
      output.injected = 'x';
      return 'done';
    },
  });
  assert.deepEqual(run.context.output['__proto__'], { score: 80 });
  assert.equal(run.context.output.injected, undefined);
});

test('compensation sees earlier special-id outputs but not the failing action own result', async () => {
  const captured = {};
  const workflow = {
    id: 'comp-proto', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', operation: 'first',
        compensation: { operation: 'undoFirst' }, next: 'normal' },
      { id: 'normal', type: 'action', operation: 'normal',
        compensation: { operation: 'undoNormal' }, next: 'boom' },
      { id: 'boom', type: 'action', operation: 'boom', next: 'end' },
      { id: 'end', type: 'end' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    first: () => ({ score: 80 }),
    normal: () => 'N',
    boom: () => { throw new Error('boom'); },
    undoNormal: (_input, output, result) => {
      // Snapshot at normal's success: includes the earlier special-id result
      // but not normal's own result. Record a private view before mutating the
      // copy the operation was handed.
      captured.normalOutput = structuredClone(output);
      captured.normalResult = result;
      output['__proto__'] = { tampered: true };
      output.injected = 'x';
      return 'u-normal';
    },
    undoFirst: (_input, output, result) => {
      // Snapshot at first's success predates first's own result.
      captured.firstHasOwn = Object.hasOwn(output, '__proto__');
      captured.firstResult = result;
      return 'u-first';
    },
  });
  assert.equal(run.status, 'action_failed');
  assert.deepEqual(captured.normalOutput['__proto__'], { score: 80 });
  assert.equal(captured.normalOutput.normal, undefined);
  assert.equal(captured.normalResult, 'N');
  assert.equal(captured.firstHasOwn, false);
  assert.deepEqual(captured.firstResult, { score: 80 });
  // Failed terminal state keeps the earlier successful special-id output,
  // untouched by compensation's copy mutation.
  assert.deepEqual(run.context.output['__proto__'], { score: 80 });
});
