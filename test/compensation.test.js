import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// trigger -> a (business, compensable) -> b (business, fails) -> end
function compensableWorkflow(bProps = {}, { compOnA = true, compRetry = undefined } = {}) {
  return {
    id: 'comps',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        ...(compOnA ? { compensation: { operation: 'undoA', ...(compRetry ? { retry: compRetry } : {}) } } : {}),
        next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', ...bProps, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

const failingOpB = () => { throw new Error('b-boom'); };

test('a completed run never invokes compensation', async () => {
  let undoCalls = 0;
  const execution = await executeWorkflowAsync(compensableWorkflow(), {}, {
    opA: () => 'A',
    opB: () => 'B',
    undoA: () => { undoCalls += 1; return 'undone'; },
  });
  assert.equal(execution.status, 'completed');
  assert.equal(undoCalls, 0);
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
});

test('exhausted action retries compensate earlier successful actions in reverse success order', async () => {
  const calls = [];
  const workflow = {
    id: 'chain', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'undoB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: () => 'B',
    opC: failingOpB,
    undoA: () => { calls.push('undoA'); return 'ua'; },
    undoB: () => { calls.push('undoB'); return 'ub'; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  // c never succeeded, so its (absent) compensation never runs; b undoes
  // before a even though a is declared first.
  assert.deepEqual(calls, ['undoB', 'undoA']);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]), [
    ['b', 'undoB', 1, true],
    ['a', 'undoA', 1, true],
  ]);
});

test('the failed action, message actions and untaken branches are never compensated', async () => {
  const calls = [];
  const workflow = {
    id: 'mixed', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'route', operator: 'eq', value: 'x' }, then: 'a', else: 'idle' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'idle', type: 'action', operation: 'opIdle', compensation: { operation: 'undoIdle' }, next: 'b' },
      { id: 'b', type: 'action', message: 'just-a-message', next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', compensation: { operation: 'undoC' }, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { route: 'x' }, {
    opA: () => 'A',
    opIdle: () => 'I',
    opC: failingOpB,
    undoA: () => { calls.push('undoA'); },
    undoIdle: () => { calls.push('undoIdle'); },
    undoC: () => { calls.push('undoC'); },
  });
  assert.equal(execution.status, 'action_failed');
  // Only a succeeded with compensation; c failed, idle was never reached and
  // b is a message action.
  assert.deepEqual(calls, ['undoA']);
});

test('an action that succeeds after retries is scheduled for compensation exactly once', async () => {
  const undone = [];
  const workflow = compensableWorkflow({
    retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  // Replace a's binding: a fails twice then succeeds.
  workflow.nodes[2] = {
    id: 'a', type: 'action', operation: 'opA',
    retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    compensation: { operation: 'undoA' }, next: 'b',
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: (input, output, nodeId, attempt) => {
      if (attempt < 3) throw new Error(`retry ${attempt}`);
      return 'A';
    },
    opB: failingOpB,
    undoA: () => { undone.push('once'); return 'ua'; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.deepEqual(undone, ['once']);
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.attempt]), [['a', 1]]);
});

test('a shared join node is compensated exactly once', async () => {
  let undoJoin = 0;
  const workflow = {
    id: 'join-comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['left', 'right', 'boom'] },
      { id: 'left', type: 'action', operation: 'opLeft', next: 'join' },
      { id: 'right', type: 'action', operation: 'opRight', next: 'join' },
      { id: 'join', type: 'action', dependsOn: ['left', 'right'], operation: 'opJoin', compensation: { operation: 'undoJoin' }, next: 'done' },
      { id: 'boom', type: 'action', operation: 'opBoom', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opLeft: () => 'L',
    opRight: () => 'R',
    opJoin: () => 'J',
    opBoom: failingOpB,
    undoJoin: () => { undoJoin += 1; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(undoJoin, 1);
});

test('reaching end first does not prevent compensation when another branch then fails', async () => {
  const undone = [];
  const workflow = {
    id: 'late-end-comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: 'early' },
      { id: 'work', type: 'action', operation: 'opWork', compensation: { operation: 'undoWork' }, next: 'after' },
      { id: 'after', type: 'action', operation: 'opAfter', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opWork: () => 'W',
    opAfter: failingOpB,
    undoWork: () => { undone.push('undoWork'); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.deepEqual(undone, ['undoWork']);
  assert.equal(execution.compensationStatus, 'completed');
});

test('form validation failure triggers compensation and keeps the invalid_input result', async () => {
  const workflow = {
    id: 'form-comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'needed', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    undoA: () => 'ua',
  });
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.errors, [{ nodeId: 'collect', path: 'needed', code: 'required' }]);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => r.nodeId), ['a']);
});

test('condition evaluation failure triggers compensation', async () => {
  const workflow = {
    id: 'cond-comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'x', operator: 'gte', value: 0 }, then: 'done', else: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { x: {} }, {
    opA: () => 'A',
    undoA: () => 'ua',
  });
  assert.equal(execution.status, 'invalid_condition');
  assert.match(execution.error, /condition node check/);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => r.nodeId), ['a']);
});

