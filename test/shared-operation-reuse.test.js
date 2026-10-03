import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for reusing one registered operation name from several
// business action nodes (and one registered compensation name from several
// compensable actions). The reuse is of the implementation only: attempt
// numbering, retry configs, saved outputs and compensation snapshots stay
// attributed to each node, so equal operation names never merge or cross-feed
// node state.

const noWait = { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };

// start -> a (shared op, own retry) -> b (shared op, own retry) -> c -> done
function sharedOperationWorkflow(aRetry, bRetry) {
  return {
    id: 'shared-op',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'shared',
        retry: aRetry, next: 'b',
      },
      {
        id: 'b', type: 'action', operation: 'shared',
        retry: bRetry, next: 'c',
      },
      { id: 'c', type: 'action', operation: 'boom', ...noWait, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

test('two nodes sharing one operation name each number attempts from 1 under their own retry config', async () => {
  const workflow = sharedOperationWorkflow(
    { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    // b carries its own config: the wait after b's failed first attempt is
    // b's 10ms, not anything inherited from a's zero-delay retries.
    { attempts: 2, initialDelayMs: 10, backoffFactor: 2, maxDelayMs: 50 },
  );
  const calls = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    shared: (input, output, nodeId, attempt) => {
      calls.push({ nodeId, attempt, output: structuredClone(output) });
      if (nodeId === 'a' && attempt < 2) throw new Error('a-boom');
      if (nodeId === 'b' && attempt < 2) throw new Error('b-boom');
      return { who: nodeId };
    },
    boom: () => { throw new Error('c-boom'); },
  });

  // a's failed first attempt does not consume b's attempts: b starts at 1 even
  // though the shared implementation already ran twice for a.
  assert.deepEqual(calls.map(c => [c.nodeId, c.attempt]), [
    ['a', 1], ['a', 2], ['b', 1], ['b', 2],
  ]);
  // Every a attempt runs before a succeeded with an empty output; every b
  // attempt sees a's success output, never a failed attempt's return and never
  // b's own not-yet-saved output.
  for (const call of calls.filter(c => c.nodeId === 'a')) {
    assert.deepEqual(call.output, {});
  }
  for (const call of calls.filter(c => c.nodeId === 'b')) {
    assert.deepEqual(call.output, { a: { who: 'a' } });
  }

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.attempts, 1);
  assert.equal(execution.error, 'c-boom');
  // The two successes are stored under their own node names; the failed c
  // node stores nothing.
  assert.deepEqual(execution.context.output, { a: { who: 'a' }, b: { who: 'b' } });
  assert.equal(execution.context.output.c, undefined);
  // The regular trace lists each node exactly once regardless of attempts.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b', 'c']);
  // Attempt records stay in actual invocation order with per-node numbering,
  // outcome and per-config delay.
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok, r.error, r.nextDelayMs]), [
    ['a', 1, false, 'a-boom', 0],
    ['a', 2, true, null, 0],
    ['b', 1, false, 'b-boom', 10],
    ['b', 2, true, null, 0],
    ['c', 1, false, 'c-boom', 0],
  ]);
});

