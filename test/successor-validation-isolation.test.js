import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

// A business operation that stays pending until the test releases it, plus a
// promise that fires once the engine has actually invoked it (and is
// therefore parked on its await) — the window in which the definition is
// edited and revalidated.
function gatedHold(name = 'hold', result = 'charged') {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const operations = {
    [name]: () => {
      markStarted();
      return gate.then(() => result);
    },
  };
  return { release, started, operations };
}

// start -> charge (business "hold") -> process-order -> done, with a legal
// but unconnected send-notification node available as an edit target.
// chargeNode/processNode/notifyNode are returned so tests can rewire next.
function orderWorkflow() {
  const chargeNode = { id: 'charge', type: 'action', operation: 'hold', next: 'process-order' };
  const processNode = { id: 'process-order', type: 'action', message: 'processed', next: 'done' };
  const notifyNode = { id: 'send-notification', type: 'action', message: 'notified', next: 'done' };
  const workflow = {
    id: 'order-flow', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'charge' },
      chargeNode,
      processNode,
      notifyNode,
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  return { workflow, chargeNode, processNode, notifyNode };
}

function executedNodeIds(result) {
  return result.trace.map(entry => entry.nodeId);
}

test('a rejected revalidation cannot reroute a run parked on a business operation', async () => {
  const { workflow, chargeNode, processNode } = orderWorkflow();
  const hold = gatedHold();

  const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;

  // The edit: charge's next is rewired to the legal send-notification node,
  // but the same edit leaves process-order pointing at a missing target, so
  // the definition as a whole is rejected.
  chargeNode.next = 'send-notification';
  processNode.next = 'missing-node';
  assert.throws(() => validateWorkflow(workflow), /process-order points to an unknown destination/);

  // The caller restores the definition to its pre-edit content — without
  // running another validation — and lets the parked operation return.
  chargeNode.next = 'process-order';
  processNode.next = 'done';
  hold.release();

  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  // Only the original path executed: the rejected edit's send-notification
  // connection was never adopted.
  assert.deepEqual(executedNodeIds(result), ['start', 'charge', 'process-order', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['charge', 'process-order']);
  assert.equal(result.context.output['process-order'], 'processed');
  // The independent validation error is not mixed into the run: the single
  // successful attempt stands alone, the run is not reported as
  // action_failed, and no compensation was triggered by the failed edit.
  assert.equal(result.actionAttempts.length, 1);
  assert.equal(result.actionAttempts[0].nodeId, 'charge');
  assert.equal(result.actionAttempts[0].ok, true);
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
});

test('a rejected revalidation does not trigger compensation of already-succeeded actions', async () => {
  const { workflow, chargeNode, processNode } = orderWorkflow();
  chargeNode.compensation = { operation: 'undo' };
  const hold = gatedHold();
  let compensations = 0;
  const operations = {
    ...hold.operations,
    undo: () => { compensations += 1; },
  };

  const runPromise = executeWorkflowAsync(workflow, {}, operations);
  await hold.started;

  chargeNode.next = 'send-notification';
  processNode.next = 'missing-node';
  assert.throws(() => validateWorkflow(workflow), /unknown destination/);

  chargeNode.next = 'process-order';
  processNode.next = 'done';
  hold.release();

  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.equal(compensations, 0);
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
});

test('rejected edits to a next array — replaced or mutated in place — cannot reroute a parked run', async () => {
  for (const mutate of ['replace', 'push']) {
    const { workflow, chargeNode, processNode } = orderWorkflow();
    chargeNode.next = ['process-order'];
    const hold = gatedHold();

    const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
    await hold.started;

    if (mutate === 'replace') {
      chargeNode.next = ['send-notification'];
    } else {
      chargeNode.next.push('send-notification');
    }
    processNode.next = 'missing-node';
    assert.throws(() => validateWorkflow(workflow), /unknown destination/, mutate);

    chargeNode.next = ['process-order'];
    processNode.next = 'done';
    hold.release();

    const result = await runPromise;
    assert.equal(result.status, 'completed', mutate);
    assert.deepEqual(executedNodeIds(result), ['start', 'charge', 'process-order', 'done'], mutate);
    assert.deepEqual(Object.keys(result.context.output), ['charge', 'process-order'], mutate);
  }
});

test('a cycle discovered after all connections check out cannot reroute a parked run', async () => {
  const { workflow, chargeNode, notifyNode } = orderWorkflow();
  const hold = gatedHold();

  const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;

  // Every target exists, so the per-node connection checks pass; only the
  // whole-definition cycle check afterwards rejects the edit (the
  // notification node loops onto itself).
  chargeNode.next = 'send-notification';
  notifyNode.next = 'send-notification';
  assert.throws(() => validateWorkflow(workflow), /cycle is present/);

  chargeNode.next = 'process-order';
  notifyNode.next = 'done';
  hold.release();

  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.deepEqual(executedNodeIds(result), ['start', 'charge', 'process-order', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['charge', 'process-order']);
});

test('a rejection caused by an unreachable node cannot reroute a parked run', async () => {
  const { workflow, chargeNode } = orderWorkflow();
  // An orphan the entry can never reach; the edit breaks only its edge.
  const orphanNode = { id: 'orphan', type: 'action', message: 'orphan', next: 'done' };
  workflow.nodes.push(orphanNode);
  const hold = gatedHold();

  const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;

  chargeNode.next = 'send-notification';
  orphanNode.next = 'missing-node';
  assert.throws(() => validateWorkflow(workflow), /orphan points to an unknown destination/);

  chargeNode.next = 'process-order';
  orphanNode.next = 'done';
  hold.release();

  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.deepEqual(executedNodeIds(result), ['start', 'charge', 'process-order', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['charge', 'process-order']);
});

test('a rejection caused by a node on an untaken branch cannot reroute a parked run', async () => {
  const standardNode = { id: 'standard', type: 'action', message: 'standard', next: 'done' };
  const chargeNode = { id: 'charge', type: 'action', operation: 'hold', next: 'process-order' };
  const workflow = {
    id: 'branch-flow', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { field: 'vip', operator: 'eq', value: true },
        then: 'charge', else: 'standard',
      },
      chargeNode,
      standardNode,
      { id: 'process-order', type: 'action', message: 'processed', next: 'done' },
      { id: 'send-notification', type: 'action', message: 'notified', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const hold = gatedHold();

  const runPromise = executeWorkflowAsync(workflow, { vip: true }, hold.operations);
  await hold.started;

  // The error sits on standard, a node the taken branch never reaches.
  chargeNode.next = 'send-notification';
  standardNode.next = 'missing-node';
  assert.throws(() => validateWorkflow(workflow), /standard points to an unknown destination/);

  chargeNode.next = 'process-order';
  standardNode.next = 'done';
  hold.release();

  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.deepEqual(executedNodeIds(result), ['start', 'check', 'charge', 'process-order', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['charge', 'process-order']);
});

test('a successful revalidation still updates successors for the parked run and later runs', async () => {
  const { workflow, chargeNode } = orderWorkflow();
  const hold = gatedHold();

  const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;

  // The whole edited definition validates, so the new connection is
  // published — the compatibility behavior that must keep working.
  chargeNode.next = 'send-notification';
  validateWorkflow(workflow);
  hold.release();

  const rerouted = await runPromise;
  assert.equal(rerouted.status, 'completed');
  assert.deepEqual(executedNodeIds(rerouted), ['start', 'charge', 'send-notification', 'done']);
  assert.deepEqual(Object.keys(rerouted.context.output), ['charge', 'send-notification']);

  // A new run started after the legal modification uses the new connection.
  const followUp = await executeWorkflowAsync(workflow, {}, hold.operations);
  assert.equal(followUp.status, 'completed');
  assert.deepEqual(executedNodeIds(followUp), ['start', 'charge', 'send-notification', 'done']);
});

test('a rejected revalidation followed by a restored definition needs no extra validation', async () => {
  const { workflow, chargeNode, processNode } = orderWorkflow();
  const hold = gatedHold();

  // Establish the baseline successors with an explicit validation first.
  validateWorkflow(workflow);

  const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;

  chargeNode.next = 'send-notification';
  processNode.next = 'missing-node';
  assert.throws(() => validateWorkflow(workflow), /unknown destination/);

  // Restore exactly the pre-edit content and release without revalidating.
  chargeNode.next = 'process-order';
  processNode.next = 'done';
  hold.release();

  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(executedNodeIds(result), ['start', 'charge', 'process-order', 'done']);
});