test('a blocked run compensates successful actions and keeps blockedNodes', async () => {
  const workflow = {
    id: 'blocked-comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'vip', operator: 'eq', value: true }, then: 'priority', else: 'standard' },
      { id: 'priority', type: 'action', operation: 'priority', compensation: { operation: 'undoPriority' }, next: 'wrap' },
      { id: 'standard', type: 'action', message: 'standard', next: 'wrap' },
      { id: 'wrap', type: 'action', dependsOn: ['standard', 'priority'], next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { vip: true }, {
    priority: () => 'p',
    undoPriority: () => 'up',
  });
  assert.equal(execution.status, 'blocked');
  assert.deepEqual(execution.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation]), [['priority', 'undoPriority']]);
});

test('compensation receives the success-time input, earlier outputs, the return value, node id and 1-based attempt', async () => {
  const seen = [];
  const workflow = {
    id: 'args', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'first-form' },
      { id: 'first-form', type: 'form', next: 'a', schema: { fields: [
        { path: 'early', type: 'string', default: 'before-a' },
      ] } },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'second-form' },
      { id: 'second-form', type: 'form', next: 'b', schema: { fields: [
        { path: 'late', type: 'string', default: 'after-a' },
      ] } },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { amount: 5 }, {
    opA: () => ({ charged: true, id: 'tx-1' }),
    opB: failingOpB,
    undoA: (input, output, result, nodeId, attempt) => {
      seen.push({
        input: structuredClone(input),
        output: structuredClone(output),
        result: structuredClone(result),
        nodeId, attempt,
      });
      return 'refunded';
    },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].input, { amount: 5, early: 'before-a' });
  // Defaults applied by a form after a succeeded are not visible to its
  // compensation; neither is a's own output key or the later b node.
  assert.equal(seen[0].input.late, undefined);
  assert.deepEqual(seen[0].output, { prep: 'prepared' });
  assert.deepEqual(seen[0].result, { charged: true, id: 'tx-1' });
  assert.equal(seen[0].nodeId, 'a');
  assert.equal(seen[0].attempt, 1);
});