test('a failed attempt mutating its copies cannot change the next attempt or a later node sharing the operation', async () => {
  const workflow = sharedOperationWorkflow(
    { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  );
  const execution = await executeWorkflowAsync(workflow, { amount: 10, nested: { v: 1 } }, {
    shared: (input, output, nodeId, attempt) => {
      if (nodeId === 'a' && attempt === 1) {
        input.amount = 999;
        input.nested.v = 999;
        input.added = 'by-failed-attempt';
        output.tampered = true;
        output.a = 'early';
        throw new Error('a-boom');
      }
      // a's retry and b's only attempt both observe the pristine run data;
      // b additionally sees a's stored success under a's own node name.
      assert.deepEqual(input, { amount: 10, nested: { v: 1 } });
      assert.deepEqual(output, nodeId === 'a' ? {} : { a: { who: 'a' } });
      // Mutating the copy on the successful call is discarded as well.
      input.amount = -1;
      output.tampered = true;
      return { who: nodeId };
    },
    boom: () => { throw new Error('c-boom'); },
  });

  assert.equal(execution.status, 'action_failed');
  assert.deepEqual(execution.context.input, { amount: 10, nested: { v: 1 } });
  assert.deepEqual(execution.context.output, { a: { who: 'a' }, b: { who: 'b' } });
});

// start -> a (step, fails then succeeds, undo with 2 attempts) -> form-mid
// (adds the `mid` default) -> b (step, succeeds once, undo with 3 attempts)
// -> c (same shared step implementation, always fails) .
function sharedCompensationWorkflow() {
  return {
    id: 'shared-comp',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'step',
        retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        compensation: {
          operation: 'undo',
          retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        },
        next: 'form-mid',
      },
      { id: 'form-mid', type: 'form', next: 'b', schema: { fields: [
        { path: 'mid', type: 'string', default: 'between' },
      ] } },
      {
        id: 'b', type: 'action', operation: 'step',
        compensation: {
          operation: 'undo',
          retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        },
        next: 'c',
      },
      { id: 'c', type: 'action', operation: 'step', ...noWait, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

test('a shared compensation implementation is invoked per original node with per-node snapshots and per-node attempt numbers', async () => {
  const seen = [];
  const execution = await executeWorkflowAsync(sharedCompensationWorkflow(), {}, {
    // One registered implementation backs all three business nodes; it tells
    // nodes apart solely through the nodeId argument.
    step: (input, output, nodeId, attempt) => {
      if (nodeId === 'a' && attempt < 2) throw new Error('a-boom');
      if (nodeId === 'c') throw new Error('c-boom');
      return { done: nodeId };
    },
    undo: (input, output, result, nodeId, attempt) => {
      seen.push({
        nodeId, attempt,
        input: structuredClone(input),
        output: structuredClone(output),
        result: structuredClone(result),
      });
      // Mutations must die with this attempt's copies.
      input.mid = 'hacked';
      input.sneakedIn = nodeId;
      output.tampered = true;
      result.done = 'overwritten';
      // b's compensation exhausts all three of its own attempts; a's fails
      // once and succeeds on its second.
      if (nodeId === 'b') throw new Error(`undo-b-${attempt}`);
      if (attempt < 2) throw new Error(`undo-a-${attempt}`);
      return `undone-${nodeId}`;
    },
  });

  // Business records show a retried-then-success, b succeeding once and the
  // failed c node — each node's attempt numbers starting at 1.
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, false], ['a', 2, true], ['b', 1, true], ['c', 1, false],
  ]);

  // The original business failure is preserved verbatim.
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.attempts, 1);
  assert.equal(execution.error, 'c-boom');

  // Reverse success order, and b giving up does not stop a from being undone.
  // Compensation attempt numbers restart at 1 for each original node: they
  // continue neither the other node's count nor business attempt numbers.
  assert.deepEqual(
    execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]),
    [
      ['b', 'undo', 1, false],
      ['b', 'undo', 2, false],
      ['b', 'undo', 3, false],
      ['a', 'undo', 1, false],
      ['a', 'undo', 2, true],
    ],
  );
  assert.deepEqual(seen.map(s => [s.nodeId, s.attempt]), [
    ['b', 1], ['b', 2], ['b', 3], ['a', 1], ['a', 2],
  ]);
  assert.equal(execution.compensationStatus, 'failed');

  // Each call is explicitly attributed to its original node and receives that
  // node's success-moment input, the earlier successful nodes' outputs and its
  // own return value.
  for (const call of seen.filter(s => s.nodeId === 'b')) {
    assert.deepEqual(call.input, { mid: 'between' });
    assert.deepEqual(call.output, { a: { done: 'a' } });
    assert.deepEqual(call.result, { done: 'b' });
  }
  // The default the form inserted between a and b appears only in b's
  // snapshots; a's earlier snapshot is not overwritten by later data.
  for (const call of seen.filter(s => s.nodeId === 'a')) {
    assert.deepEqual(call.input, {});
    assert.equal(call.input.mid, undefined);
    assert.deepEqual(call.output, {});
    assert.deepEqual(call.result, { done: 'a' });
  }

  // Compensation mutations never reach the run context; saved business
  // outputs stay under their original node names and c has none.
  assert.deepEqual(execution.context.input, { mid: 'between' });
  assert.deepEqual(execution.context.output, { a: { done: 'a' }, b: { done: 'b' } });
  assert.equal(execution.context.output.c, undefined);
  // Compensation records never enter the normal node trace, which keeps one
  // entry per actually executed node.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'form-mid', 'b', 'c']);
  assert.ok(execution.compensationAttempts.every(r => r.nodeId !== 'c'));
});

test('successful compensations sharing one name still undo in reverse success order once per node', async () => {
  const order = [];
  const execution = await executeWorkflowAsync(sharedCompensationWorkflow(), {}, {
    step: (input, output, nodeId, attempt) => {
      if (nodeId === 'a' && attempt < 2) throw new Error('a-boom');
      if (nodeId === 'c') throw new Error('c-boom');
      return { done: nodeId };
    },
    undo: (input, output, result, nodeId, attempt) => {
      order.push([nodeId, attempt]);
      return `undone-${nodeId}`;
    },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');
  assert.deepEqual(order, [['b', 1], ['a', 1]]);
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.attempt, r.ok, r.result]), [
    ['b', 1, true, 'undone-b'],
    ['a', 1, true, 'undone-a'],
  ]);
});

test('a fully successful run keeps shared-name outputs per node and never compensates', async () => {
  const workflow = {
    id: 'shared-happy',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'step', compensation: { operation: 'undo' }, next: 'b' },
      { id: 'b', type: 'action', operation: 'step', compensation: { operation: 'undo' }, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  let undoCalls = 0;
  const execution = await executeWorkflowAsync(workflow, { amount: 1 }, {
    step: (input, output, nodeId) => ({ done: nodeId, saw: output }),
    undo: () => { undoCalls += 1; },
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.output.a, { done: 'a', saw: {} });
  assert.deepEqual(execution.context.output.b, { done: 'b', saw: { a: { done: 'a', saw: {} } } });
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, true], ['b', 1, true],
  ]);
  assert.equal(undoCalls, 0);
  assert.equal(execution.compensationStatus, 'not_needed');
  assert.deepEqual(execution.compensationAttempts, []);
});
