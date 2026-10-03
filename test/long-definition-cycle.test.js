import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

// Builds a legal linear workflow: trigger -> n1 -> ... -> n(count-2) -> end.
function longSuccessorChain(count) {
  const nodes = [{ id: 'start', type: 'trigger', next: 'n1' }];
  for (let i = 1; i <= count - 2; i += 1) {
    nodes.push({
      id: `n${i}`,
      type: 'action',
      next: i === count - 2 ? 'end' : `n${i + 1}`,
    });
  }
  nodes.push({ id: 'end', type: 'end', result: 'done' });
  return { id: 'long', entry: 'start', nodes };
}

// The same chain, but every ordering step is also declared as an explicit
// "runs only after the previous node completed" dependency.
function longDependencyChain(count) {
  const workflow = longSuccessorChain(count);
  workflow.nodes.forEach((node, index) => {
    if (node.id !== 'start' && node.id !== 'end' && index >= 2) {
      node.dependsOn = [`n${index - 1}`];
    }
  });
  return workflow;
}

test('validates a 20000-node successor chain without a call-stack overflow', () => {
  const workflow = longSuccessorChain(20000);
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

test('validates a 20000-node chain wired by explicit dependencies', () => {
  const workflow = longDependencyChain(20000);
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

test('synchronous execution validates and runs the long chain', () => {
  const workflow = longDependencyChain(20000);
  const result = executeWorkflow(workflow, {});
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'done');
  assert.equal(result.trace.length, 20000);
});

test('asynchronous execution applies the same long-definition validation', async () => {
  const workflow = longSuccessorChain(20000);
  const result = await executeWorkflowAsync(workflow, {});
  assert.equal(result.status, 'completed');
  assert.equal(result.trace.length, 20000);
});

test('validation never mutates the long definition', () => {
  const workflow = longSuccessorChain(20000);
  const snapshot = JSON.stringify(workflow);
  validateWorkflow(workflow);
  assert.equal(JSON.stringify(workflow), snapshot);
});

test('reports a cycle added at the end of a long successor chain', () => {
  const workflow = longSuccessorChain(20000);
  // The last action points back a few steps instead of reaching the end.
  workflow.nodes[workflow.nodes.length - 2].next = 'n19990';
  let thrown;
  assert.throws(() => validateWorkflow(workflow), error => {
    thrown = error;
    return /^cycle is present: /.test(error.message);
  });
  const ids = thrown.message.replace('cycle is present: ', '').split(' -> ');
  assert.equal(ids[0], ids[ids.length - 1]);
  assert.equal(ids[0], 'n19990');
  // Every reported step must correspond to a real successor edge.
  const edges = new Set();
  for (const node of workflow.nodes) {
    if (typeof node.next === 'string') edges.add(`${node.id}->${node.next}`);
  }
  for (let i = 0; i < ids.length - 1; i += 1) {
    assert.ok(edges.has(`${ids[i]}->${ids[i + 1]}`),
      `${ids[i]} -> ${ids[i + 1]} is not a real edge`);
  }
});

test('reports a cycle reaching back to the start of a long chain', () => {
  const workflow = longSuccessorChain(20000);
  workflow.nodes[workflow.nodes.length - 2].next = 'n1';
  let thrown;
  assert.throws(() => validateWorkflow(workflow), error => {
    thrown = error;
    return /^cycle is present: n1( -> n\d+)+ -> n1$/.test(error.message);
  });
  const ids = thrown.message.replace('cycle is present: ', '').split(' -> ');
  assert.equal(ids[0], 'n1');
  assert.equal(ids[ids.length - 1], 'n1');
});

test('detects a long chain closed by an explicit dependency', () => {
  const workflow = longDependencyChain(20000);
  // The end can never depend, so close the ring from an early action back to
  // the last one through a dependency relation instead.
  workflow.nodes[1].dependsOn = ['n19998'];
  assert.throws(() => validateWorkflow(workflow), /cycle is present/);
});

test('detects a cycle through the unchosen exit of a condition in a long chain', () => {
  const workflow = longSuccessorChain(20000);
  // Replace n5 with a condition: the chosen exit continues forward, but the
  // unchosen exit closes a ring — definition validation must still reject.
  workflow.nodes[5] = {
    id: 'n5', type: 'condition',
    condition: { field: 'amount', operator: 'gte', value: 0 },
    then: 'n6', else: 'n2',
  };
  let thrown;
  assert.throws(() => validateWorkflow(workflow), error => {
    thrown = error;
    return /cycle is present: n2 -> n3 -> n4 -> n5 -> n2/.test(error.message);
  });
  // The entry path (start, n1) must not be spliced into the reported chain.
  assert.equal(thrown.message.replace('cycle is present: ', '').split(' -> ')[0], 'n2');
});

test('rejects a cycle in an entry-unreachable part after a long valid part', () => {
  const workflow = longSuccessorChain(20000);
  workflow.nodes.push(
    { id: 'ghost1', type: 'action', next: 'ghost2' },
    { id: 'ghost2', type: 'action', next: 'ghost1' },
  );
  assert.throws(() => validateWorkflow(workflow), /cycle is present: ghost1 -> ghost2 -> ghost1/);
});

test('long branches that only converge on one node are not a cycle', () => {
  const workflow = {
    id: 'join', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'join' },
      { id: 'b', type: 'action', next: 'join' },
      { id: 'join', type: 'action', next: 'tail1' },
    ],
  };
  for (let i = 1; i <= 19995; i += 1) {
    workflow.nodes.push({
      id: `tail${i}`, type: 'action',
      next: i === 19995 ? 'end' : `tail${i + 1}`,
    });
  }
  workflow.nodes.push({ id: 'end', type: 'end', result: 'done' });
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

test('execution entries reject the definition before any node runs', async () => {
  const cyclic = longSuccessorChain(20000);
  cyclic.nodes[cyclic.nodes.length - 2].next = 'n1';

  assert.throws(() => executeWorkflow(cyclic, {}), /cycle is present/);

  let invoked = 0;
  await assert.rejects(
    executeWorkflowAsync(cyclic, {}, { op: async () => { invoked += 1; } }),
    /cycle is present/,
  );
  assert.equal(invoked, 0);
});