test('mutations of compensation argument copies never reach the context, records or later attempts', async () => {
  const workflow = {
    id: 'isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA', retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
        next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const seen = [];
  const execution = await executeWorkflowAsync(workflow, { amount: 10, nested: { v: 1 } }, {
    opA: () => ({ total: 100 }),
    opB: failingOpB,
    undoA: (input, output, result, nodeId, attempt) => {
      seen.push({ input: structuredClone(input), output: structuredClone(output), result: structuredClone(result) });
      input.amount = 0;
      input.nested.v = 0;
      input.added = true;
      output.tampered = true;
      result.total = -1;
      if (attempt < 3) throw new Error(`undo fail ${attempt}`);
      return 'refunded';
    },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');
  // Every attempt saw the pristine snapshots.
  for (const call of seen) {
    assert.deepEqual(call.input, { amount: 10, nested: { v: 1 } });
    assert.deepEqual(call.output, {});
    assert.deepEqual(call.result, { total: 100 });
  }
  // Successful outputs and input survive compensation untouched.
  assert.deepEqual(execution.context.output.a, { total: 100 });
  assert.deepEqual(execution.context.input, { amount: 10, nested: { v: 1 } });
});

test('the stored compensation result is independent of an object the implementation keeps mutating', async () => {
  const workflow = compensableWorkflow();
  const held = { refund: 1 };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: failingOpB,
    undoA: () => held,
  });
  held.refund = 99;
  held.mutated = true;
  assert.deepEqual(execution.compensationAttempts[0].result, { refund: 1 });
});

test('an async compensation resolution is awaited and stored', async () => {
  const workflow = compensableWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: failingOpB,
    undoA: async () => { await sleep(5); return 'later-refund'; },
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.equal(execution.compensationAttempts[0].result, 'later-refund');
});

test('a throw, a rejected promise and an unclonable return all fail the compensation attempt', async () => {
  const base = compensableWorkflow({
    retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  }, { compRetry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } });

  const thrown = await executeWorkflowAsync(structuredClone(base), {}, {
    opA: () => 'A', opB: failingOpB,
    undoA: () => { throw new Error('undo refused'); },
  });
  assert.equal(thrown.compensationStatus, 'failed');
  assert.equal(thrown.compensationAttempts[0].error, 'undo refused');

  const rejected = await executeWorkflowAsync(structuredClone(base), {}, {
    opA: () => 'A', opB: failingOpB,
    undoA: async () => { throw new Error('undo rejected'); },
  });
  assert.equal(rejected.compensationStatus, 'failed');
  assert.equal(rejected.compensationAttempts[0].error, 'undo rejected');

  const unclonable = await executeWorkflowAsync(structuredClone(base), {}, {
    opA: () => 'A', opB: failingOpB,
    undoA: () => ({ weird: () => 1 }),
  });
  assert.equal(unclonable.compensationStatus, 'failed');
  assert.match(unclonable.compensationAttempts[0].error, /structured-cloned/);
});

test('compensation uses its own retry count, delays and backoff and waits serially', async () => {
  const workflow = compensableWorkflow({}, {
    compRetry: { attempts: 4, initialDelayMs: 20, backoffFactor: 2, maxDelayMs: 50 },
  });
  const gaps = [];
  let last = Date.now();
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: failingOpB,
    undoA: () => {
      gaps.push(Date.now() - last);
      last = Date.now();
      throw new Error('fail');
    },
  });
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.attempt, r.ok, r.nextDelayMs]), [
    [1, false, 20], [2, false, 40], [3, false, 50], [4, false, 0],
  ]);
  assert.ok(gaps[0] < 10);
  assert.ok(gaps[1] >= 18);
  assert.ok(gaps[2] >= 38);
  assert.ok(gaps[3] >= 48);
});

test('a compensation that succeeds after retries records every attempt in invocation order', async () => {
  const workflow = compensableWorkflow({}, {
    compRetry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: failingOpB,
    undoA: (input, output, result, nodeId, attempt) => {
      if (attempt < 3) throw new Error(`undo ${attempt}`);
      return { refunded: true };
    },
  });
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.attempt, r.ok, r.result]), [
    [1, false, null], [2, false, null], [3, true, { refunded: true }],
  ]);
  assert.equal(execution.compensationAttempts[0].nextDelayMs, 0);
});

test('after compensation retries are exhausted, earlier actions are still compensated and nothing re-runs', async () => {
  const workflow = {
    id: 'continue', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        compensation: { operation: 'undoA', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
        next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'undoB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const businessCalls = { opA: 0, opB: 0 };
  const undoCalls = { undoA: 0, undoB: 0 };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => { businessCalls.opA += 1; return 'A'; },
    opB: () => { businessCalls.opB += 1; return 'B'; },
    opC: failingOpB,
    undoA: () => { undoCalls.undoA += 1; throw new Error('stuck'); },
    undoB: () => { undoCalls.undoB += 1; return 'ub'; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'failed');
  // b's failure does not stop a's compensation; the original business
  // operations are never invoked again, and neither compensation re-runs.
  assert.deepEqual(undoCalls, { undoA: 2, undoB: 1 });
  assert.deepEqual(businessCalls, { opA: 1, opB: 1 });
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['b', 1, true],
    ['a', 1, false],
    ['a', 2, false],
  ]);
});

