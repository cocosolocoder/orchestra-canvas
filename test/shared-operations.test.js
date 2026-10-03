import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

// Regression coverage for reusing one registered operation name (and one
// registered compensation name) across several business action nodes: the
// implementation is shared, but every node's attempts, outputs, snapshots
// and compensation records must stay attached to its own node id.
//
// start -> a (op "shared") -> fill (form default) -> b (op "shared") -> c -> done
function sharedWorkflow({ aComp = null, bComp = null, cProps = {} } = {}) {
  return {
    id: 'shared-ops',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      {
        id: 'a', type: 'action', operation: 'shared',
        retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        ...(aComp ? { compensation: aComp } : {}),
        next: 'fill',
      },
      { id: 'fill', type: 'form', next: 'b', schema: { fields: [
        { path: 'late', type: 'string', default: 'after-a' },
      ] } },
      {
        id: 'b', type: 'action', operation: 'shared',
        retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
        ...(bComp ? { compensation: bComp } : {}),
        next: 'c',
      },
      { id: 'c', type: 'action', operation: 'opC', ...cProps, next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
}

const failingOpC = () => { throw new Error('c-boom'); };

test('actions sharing one operation keep separate attempt counters, outputs and trace entries', async () => {
  const calls = [];
  const execution = await executeWorkflowAsync(sharedWorkflow(), { amount: 5 }, {
    shared: (input, output, nodeId, attempt) => {
      calls.push({ nodeId, attempt, input: structuredClone(input), output: structuredClone(output) });
      if (nodeId === 'a' && attempt < 3) {
        // A failed attempt tampers with its argument copies and would leave
        // junk behind if the copies were shared with the run.
        input.tampered = true;
        output.a = 'failed-attempt-junk';
        throw new Error(`a fail ${attempt}`);
      }
      return { by: nodeId, attempt };
    },
    opC: () => 'C',
  });

  assert.equal(execution.status, 'completed');
  // a's three attempts are numbered 1..3 under its own retry config; b still
  // starts at 1 — a's consumed attempts do not carry over to the shared name.
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, false], ['a', 2, false], ['a', 3, true], ['b', 1, true], ['c', 1, true],
  ]);
  assert.deepEqual(calls.map(c => [c.nodeId, c.attempt]), [
    ['a', 1], ['a', 2], ['a', 3], ['b', 1],
  ]);

  // a's successful retry sees the pristine input, untouched by its own
  // failed attempts.
  assert.deepEqual(calls[2].input, { amount: 5 });
  // b sees the form default and a's success result — never the junk a's
  // failed attempts wrote into their copies, and never its own key.
  assert.deepEqual(calls[3].input, { amount: 5, late: 'after-a' });
  assert.deepEqual(calls[3].output, { a: { by: 'a', attempt: 3 } });

  // Each success is stored under its own node name; the shared operation
  // name does not merge them.
  assert.deepEqual(execution.context.output, {
    a: { by: 'a', attempt: 3 },
    b: { by: 'b', attempt: 1 },
    c: 'C',
  });
  assert.deepEqual(execution.context.input, { amount: 5, late: 'after-a' });
  // Every node appears exactly once in the regular trace.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'fill', 'b', 'c', 'done']);
});

