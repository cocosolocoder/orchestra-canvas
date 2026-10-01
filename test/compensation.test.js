import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function linearWorkflow(actionProps = {}) {
  return {
    id: 'ops',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'work' },
      { id: 'work', type: 'action', ...actionProps, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

// Two business actions succeed, then a third fails: compensations run in
// reverse success order, each exactly once.
test('compensates successful actions in reverse success order when a later action fails', async () => {
  const calls = [];
  const workflow = {
    id: 'basic', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'compB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a-result',
    opB: () => 'b-result',
    opC: () => { throw new Error('boom'); },
    compA: () => { calls.push('compA'); return 'a-compensated'; },
    compB: () => { calls.push('compB'); return 'b-compensated'; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(calls, ['compB', 'compA']);
  assert.deepEqual(execution.context.output, { a: 'a-result', b: 'b-result' });
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b', 'c']);
  assert.deepEqual(execution.actionAttempts.map(r => r.nodeId), ['a', 'b', 'c']);
  assert.deepEqual(execution.compensationAttempts, [
    { nodeId: 'b', operation: 'compB', attempt: 1, ok: true, error: null, nextDelayMs: 0, value: 'b-compensated' },
    { nodeId: 'a', operation: 'compA', attempt: 1, ok: true, error: null, nextDelayMs: 0, value: 'a-compensated' },
  ]);
});

test('compensation receives the input, prior outputs, return value, node id and attempt number', async () => {
  const seen = [];
  const workflow = {
    id: 'args', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'compB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  await executeWorkflowAsync(workflow, { amount: 5 }, {
    opA: () => 'a-result',
    opB: () => 'b-result',
    opC: () => { throw new Error('boom'); },
    compA: (input, output, result, nodeId, attempt) => {
      seen.push({ who: 'A', input: structuredClone(input), output: structuredClone(output), result, nodeId, attempt });
    },
    compB: (input, output, result, nodeId, attempt) => {
      seen.push({ who: 'B', input: structuredClone(input), output: structuredClone(output), result, nodeId, attempt });
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].who, 'B');
  assert.deepEqual(seen[0].input, { amount: 5 });
  assert.deepEqual(seen[0].output, { prep: 'prepared', a: 'a-result' });
  assert.equal(seen[0].result, 'b-result');
  assert.equal(seen[0].nodeId, 'b');
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[1].who, 'A');
  assert.deepEqual(seen[1].output, { prep: 'prepared' });
  assert.equal(seen[1].result, 'a-result');
  assert.equal(seen[1].nodeId, 'a');
});

test('compensation sees the input as it was at success time, before later form defaults', async () => {
  const seen = [];
  const workflow = {
    id: 'snapshot', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'f' },
      { id: 'f', type: 'form', next: 'b', schema: { fields: [
        { path: 'added', type: 'string', default: 'later' },
      ] } },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { x: 1 }, {
    opA: () => 'a-result',
    opB: () => { throw new Error('boom'); },
    compA: input => { seen.push(structuredClone(input)); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.deepEqual(seen[0], { x: 1 });
  assert.deepEqual(execution.context.input, { x: 1, added: 'later' });
});

test('mutations of compensation arguments never leak into records or later attempts', async () => {
  const seen = [];
  const workflow = {
    id: 'mutate', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { nested: { v: 1 } }, {
    opA: () => ({ nested: { w: 2 } }),
    opB: () => { throw new Error('boom'); },
    compA: (input, output, result, nodeId, attempt) => {
      seen.push({ attempt, input: structuredClone(input), output: structuredClone(output), result: structuredClone(result) });
      input.nested.v = 999;
      input.added = true;
      output.a = 'tampered';
      output.newKey = true;
      result.nested.w = 999;
      result.added = true;
      if (attempt === 1) throw new Error('once');
    },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');
  assert.equal(seen.length, 2);
  // The second attempt sees the pristine snapshots, not the first attempt's
  // mutations.
  assert.deepEqual(seen[1].input, { nested: { v: 1 } });
  assert.deepEqual(seen[1].output, {});
  assert.deepEqual(seen[1].result, { nested: { w: 2 } });
  // The stored success output and run input are untouched.
  assert.deepEqual(execution.context.output.a, { nested: { w: 2 } });
  assert.deepEqual(execution.context.input, { nested: { v: 1 } });
});

test('a compensation returning a Promise is awaited', async () => {
  const workflow = {
    id: 'async', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: async () => { await sleep(5); return 'compensated'; },
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.equal(execution.compensationAttempts[0].value, 'compensated');
});

test('a compensation return value that cannot be structured-cloned fails the attempt', async () => {
  const workflow = {
    id: 'uncloneable', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: () => ({ weird: () => 1 }),
  });
  assert.equal(execution.compensationStatus, 'failed');
  assert.equal(execution.compensationAttempts[0].ok, false);
  assert.match(execution.compensationAttempts[0].error, /structured-cloned/);
  assert.equal(execution.compensationAttempts[0].value, null);
});

test('compensation retries with its own settings and records each attempt', async () => {
  const workflow = {
    id: 'retry', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA', retry: { attempts: 4, initialDelayMs: 20, backoffFactor: 2, maxDelayMs: 60 } }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: () => { throw new Error('comp-fail'); },
  });
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.attempt, r.ok, r.nextDelayMs]), [
    [1, false, 20], [2, false, 40], [3, false, 60], [4, false, 0],
  ]);
  assert.deepEqual(execution.compensationAttempts.map(r => r.error), ['comp-fail', 'comp-fail', 'comp-fail', 'comp-fail']);
});

test('a compensation that exhausts retries does not stop earlier actions from being compensated', async () => {
  const calls = [];
  const workflow = {
    id: 'continue', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'compB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => 'b',
    opC: () => { throw new Error('boom'); },
    compA: () => { calls.push('compA'); },
    compB: () => { calls.push('compB'); throw new Error('no'); },
  });
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(calls, ['compB', 'compA']);
  assert.equal(execution.compensationAttempts.length, 2);
});

test('a completed run never calls compensation and reports not_needed', async () => {
  const calls = [];
  const workflow = {
    id: 'completed', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    compA: () => { calls.push('compA'); },
  });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
  assert.deepEqual(calls, []);
});

test('a failed run with no compensation configured reports not_needed', async () => {
  const workflow = {
    id: 'none', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
});

test('a form validation failure triggers compensation of successful actions', async () => {
  const calls = [];
  const workflow = {
    id: 'form', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'f' },
      { id: 'f', type: 'form', next: 'done', schema: { fields: [
        { path: 'required', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    compA: () => { calls.push('compA'); },
  });
  assert.equal(execution.status, 'invalid_input');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(calls, ['compA']);
  assert.equal(execution.context.output.a, 'a');
});

test('a condition evaluation failure triggers compensation', async () => {
  const calls = [];
  const workflow = {
    id: 'cond', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'x', operator: 'gte', value: 0 }, then: 'done', else: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { x: {} }, {
    opA: () => 'a',
    compA: () => { calls.push('compA'); },
  });
  assert.equal(execution.status, 'invalid_condition');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(calls, ['compA']);
});

test('a blocked run triggers compensation of successful actions', async () => {
  const calls = [];
  const workflow = {
    id: 'blocked', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'vip', operator: 'eq', value: true }, then: 'priority', else: 'standard' },
      { id: 'priority', type: 'action', operation: 'opP', compensation: { operation: 'compP' }, next: 'wrap' },
      { id: 'standard', type: 'action', message: 'standard', next: 'wrap' },
      { id: 'wrap', type: 'action', dependsOn: ['standard', 'priority'], next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { vip: true }, {
    opP: () => 'p',
    compP: () => { calls.push('compP'); },
  });
  assert.equal(execution.status, 'blocked');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(calls, ['compP']);
  assert.equal(execution.context.output.priority, 'p');
});

test('reaching an end node first does not prevent compensation when a later branch fails', async () => {
  const calls = [];
  const workflow = {
    id: 'early-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'a'] },
      { id: 'finish', type: 'end', result: 'early' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: () => { calls.push('compA'); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(calls, ['compA']);
});

test('an action that exhausts retries is not compensated', async () => {
  const calls = [];
  const workflow = {
    id: 'failed', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => { throw new Error('boom'); },
    compA: () => { calls.push('compA'); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(calls, []);
});

test('message actions are not compensated but their outputs are visible to later compensation', async () => {
  const seen = [];
  const workflow = {
    id: 'message', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'm' },
      { id: 'm', type: 'action', message: 'legacy', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: (input, output, result) => { seen.push({ output: structuredClone(output), result }); },
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].output, { m: 'legacy' });
  assert.equal(seen[0].result, 'a');
});

test('a shared join node is compensated exactly once', async () => {
  let calls = 0;
  const workflow = {
    id: 'join', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', operation: 'opA', next: 'j' },
      { id: 'b', type: 'action', operation: 'opB', next: 'j' },
      { id: 'j', type: 'action', dependsOn: ['a', 'b'], operation: 'opJ', compensation: { operation: 'compJ' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => 'b',
    opJ: () => 'j',
    opC: () => { throw new Error('boom'); },
    compJ: () => { calls += 1; },
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.equal(calls, 1);
  assert.deepEqual(execution.compensationAttempts.map(r => r.nodeId), ['j']);
});

test('an action that succeeds after retries is compensated exactly once', async () => {
  let actionCalls = 0;
  let compCalls = 0;
  const workflow = {
    id: 'retry-success', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        compensation: { operation: 'compA' }, next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => { actionCalls += 1; if (actionCalls < 3) throw new Error('once'); return 'a'; },
    opB: () => { throw new Error('boom'); },
    compA: () => { compCalls += 1; },
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.equal(actionCalls, 3);
  assert.equal(compCalls, 1);
  assert.deepEqual(execution.compensationAttempts.map(r => r.nodeId), ['a']);
});

test('compensation attempt numbers start at 1 for each compensated action', async () => {
  const seen = [];
  const workflow = {
    id: 'numbering', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'compA', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, next: 'b',
      },
      {
        id: 'b', type: 'action', operation: 'opB',
        compensation: { operation: 'compB', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, next: 'c',
      },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => 'b',
    opC: () => { throw new Error('boom'); },
    compA: (input, output, result, nodeId, attempt) => { seen.push(['A', attempt]); if (attempt === 1) throw new Error('x'); },
    compB: (input, output, result, nodeId, attempt) => { seen.push(['B', attempt]); if (attempt === 1) throw new Error('x'); },
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(seen, [['B', 1], ['B', 2], ['A', 1], ['A', 2]]);
});

test('compensation uses its own retry waits, independent of the action retry', async () => {
  const workflow = {
    id: 'own-retry', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        compensation: { operation: 'compA', retry: { attempts: 3, initialDelayMs: 20, backoffFactor: 1, maxDelayMs: 20 } }, next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: () => { throw new Error('fail'); },
  });
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.attempt, r.nextDelayMs]), [
    [1, 20], [2, 20], [3, 0],
  ]);
});

test('compensation records stay separate from the node trace and action attempt records', async () => {
  const workflow = {
    id: 'separate', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: () => 'compensated',
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b']);
  assert.deepEqual(execution.actionAttempts.map(r => r.nodeId), ['a', 'b']);
  assert.deepEqual(execution.compensationAttempts.map(r => r.nodeId), ['a']);
  assert.equal(execution.compensationAttempts[0].operation, 'compA');
  assert.equal(execution.compensationAttempts[0].value, 'compensated');
});

test('the compensation success value is independent of the object the implementation keeps holding', async () => {
  const workflow = {
    id: 'held', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const held = { total: 1 };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'a',
    opB: () => { throw new Error('boom'); },
    compA: () => held,
  });
  held.total = 42;
  held.mutated = true;
  assert.deepEqual(execution.compensationAttempts[0].value, { total: 1 });
});

test('rejects malformed compensation definitions before execution', () => {
  const badDefinitions = [
    [{ operation: 'charge', compensation: null }, /compensation must be an object/],
    [{ operation: 'charge', compensation: 'nope' }, /compensation must be an object/],
    [{ operation: 'charge', compensation: {} }, /compensation\.operation must be a non-empty string/],
    [{ operation: 'charge', compensation: { operation: '' } }, /compensation\.operation must be a non-empty string/],
    [{ operation: 'charge', compensation: { operation: '   ' } }, /compensation\.operation must be a non-empty string/],
    [{ operation: 'charge', compensation: { operation: 7 } }, /compensation\.operation must be a non-empty string/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: null } }, /compensation\.retry must be an object/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: {} } }, /compensation\.retry must define all of/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } } }, /compensation\.retry\.attempts/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: { attempts: 11, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } } }, /compensation\.retry\.attempts/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: { attempts: 1, initialDelayMs: -1, backoffFactor: 1, maxDelayMs: 0 } } }, /compensation\.retry\.initialDelayMs/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: { attempts: 1, initialDelayMs: 60001, backoffFactor: 1, maxDelayMs: 60001 } } }, /compensation\.retry\.initialDelayMs/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: -1 } } }, /compensation\.retry\.maxDelayMs/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 4.5, maxDelayMs: 0 } } }, /compensation\.retry\.backoffFactor/],
    [{ operation: 'charge', compensation: { operation: 'comp', retry: { attempts: 1, initialDelayMs: 10, backoffFactor: 1, maxDelayMs: 5 } } }, /compensation\.retry\.maxDelayMs must not be less than/],
  ];
  for (const [actionProps, matcher] of badDefinitions) {
    const workflow = linearWorkflow(actionProps);
    assert.throws(() => validateWorkflow(workflow), matcher);
  }
});

