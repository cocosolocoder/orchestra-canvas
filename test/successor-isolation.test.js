import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A business operation that stays pending until the test releases it, plus a
// promise that fires once the engine has actually invoked it (and is therefore
// parked on its await).
function gatedHold(name = 'hold', result = 'held') {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let invocations = 0;
  const operations = {
    [name]: () => {
      invocations += 1;
      markStarted();
      return gate.then(() => result);
    },
  };
  return { release, started, operations, invocationCount: () => invocations };
}

// start -> hold (business op, gated; next: process) -> process -> done
// notify is a legal, existing node the rejected edit tries to reroute to.
// Nodes appended after the end let a pass normalize hold's new successor
// first and only fail on the appended node afterwards.
function nextWorkflow({ compensate = false, extraNodes = [] } = {}) {
  const holdNode = { id: 'hold', type: 'action', operation: 'hold', next: 'process' };
  if (compensate) holdNode.compensation = { operation: 'undo' };
  const processNode = { id: 'process', type: 'action', message: '处理订单', next: 'done' };
  const notifyNode = { id: 'notify', type: 'action', message: '发送通知', next: 'done' };
  const workflow = {
    id: 'successor-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      holdNode,
      processNode,
      notifyNode,
      { id: 'done', type: 'end', result: 'finished' },
      ...extraNodes,
    ],
  };
  return { workflow, holdNode, processNode, notifyNode };
}

// Array-successor variant (forces exactly one end node):
// start -> hold -> [branch-a, branch-b] -> done; branch-c is the extra,
// legal successor the rejected edits try to add.
function arrayNextWorkflow({ extraNodes = [] } = {}) {
  const holdNode = { id: 'hold', type: 'action', operation: 'hold', next: ['branch-a', 'branch-b'] };
  const branchA = { id: 'branch-a', type: 'action', message: 'a', next: 'done' };
  const branchB = { id: 'branch-b', type: 'action', message: 'b', next: 'done' };
  const branchC = { id: 'branch-c', type: 'action', message: 'c', next: 'done' };
  const workflow = {
    id: 'successor-array-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      holdNode,
      branchA,
      branchB,
      branchC,
      { id: 'done', type: 'end', result: 'finished' },
      ...extraNodes,
    ],
  };
  return { workflow, holdNode, branchA, branchB, branchC };
}

// A form sits between the parked action and the contested successor, so the
// edge is activated through applyRegularNode (the non-action read site)
// rather than the business-action completion path.
function formAfterHoldWorkflow() {
  const holdNode = { id: 'hold', type: 'action', operation: 'hold', next: 'collect' };
  const collectNode = { id: 'collect', type: 'form', next: 'process' };
  const processNode = { id: 'process', type: 'action', message: '处理订单', next: 'done' };
  const notifyNode = { id: 'notify', type: 'action', message: '发送通知', next: 'done' };
  const workflow = {
    id: 'successor-form-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      holdNode,
      collectNode,
      processNode,
      notifyNode,
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  return { workflow, holdNode, collectNode, processNode, notifyNode };
}

// Park the run inside "hold", run `mutate` while it waits, then resume.
async function parkMutateAndResume(workflow, operations, mutate) {
  const hold = gatedHold();
  const merged = { ...hold.operations, ...operations };
  const runPromise = executeWorkflowAsync(workflow, {}, merged);
  await hold.started;
  await sleep(5);
  mutate();
  hold.release();
  return runPromise;
}

test('a rejected validation does not replace a single next: the parked run keeps the original successor', async () => {
  const { workflow, holdNode, processNode } = nextWorkflow();

  const result = await parkMutateAndResume(workflow, {}, () => {
    // hold now points at a different, fully legal existing node...
    holdNode.next = 'notify';
    // ...but a node checked afterwards makes the whole validation fail.
    processNode.next = 'ghost-target';
    assert.throws(
      () => validateWorkflow(workflow),
      /node process points to an unknown destination/,
    );
    // Restore the definition WITHOUT another validation: the run must still
    // follow the last successfully accepted edge.
    holdNode.next = 'process';
    processNode.next = 'done';
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
  assert.equal(result.context.output.process, '处理订单');
  // The independent validation error never enters the run's attempt record.
  assert.equal(result.actionAttempts.length, 1);
  assert.equal(result.actionAttempts[0].nodeId, 'hold');
  assert.equal(result.actionAttempts[0].ok, true);
  // A rejected validation neither fails the run nor compensates its success.
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
});

test('a bad edge on the edited successor itself rejects validation but still cannot reroute the parked run', async () => {
  const { workflow, holdNode, notifyNode } = nextWorkflow();

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next = 'notify';
    // The node only the new edge would reach carries the definition error.
    notifyNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node notify points to an unknown destination/);
    holdNode.next = 'process';
    notifyNode.next = 'done';
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
});

test('a cycle discovered only after every node edge is checked still leaves the parked successors intact', async () => {
  // The extras start acyclic (both -> done); the cycle is closed only in the
  // rejected edit, after the parked run had accepted a legal definition.
  const loopA = { id: 'loop-a', type: 'action', message: 'a', next: 'done' };
  const loopB = { id: 'loop-b', type: 'action', message: 'b', next: 'done' };
  const { workflow, holdNode } = nextWorkflow({ extraNodes: [loopA, loopB] });

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next = 'notify';
    loopA.next = 'loop-b';
    loopB.next = 'loop-a';
    // All per-node edge checks pass; only the final cycle detection fails.
    assert.throws(() => validateWorkflow(workflow), /cycle is present/);
    holdNode.next = 'process';
    loopA.next = 'done';
    loopB.next = 'done';
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
});

test('an error on an entry-unreachable node rejects validation but never reaches the parked run', async () => {
  const orphan = { id: 'orphan', type: 'action', message: 'o', next: 'done' };
  const { workflow, holdNode } = nextWorkflow({ extraNodes: [orphan] });

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next = 'notify';
    // orphan has no incoming edge at all; its error must still reject the
    // whole pass without publishing hold's new successor.
    orphan.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node orphan points to an unknown destination/);
    holdNode.next = 'process';
    orphan.next = 'done';
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'process', 'done']);
});

