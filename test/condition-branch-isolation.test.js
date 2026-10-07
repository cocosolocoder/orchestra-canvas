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
//        -> process (then, "处理订单") / review (else, "人工复核") -> done
// notify ("发送通知") is a legal, existing node the rejected edits try to
// reroute an exit to. Nodes appended after the end let a pass normalize the
// condition's new then/else first and only fail on an appended node afterwards.
function branchWorkflow({ compensate = false, extraNodes = [] } = {}) {
  const holdNode = { id: 'hold', type: 'action', operation: 'hold', next: 'gate' };
  if (compensate) holdNode.compensation = { operation: 'undo' };
  const gateNode = {
    id: 'gate', type: 'condition',
    condition: { field: 'amount', operator: 'gte', value: 80 },
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
async function parkMutateAndResume(workflow, input, operations, mutate) {
  const hold = gatedHold();
  const merged = { ...hold.operations, ...operations };
  const runPromise = executeWorkflowAsync(workflow, input, merged);
  await hold.started;
  await sleep(5);
  mutate();
  hold.release();
  return runPromise;
}

// ── rejected / absent validation must never move either exit ───────────────

test('a rejected validation does not replace then: a parked true-condition run keeps the accepted exit', async () => {
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({ extraNodes: [ghostNode] });

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    // gate now takes the also-existing notify on the true branch...
    gateNode.then = 'notify';
    // ...but a node checked afterwards makes the whole validation fail. The
    // failing edits are intentionally LEFT IN PLACE (no restore).
    ghostNode.next = 'ghost-target';
    assert.throws(
      () => validateWorkflow(workflow),
      /node ghost points to an unknown destination/,
    );
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'process']);
  assert.equal(result.context.output.process, '处理订单');
});

test('a rejected validation does not replace else: the rule protects the false branch too, not just then', async () => {
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({ extraNodes: [ghostNode] });

  const result = await parkMutateAndResume(workflow, { amount: 10 }, {}, () => {
    gateNode.else = 'notify';
    ghostNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node ghost points to an unknown destination/);
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
  assert.deepEqual(Object.keys(result.context.output), ['hold', 'review']);
  assert.equal(result.context.output.review, '人工复核');
});

test('then and else are one atomic unit: a rejected pass keeps both accepted exits even when both were edited', async () => {
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const built = branchWorkflow({ extraNodes: [ghostNode] });

  const mutate = () => {
    built.gateNode.then = 'notify';
    built.gateNode.else = 'notify';
    ghostNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(built.workflow), /unknown destination/);
  };

  const trueRun = await parkMutateAndResume(built.workflow, { amount: 90 }, {}, mutate);
  assert.deepEqual(trueRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);

  // Reset the definition for a second parked run; the rejected edits were
  // never accepted so a restore without revalidation is enough.
  built.gateNode.then = 'process';
  built.gateNode.else = 'review';
  ghostNode.next = 'done';

  const falseRun = await parkMutateAndResume(built.workflow, { amount: 10 }, {}, mutate);
  assert.deepEqual(falseRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
});

test('an illegal exit on the condition node itself rejects validation but still cannot reroute the parked run', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const trueRun = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    gateNode.then = 'nowhere';
    assert.throws(() => validateWorkflow(workflow), /node gate points to an unknown destination/);
  });
  assert.equal(trueRun.status, 'completed');
  assert.deepEqual(trueRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);

  gateNode.then = 'process';
  const falseRun = await parkMutateAndResume(workflow, { amount: 10 }, {}, () => {
    gateNode.else = 'nowhere';
    assert.throws(() => validateWorkflow(workflow), /node gate points to an unknown destination/);
  });
  assert.equal(falseRun.status, 'completed');
  assert.deepEqual(falseRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
});

