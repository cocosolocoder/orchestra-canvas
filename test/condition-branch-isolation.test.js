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

// start -> hold (business op, gated) -> gate (condition)
// true  branch then:   process ("处理订单") -> done
// false branch else:   review  ("人工复核") -> done
// notify ("发送通知") is the legal, existing node rejected edits reroute to.
// Nodes appended after the end let a pass normalize gate's new pair first and
// only fail on the appended node afterwards.
function branchWorkflow({ compensate = false, extraNodes = [] } = {}) {
  const holdNode = { id: 'hold', type: 'action', operation: 'hold', next: 'gate' };
  if (compensate) holdNode.compensation = { operation: 'undo' };
  const gateNode = {
    id: 'gate', type: 'condition',
    condition: { field: 'approved', operator: 'eq', value: true },
    then: 'process', else: 'review',
  };
  const processNode = { id: 'process', type: 'action', message: '处理订单', next: 'done' };
  const reviewNode = { id: 'review', type: 'action', message: '人工复核', next: 'done' };
  const notifyNode = { id: 'notify', type: 'action', message: '发送通知', next: 'done' };
  const workflow = {
    id: 'condition-branch-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      holdNode,
      gateNode,
      processNode,
      reviewNode,
      notifyNode,
      { id: 'done', type: 'end', result: 'finished' },
      ...extraNodes,
    ],
  };
  return { workflow, holdNode, gateNode, processNode, reviewNode, notifyNode };
}

// Park the run inside "hold", run `mutate` while it waits, then resume.
async function parkMutateAndResume(workflow, operations, input, mutate) {
  const hold = gatedHold();
  const merged = { ...hold.operations, ...operations };
  const runPromise = executeWorkflowAsync(workflow, input, merged);
  await hold.started;
  await sleep(5);
  mutate();
  hold.release();
  return runPromise;
}

test('a rejected validation does not replace then: the parked true branch keeps its original target', async () => {
  const { workflow, gateNode, reviewNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    // gate now routes the true branch to a different, fully legal node...
    gateNode.then = 'notify';
    // ...but a node checked afterwards makes the whole validation fail.
    reviewNode.next = 'ghost-target';
    assert.throws(
      () => validateWorkflow(workflow),
      /node review points to an unknown destination/,
    );
    // The unaccepted edits stay in place: the run must still follow the last
    // successfully accepted pair.
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
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

test('a rejected validation does not replace else: the parked false branch keeps its original target', async () => {
  const { workflow, gateNode, processNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: false }, () => {
    gateNode.else = 'notify';
    processNode.next = 'ghost-target';
    assert.throws(
      () => validateWorkflow(workflow),
      /node process points to an unknown destination/,
    );
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'review']);
  assert.equal(result.context.output.review, '人工复核');
  assert.equal(result.actionAttempts[0].ok, true);
  assert.equal(result.compensationStatus, 'not_needed');
});

test('editing then while parked without any validation at all leaves the run on its original branch', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    gateNode.then = 'notify';
    // No validateWorkflow call: editing the definition alone must publish
    // nothing.
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
});

test('editing else while parked without any validation at all leaves the run on its original branch', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: false }, () => {
    gateNode.else = 'notify';
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'review']);
});

test('an illegal new branch target on the condition itself rejects validation and cannot reroute the parked run', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    gateNode.then = 'ghost-target';
    assert.throws(
      () => validateWorkflow(workflow),
      /node gate points to an unknown destination/,
    );
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
});

test('then and else are one atomic publication: a legal then edit paired with an illegal else edit publishes neither', async () => {
  for (const approved of [true, false]) {
    const { workflow, gateNode } = branchWorkflow();

    const result = await parkMutateAndResume(workflow, {}, { approved }, () => {
      gateNode.then = 'notify';
      gateNode.else = 'ghost-target';
      assert.throws(() => validateWorkflow(workflow), /node gate points to an unknown destination/);
    });

    assert.equal(result.status, 'completed', `approved=${approved}`);
    assert.deepEqual(result.trace.map(node => node.nodeId),
      approved
        ? ['start', 'hold', 'gate', 'process', 'done']
        : ['start', 'hold', 'gate', 'review', 'done'],
      `approved=${approved}`);
  }
});

test('two legal branch edits still publish nothing when another node fails validation', async () => {
  const { workflow, gateNode, processNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: false }, () => {
    gateNode.then = 'notify';
    gateNode.else = 'notify';
    processNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /unknown destination/);
  });

  // Neither exit switched: the false run keeps review even though the edited
  // else named an existing node.
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'review']);
});

test('an error on the node only the new branch reaches rejects validation but never reaches the parked run', async () => {
  const { workflow, gateNode, notifyNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    gateNode.then = 'notify';
    // notify is reachable only through the new, unaccepted then edge; its
    // error must still fail the whole pass without publishing the new pair.
    notifyNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node notify points to an unknown destination/);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
});