test('replacing the whole successor array after a rejected validation does not change the parked fan-out', async () => {
  const ghost = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, holdNode, branchC } = arrayNextWorkflow({ extraNodes: [ghost] });

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next = ['branch-a', branchC.id];
    ghost.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node ghost points to an unknown destination/);
    holdNode.next = ['branch-a', 'branch-b'];
    ghost.next = 'done';
  });

  assert.equal(result.status, 'completed');
  // The shared end runs once and waits for both original branches.
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'branch-a', 'branch-b', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'branch-a', 'branch-b']);
});

test('pushing an entry into the original next array during a rejected validation cannot add a parked branch', async () => {
  const ghost = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, holdNode } = arrayNextWorkflow({ extraNodes: [ghost] });

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next.push('branch-c');
    ghost.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node ghost points to an unknown destination/);
    holdNode.next.splice(holdNode.next.indexOf('branch-c'), 1);
    ghost.next = 'done';
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'branch-a', 'branch-b', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'branch-a', 'branch-b']);
});

test('deleting an entry from the original next array during a rejected validation cannot remove a parked branch', async () => {
  const ghost = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, holdNode } = arrayNextWorkflow({ extraNodes: [ghost] });

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next.splice(holdNode.next.indexOf('branch-a'), 1);
    ghost.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node ghost points to an unknown destination/);
    holdNode.next.unshift('branch-a');
    ghost.next = 'done';
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'branch-a', 'branch-b', 'done']);
});

test('a rejected validation also keeps the successor a later form node activates', async () => {
  const { workflow, collectNode, processNode } = formAfterHoldWorkflow();

  const result = await parkMutateAndResume(workflow, {}, () => {
    // The contested edge belongs to the form that runs only after the parked
    // business action succeeds.
    collectNode.next = 'notify';
    processNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node process points to an unknown destination/);
    collectNode.next = 'process';
    processNode.next = 'done';
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'collect', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
});

test('a successful validation still updates the successors of a parked run (existing behavior kept)', async () => {
  const { workflow, holdNode } = nextWorkflow();

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next = 'notify';
    // Fully valid edit: this pass runs to completion and publishes.
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'notify', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'notify']);
});

test('a failed pass followed by a successful one publishes the accepted edit, not the rejected one', async () => {
  const { workflow, holdNode, processNode } = nextWorkflow();

  const result = await parkMutateAndResume(workflow, {}, () => {
    holdNode.next = 'notify';
    processNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /unknown destination/);
    // Repair the definition while keeping the reroute; the next pass succeeds.
    processNode.next = 'done';
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'notify', 'done']);
});

test('a new run started after a valid revalidation adopts the edited successors', async () => {
  const { workflow, holdNode } = nextWorkflow();
  holdNode.next = 'notify';
  validateWorkflow(workflow);

  const result = await executeWorkflowAsync(workflow, {}, { hold: async () => 'held' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'notify', 'done']);
});

test('a new run from the still-invalid edited definition is rejected before any operation runs', async () => {
  const { workflow, holdNode, processNode } = nextWorkflow();
  holdNode.next = 'notify';
  processNode.next = 'ghost-target';

  let invocations = 0;
  const spying = { hold: async () => { invocations += 1; return 'never'; } };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, spying),
    /node process points to an unknown destination/,
  );
  assert.equal(invocations, 0);
  assert.throws(() => validateWorkflow(workflow), /unknown destination/);
  assert.throws(() => executeWorkflow(workflow), /unknown destination/);
});

test('a rejected validation never promotes itself to action_failed or triggers compensation', async () => {
  const { workflow, holdNode, processNode } = nextWorkflow({ compensate: true });
  let undoCalls = 0;

  const result = await parkMutateAndResume(
    workflow,
    { undo: async () => { undoCalls += 1; return 'undone'; } },
    () => {
      holdNode.next = 'notify';
      processNode.next = 'ghost-target';
      assert.throws(() => validateWorkflow(workflow), /unknown destination/);
      holdNode.next = 'process';
      processNode.next = 'done';
    });

  // The validation error belongs to the caller's validateWorkflow call; the
  // run still ends normally along its original path.
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'process', 'done']);
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
  assert.equal(undoCalls, 0);
});

test('the synchronous entry follows the successors its own compile accepted', () => {
  const holdNode = { id: 'hold', type: 'action', message: 'held', next: 'process' };
  const processNode = { id: 'process', type: 'action', message: '处理订单', next: 'done' };
  const notifyNode = { id: 'notify', type: 'action', message: '发送通知', next: 'done' };
  const workflow = {
    id: 'successor-sync', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      holdNode, processNode, notifyNode,
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };

  const first = executeWorkflow(workflow, {});
  assert.deepEqual(first.trace.map(node => node.nodeId),
    ['start', 'hold', 'process', 'done']);

  holdNode.next = 'notify';
  validateWorkflow(workflow);
  const second = executeWorkflow(workflow, {});
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.trace.map(node => node.nodeId),
    ['start', 'hold', 'notify', 'done']);
});