test('rejects compensation declared on a message action', () => {
  const workflow = {
    id: 'msg', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', message: 'legacy', compensation: { operation: 'comp' }, next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(workflow), /compensation is only allowed on an action that names an operation/);
});

test('compensation implementations are checked for all actions including untaken branches and unreachable nodes', async () => {
  const workflow = {
    id: 'dormant', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'route', operator: 'eq', value: 'a' }, then: 'a', else: 'b' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'compA' }, next: 'end' },
      { id: 'b', type: 'end', result: 'b' },
      { id: 'ghost', type: 'action', operation: 'opGhost', compensation: { operation: 'compGhost' }, next: 'end' },
      { id: 'end', type: 'end', result: 'end' },
    ],
  };
  let called = 0;
  const ops = {
    opA: () => 'a',
    compA: () => { called += 1; },
    opGhost: () => 'ghost',
    compGhost: () => { called += 10; },
  };
  // compA sits on the untaken branch and compGhost is unreachable: both
  // compensation names are still checked before the first node runs.
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'b' }, { opA: ops.opA, compA: ops.compA, opGhost: ops.opGhost }),
    /action node ghost.*compensation operation "compGhost"/
  );
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'b' }, { opA: ops.opA, opGhost: ops.opGhost, compGhost: ops.compGhost }),
    /action node a.*compensation operation "compA"/
  );
  assert.equal(called, 0);
});

test('validation failures never invoke a compensation', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    compensation: { operation: 'refund', retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
  });
  let called = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      charge: () => { called += 1; throw new Error('no'); },
      refund: () => { called += 10; },
    }),
    /compensation\.retry\.attempts/
  );
  assert.equal(called, 0);
});