test('a cycle discovered only after every node edge is checked still leaves the parked condition exits intact', async () => {
  const loopA = { id: 'loop-a', type: 'action', message: 'a', next: 'done' };
  const loopB = { id: 'loop-b', type: 'action', message: 'b', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({ extraNodes: [loopA, loopB] });

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    gateNode.then = 'notify';
    gateNode.else = 'notify';
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

test('an error on an entry-unreachable node rejects validation but never reaches the parked condition', async () => {
  const orphan = { id: 'orphan', type: 'action', message: 'o', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({ extraNodes: [orphan] });

  const result = await parkMutateAndResume(workflow, { amount: 10 }, {}, () => {
    gateNode.else = 'notify';
    // orphan has no incoming edge at all; its error must still reject the
    // whole pass without publishing gate's new else.
    orphan.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /node orphan points to an unknown destination/);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
});

test('editing then/else with no validation at all leaves the parked run on the accepted exits', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const trueRun = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    // No validateWorkflow call: the run must not re-read the live node.
    gateNode.then = 'notify';
  });
  assert.equal(trueRun.status, 'completed');
  assert.deepEqual(trueRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);

  gateNode.then = 'process';
  const falseRun = await parkMutateAndResume(workflow, { amount: 10 }, {}, () => {
    gateNode.else = 'notify';
  });
  assert.equal(falseRun.status, 'completed');
  assert.deepEqual(falseRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
});

// ── a successful validation still publishes the edited pair ────────────────

test('a successful validation still updates the condition exits of a parked run (existing behavior kept)', async () => {
  const { workflow, gateNode } = branchWorkflow();

  const trueRun = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    gateNode.then = 'notify';
    // Fully valid edit: this pass runs to completion and publishes.
    validateWorkflow(workflow);
  });
  assert.equal(trueRun.status, 'completed');
  assert.deepEqual(trueRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
  assert.deepEqual(Object.keys(trueRun.context.output), ['hold', 'notify']);
  assert.equal(trueRun.context.output.notify, '发送通知');

  const falseRun = await parkMutateAndResume(workflow, { amount: 10 }, {}, () => {
    gateNode.else = 'notify';
    validateWorkflow(workflow);
  });
  assert.equal(falseRun.status, 'completed');
  assert.deepEqual(falseRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
});

test('the accepted pair of one successful validation serves both outcomes of later runs', async () => {
  const { workflow, gateNode } = branchWorkflow();
  // A single successful pass changes both exits; afterwards new runs select
  // between the two newly accepted targets by the condition result only.
  gateNode.then = 'review';
  gateNode.else = 'process';
  validateWorkflow(workflow);

  const operations = { hold: async () => 'held' };
  const trueRun = await executeWorkflowAsync(workflow, { amount: 90 }, operations);
  assert.deepEqual(trueRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
  const falseRun = await executeWorkflowAsync(workflow, { amount: 10 }, operations);
  assert.deepEqual(falseRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
});

test('a failed pass followed by a successful one publishes the accepted exits, not the rejected ones', async () => {
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({ extraNodes: [ghostNode] });

  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    gateNode.then = 'notify';
    ghostNode.next = 'ghost-target';
    assert.throws(() => validateWorkflow(workflow), /unknown destination/);
    // Repair the unrelated definition error while keeping the reroute; the
    // next pass succeeds and publishes the reroute.
    ghostNode.next = 'done';
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
});

test('a new run started after a valid revalidation adopts the edited exits', async () => {
  const { workflow, gateNode } = branchWorkflow();
  gateNode.then = 'notify';
  validateWorkflow(workflow);

  const result = await executeWorkflowAsync(workflow, { amount: 90 }, { hold: async () => 'held' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);
});

// ── invalid definitions and validation-error isolation ─────────────────────

test('a new run from the still-invalid edited condition exits is rejected before any operation runs', async () => {
  const { workflow, gateNode } = branchWorkflow();
  gateNode.then = 'ghost-target';

  let invocations = 0;
  const spying = { hold: async () => { invocations += 1; return 'never'; } };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { amount: 90 }, spying),
    /node gate points to an unknown destination/,
  );
  assert.equal(invocations, 0);
  assert.throws(() => validateWorkflow(workflow), /unknown destination/);
  assert.throws(() => executeWorkflow(workflow, { amount: 90 }), /unknown destination/);
});

test('the standalone validation error never becomes action_failed, an attempt record, or compensation', async () => {
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, gateNode } = branchWorkflow({
    compensate: true, extraNodes: [ghostNode],
  });
  let undoCalls = 0;

  const result = await parkMutateAndResume(
    workflow, { amount: 90 },
    { undo: async () => { undoCalls += 1; return 'undone'; } },
    () => {
      gateNode.then = 'notify';
      gateNode.else = 'notify';
      ghostNode.next = 'ghost-target';
      assert.throws(() => validateWorkflow(workflow), /unknown destination/);
    });

  // The validation error belongs only to the validateWorkflow caller; the
  // parked run still finishes normally along its original then edge.
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
  assert.equal(result.actionAttempts.length, 1);
  assert.equal(result.actionAttempts[0].nodeId, 'hold');
  assert.equal(result.actionAttempts[0].ok, true);
  assert.equal(result.compensationStatus, 'not_needed');
  assert.deepEqual(result.compensationAttempts, []);
  assert.equal(undoCalls, 0);
});

// ── selection semantics are otherwise unchanged ────────────────────────────

test('only the selected exit activates: the unaccepted-at-runtime target never runs even while present in the definition', async () => {
  const { workflow } = branchWorkflow();

  const trueRun = await executeWorkflowAsync(
    workflow, { amount: 90 }, { hold: async () => 'held' });
  assert.deepEqual(trueRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'process', 'done']);
  assert.deepEqual(Object.keys(trueRun.context.output), ['hold', 'process']);

  const falseRun = await executeWorkflowAsync(
    workflow, { amount: 10 }, { hold: async () => 'held' });
  assert.deepEqual(falseRun.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
  assert.deepEqual(Object.keys(falseRun.context.output), ['hold', 'review']);
});

test('pinning the exit does not pin the condition result: the selected exit is still chosen from this run\'s own input', async () => {
  // While the run is parked the condition stays unchanged, but a successful
  // validation moves then to notify; the expression itself still reads the
  // run's input at evaluation time — amount 90 selects the (new) then.
  const { workflow, gateNode } = branchWorkflow();
  const result = await parkMutateAndResume(workflow, { amount: 90 }, {}, () => {
    gateNode.then = 'notify';
    validateWorkflow(workflow);
  });
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'notify', 'done']);

  // Same accepted exits, an input that makes the pinned expression false takes
  // else (still review) — branch targets changed, result computation did not.
  const other = await executeWorkflowAsync(
    workflow, { amount: 10 }, { hold: async () => 'held-2' });
  assert.deepEqual(other.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'review', 'done']);
});