test('a shared compensation undoes each successful action in reverse order with per-node snapshots', async () => {
  const workflow = sharedWorkflow({
    aComp: { operation: 'undo', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
    bComp: { operation: 'undo', retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
  });
  const undoCalls = [];
  const execution = await executeWorkflowAsync(workflow, { amount: 5 }, {
    shared: (input, output, nodeId) => ({ by: nodeId }),
    opC: failingOpC,
    undo: (input, output, result, nodeId, attempt) => {
      undoCalls.push({
        nodeId, attempt,
        input: structuredClone(input),
        output: structuredClone(output),
        result: structuredClone(result),
      });
      if (nodeId === 'b' && attempt < 3) throw new Error(`undo b ${attempt}`);
      return `undone-${nodeId}`;
    },
  });

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.error, 'c-boom');
  assert.equal(execution.compensationStatus, 'completed');

  // Reverse success order: b (which retried its compensation up to its own
  // config) before a. Compensation attempts are numbered from 1 per node —
  // they continue neither the business attempts nor the other node's count.
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok]), [
    ['b', 'undo', 1, false],
    ['b', 'undo', 2, false],
    ['b', 'undo', 3, true],
    ['a', 'undo', 1, true],
  ]);
  assert.deepEqual(undoCalls.map(c => [c.nodeId, c.attempt]), [
    ['b', 1], ['b', 2], ['b', 3], ['a', 1],
  ]);

  // b's compensation sees the input as of b's success — including the form
  // default applied between a and b — plus a's earlier output and b's own
  // return value, but not b's own output key.
  const bCall = undoCalls[2];
  assert.deepEqual(bCall.input, { amount: 5, late: 'after-a' });
  assert.deepEqual(bCall.output, { a: { by: 'a' } });
  assert.deepEqual(bCall.result, { by: 'b' });

  // a's snapshot was captured before the form ran: the later default never
  // leaks backwards into the earlier node's compensation input.
  const aCall = undoCalls[3];
  assert.deepEqual(aCall.input, { amount: 5 });
  assert.deepEqual(aCall.output, {});
  assert.deepEqual(aCall.result, { by: 'a' });

  // The failed node stored no output; the successful ones keep theirs.
  assert.equal(execution.context.output.c, undefined);
  assert.deepEqual(execution.context.output.a, { by: 'a' });
  assert.deepEqual(execution.context.output.b, { by: 'b' });
  // Compensation records never enter the regular trace.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'fill', 'b', 'c']);
});

test('an exhausted shared compensation still compensates the earlier node and preserves the failure result', async () => {
  const workflow = sharedWorkflow({
    aComp: { operation: 'undo' },
    bComp: { operation: 'undo', retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } },
    // The ultimately failing node declares a compensation too: it never
    // succeeded, so the shared undo must never be called with its id.
    cProps: { compensation: { operation: 'undo' } },
  });
  const undoCalls = [];
  const execution = await executeWorkflowAsync(workflow, { amount: 5 }, {
    shared: (input, output, nodeId) => ({ by: nodeId }),
    opC: failingOpC,
    undo: (input, output, result, nodeId, attempt) => {
      undoCalls.push({
        nodeId, attempt,
        input: structuredClone(input),
        output: structuredClone(output),
        result: structuredClone(result),
      });
      // Mutations by b's failing compensation must not reach a's snapshots
      // or the run context.
      input.tampered = true;
      output.tampered = true;
      result.tampered = true;
      if (nodeId === 'b') throw new Error(`undo b stuck ${attempt}`);
      return `undone-${nodeId}`;
    },
  });

  // The original business failure is reported unchanged.
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'c');
  assert.equal(execution.attempts, 1);
  assert.equal(execution.error, 'c-boom');
  // b's compensation exhausted its own three attempts; a's still ran once.
  assert.equal(execution.compensationStatus, 'failed');
  assert.deepEqual(execution.compensationAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['b', 1, false],
    ['b', 2, false],
    ['b', 3, false],
    ['a', 1, true],
  ]);
  // c failed and is never compensated, despite sharing the undo name.
  assert.deepEqual(undoCalls.map(c => c.nodeId), ['b', 'b', 'b', 'a']);

  // a's compensation snapshots are untouched by b's mutating attempts.
  const aCall = undoCalls[3];
  assert.deepEqual(aCall.input, { amount: 5 });
  assert.deepEqual(aCall.output, {});
  assert.deepEqual(aCall.result, { by: 'a' });

  // Successful outputs stay saved under their own node names; the failed
  // node has none, and the context shows no compensation-side tampering.
  assert.deepEqual(execution.context.output, { a: { by: 'a' }, b: { by: 'b' } });
  assert.deepEqual(execution.context.input, { amount: 5, late: 'after-a' });
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, true], ['b', 1, true], ['c', 1, false],
  ]);
});