test('a cycle discovered only after every node edge is checked still leaves the parked branches intact', async () => {
  const loopA = { id: 'loop-a', type: 'action', message: 'a', next: 'done' };
  const loopB = { id: 'loop-b', type: 'action', message: 'b', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({ extraNodes: [loopA, loopB] });

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    gateNode.then = 'notify';
    loopA.next = 'loop-b';
    loopB.next = 'loop-a';
    // All per-node edge checks pass; only the final cycle detection fails.
    assert.throws(() => validateWorkflow(workflow), /cycle is present/);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
});

test('an error on an entry-unreachable node rejects validation but never reaches the parked run', async () => {
  const orphan = { id: 'orphan', type: 'action', message: 'o', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({ extraNodes: [orphan] });

  const result = await parkMutateAndResume(workflow, {}, { approved: false }, () => {
    gateNode.else = 'notify';
    orphan.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node orphan points to an unknown destination/);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
});

test('a successful validation updates then for a parked run (existing behavior kept)', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    gateNode.then = 'notify';
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'notify']);
});

test('a successful validation updates else for a parked run (existing behavior kept)', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: false }, () => {
    gateNode.else = 'notify';
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'notify']);
});

test('a successful validation activates only the selected exit; the other new target never runs', async () => {
  const { workflow, gateNode, reviewNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    gateNode.then = 'notify';
    reviewNode.next = 'notify'; // both original exits now converge, legal edit
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // The true run takes notify; the unchosen else target (review) never runs.
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'notify']);
});

test('a failed pass followed by a successful one publishes the accepted branch pair, not the rejected one', async () => {
  const { workflow, gateNode, processNode } = branchWorkflow();

  const result = await parkMutateAndResume(workflow, {}, { approved: true }, () => {
    gateNode.then = 'notify';
    processNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /unknown destination/);
    // Repair the definition while keeping the reroute; the next pass succeeds.
    processNode.next = 'done';
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
});

test('a new run started after a valid revalidation adopts the edited branches', async () => {
  const { workflow, gateNode } = branchWorkflow();
  gateNode.then = 'notify';
  validateWorkflow(workflow);

  const result = await executeWorkflowAsync(
    workflow, { approved: true }, { hold: async () => 'held' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
});

test('a new run from the still-invalid edited definition is rejected before any operation runs', async () => {
  const { workflow, gateNode, reviewNode } = branchWorkflow();
  gateNode.then = 'notify';
  reviewNode.next = 'ghost-target';

  let invocations = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { approved: true }, {
      hold: async () => { invocations += 1; return 'never'; },
    }),
    /node review points to an unknown destination/,
  );
  assert.equal(invocations, 0);
  assert.throws(() => validateWorkflow(workflow), /unknown destination/);
  assert.throws(() => executeWorkflow(workflow, { approved: true }), /unknown destination/);
});

test('a rejected validation never promotes itself to action_failed or triggers compensation', async () => {
  const { workflow, gateNode, reviewNode } = branchWorkflow({ compensate: true });
  let undoCalls = 0;

  const result = await parkMutateAndResume(
    workflow,
    { undo: async () => { undoCalls += 1; return 'undone'; } },
    { approved: true },
    () => {
      gateNode.then = 'notify';
      reviewNode.next = 'ghost-target';
      assert.throws(() => validateWorkflow(workflow), /unknown destination/);
    });

  // The validation error belongs to the caller's validateWorkflow call; the
  // run still ends normally along its original true branch.
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
  assert.equal(undoCalls, 0);
});

test('the synchronous entry follows the condition branches its own compile accepted', () => {
  const gateNode = {
    id: 'gate', type: 'condition',
    condition: { field: 'approved', operator: 'eq', value: true },
    then: 'process', else: 'review',
  };
  const processNode = { id: 'process', type: 'action', message: '处理订单', next: 'done' };
  const reviewNode = { id: 'review', type: 'action', message: '人工复核', next: 'done' };
  const notifyNode = { id: 'notify', type: 'action', message: '发送通知', next: 'done' };
  const workflow = {
    id: 'condition-branch-sync', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'gate' },
      gateNode, processNode, reviewNode, notifyNode,
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };

  const first = executeWorkflow(workflow, { approved: true });
  assert.deepEqual(first.trace.map(node => node.nodeId),
    ['start', 'gate', 'process', 'done']);

  gateNode.then = 'notify';
  validateWorkflow(workflow);
  const second = executeWorkflow(workflow, { approved: true });
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.trace.map(node => node.nodeId),
    ['start', 'gate', 'notify', 'done']);
});