test('compensation failure marks the run failed even when other compensations succeed', async () => {
  const workflow = {
    id: 'mixed-comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', compensation: { operation: 'undoB' }, next: 'c' },
      { id: 'c', type: 'action', operation: 'opC', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A', opB: () => 'B', opC: failingOpB,
    undoA: () => 'ua',
    undoB: () => { throw new Error('b stuck'); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'failed');
  // a is still compensated after b's compensation gave up.
  assert.deepEqual(execution.compensationAttempts.map(r => r.nodeId), ['b', 'a']);
});

test('a failure with no successful compensable action reports not_needed', async () => {
  const execution = await executeWorkflowAsync(compensableWorkflow({}, { compOnA: false }), {}, {
    opA: () => 'A',
    opB: failingOpB,
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
});

test('the terminal result keeps status, details, context, trace and action attempts; outputs are not deleted', async () => {
  const workflow = {
    id: 'preserve', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'opA',
        retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        compensation: { operation: 'undoA' }, next: 'b',
      },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, { amount: 3 }, {
    opA: () => 'A',
    opB: failingOpB,
    undoA: () => 'refund',
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'b');
  assert.equal(execution.attempts, 1);
  assert.equal(execution.error, 'b-boom');
  assert.deepEqual(execution.context.input, { amount: 3 });
  assert.equal(execution.context.output.a, 'A');
  assert.equal(execution.context.output.b, undefined);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b']);
  // Compensation never enters the normal trace.
  assert.deepEqual(execution.trace.map(n => n.type), ['trigger', 'action', 'action']);
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, true], ['b', 1, false],
  ]);
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.error, r.nextDelayMs, r.result]), [
    ['a', 'undoA', 1, true, null, 0, 'refund'],
  ]);
});

test('snapshots stay independent across separate runs', async () => {
  const workflow = compensableWorkflow();
  const seen = [];
  const ops = {
    opA: input => ({ saw: structuredClone(input) }),
    opB: failingOpB,
    undoA: (input, output, result) => { seen.push(structuredClone({ input, result })); return 'u'; },
  };
  const first = await executeWorkflowAsync(workflow, { amount: 1 }, ops);
  const second = await executeWorkflowAsync(workflow, { amount: 2 }, ops);
  assert.equal(first.status, 'action_failed');
  assert.equal(second.status, 'action_failed');
  assert.deepEqual(seen[0].input, { amount: 1 });
  assert.deepEqual(seen[0].result, { saw: { amount: 1 } });
  assert.deepEqual(seen[1].input, { amount: 2 });
  assert.deepEqual(seen[1].result, { saw: { amount: 2 } });
});

test('compensation without a retry config is attempted exactly once', async () => {
  let calls = 0;
  const workflow = compensableWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: failingOpB,
    undoA: () => { calls += 1; throw new Error('nope'); },
  });
  assert.equal(calls, 1);
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(r => r.attempt), [1]);
  assert.equal(execution.compensationAttempts[0].nextDelayMs, 0);
});

test('rejects a non-object compensation config', () => {
  for (const compensation of [null, [], 'undo', 42]) {
    const workflow = compensableWorkflow();
    workflow.nodes[2].compensation = compensation;
    assert.throws(() => validateWorkflow(workflow), /action node a: compensation must be an object/);
  }
});

test('rejects compensation declared on a non-business-action node', () => {
  const offenders = [
    { id: 'bad', type: 'trigger', next: 'done' },
    { id: 'bad', type: 'form', next: 'done' },
    { id: 'bad', type: 'condition', condition: { field: 'x', operator: 'exists' }, then: 'done', else: 'done' },
  ];
  for (const offender of offenders) {
    offender.compensation = { operation: 'x' };
    const workflow = {
      id: 'wrong-node', entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'bad' },
        offender,
        { id: 'done', type: 'end', result: 'ok' },
      ],
    };
    assert.throws(
      () => validateWorkflow(workflow),
      /node bad: compensation is only allowed on a business action node/,
    );
  }

  const endWorkflow = {
    id: 'wrong-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'bad' },
      { id: 'bad', type: 'end', result: 'ok', compensation: { operation: 'x' } },
    ],
  };
  assert.throws(
    () => validateWorkflow(endWorkflow),
    /node bad: compensation is only allowed on a business action node/,
  );

  // A legacy message action is an action node but not a business action.
  const messageAction = compensableWorkflow();
  messageAction.nodes[2] = { id: 'a', type: 'action', message: 'm', compensation: { operation: 'undoA' }, next: 'b' };
  assert.throws(() => validateWorkflow(messageAction), /action node a: compensation is only allowed on an action that names an operation/);
});

test('rejects blank or non-string compensation operation names', () => {
  const badNames = ['', '   ', 7, null, undefined];
  for (const operation of badNames) {
    const workflow = compensableWorkflow();
    workflow.nodes[2].compensation = { operation };
    assert.throws(
      () => validateWorkflow(workflow),
      /compensation.operation must be a non-empty string name/,
    );
  }
});

test('rejects invalid compensation retry settings with the node and reason', () => {
  const badRetry = [
    [null, /retry must be an object/],
    [{ attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }, /attempts must be an integer between 1 and 10/],
    [{ attempts: 11, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }, /attempts must be an integer between 1 and 10/],
    [{ attempts: 2, initialDelayMs: -1, backoffFactor: 1, maxDelayMs: 0 }, /initialDelayMs/],
    [{ attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 60001 }, /maxDelayMs/],
    [{ attempts: 2, initialDelayMs: 10, backoffFactor: 5, maxDelayMs: 10 }, /backoffFactor/],
    [{ attempts: 2, initialDelayMs: 20, backoffFactor: 1, maxDelayMs: 10 }, /maxDelayMs must not be less than/],
    [{ attempts: 2, initialDelayMs: 0, backoffFactor: 1 }, /maxDelayMs/],
  ];
  for (const [retry, matcher] of badRetry) {
    const workflow = compensableWorkflow();
    workflow.nodes[2].compensation = { operation: 'undoA', retry };
    assert.throws(() => validateWorkflow(workflow), matcher);
  }

  // A bad compensation config on an unreachable node is still rejected.
  const dormant = {
    id: 'dormant', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      {
        id: 'ghost', type: 'action', operation: 'x',
        compensation: { operation: 'undoX', retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
        next: 'done',
      },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(dormant), /action node ghost/);
});

test('the synchronous entry refuses a workflow declaring compensation before any node runs', () => {
  const workflow = compensableWorkflow();
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => /action node a/.test(error.message) && /executeWorkflowAsync/.test(error.message),
  );
});

test('missing compensation implementations are rejected before the first node runs, invoking nothing', async () => {
  const workflow = compensableWorkflow();
  let businessCalls = 0;
  let undoCalls = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, {
      opA: () => { businessCalls += 1; return 'A'; },
      opB: () => { businessCalls += 1; return 'B'; },
    }),
    error => /action node a/.test(error.message)
      && /compensation operation "undoA"/.test(error.message),
  );
  assert.equal(businessCalls, 0);
  assert.equal(undoCalls, 0);

  // A non-function value is rejected the same way.
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { opA: () => 'A', opB: () => 'B', undoA: 42 }),
    /compensation operation "undoA"/,
  );
});

test('compensation implementation checks cover untaken branches and unreachable nodes', async () => {
  const workflow = {
    id: 'dormant-comp', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'route', operator: 'eq', value: 'a' }, then: 'a', else: 'b' },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'end' },
      { id: 'b', type: 'end', result: 'b' },
      { id: 'ghost', type: 'action', operation: 'opGhost', compensation: { operation: 'undoGhost' }, next: 'end' },
      { id: 'end', type: 'end', result: 'end' },
    ],
  };
  // Branch a is untaken on route=b, and ghost is unreachable: both comp
  // implementations must still be present.
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'b' }, {
      opA: () => 'a', opGhost: () => 'g', undoA: () => 'ua',
    }),
    /action node ghost/
  );
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'b' }, {
      opA: () => 'a', opGhost: () => 'g', undoGhost: () => 'ug',
    }),
    /action node a/
  );
});

test('a compensation operation may share its name with the business operation', async () => {
  const workflow = compensableWorkflow();
  workflow.nodes[2].compensation = { operation: 'opA' };
  const calls = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: (...args) => {
      calls.push(args.length);
      // Business calls arrive with four arguments, compensation calls with
      // five (the stored result is the third argument).
      if (args.length === 4) return 'A';
      return 'self-undo';
    },
    opB: failingOpB,
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(calls, [4, 5]);
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.ok, r.result]), [
    ['a', 'opA', true, 'self-undo'],
  ]);
});
