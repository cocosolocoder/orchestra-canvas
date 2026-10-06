import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A business operation that stays pending until the test releases it, plus a
// promise that fires once the engine has actually invoked it (and is therefore
// parked on its await).
function gatedHold(name = 'hold', result = 'p') {
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

// start -> check (vip === true) -> then: priority (business "hold") -> wrap
//                              -> else: standard (message action)  -> wrap
// wrap dependsOn initialDeps -> done. With vip true the run parks inside
// "hold"; "standard" is on the branch never taken, so a wrap that depends on
// it can only end blocked, while a wrap depending on "priority" alone
// completes once the hold resolves. Extra nodes are appended after the end
// node, so their validation happens only after wrap's dependencies were
// already checked.
function blockedWorkflow({ initialDeps, compensable = false, extraNodes = [] } = {}) {
  const wrapNode = { id: 'wrap', type: 'action', dependsOn: initialDeps, next: 'done' };
  const priorityNode = { id: 'priority', type: 'action', operation: 'hold', next: 'wrap' };
  if (compensable) priorityNode.compensation = { operation: 'undo' };
  const workflow = {
    id: 'dependency-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { field: 'vip', operator: 'eq', value: true },
        then: 'priority', else: 'standard',
      },
      priorityNode,
      { id: 'standard', type: 'action', message: 'standard', next: 'wrap' },
      wrapNode,
      { id: 'done', type: 'end', result: 'done' },
      ...extraNodes,
    ],
  };
  return { workflow, wrapNode };
}

// Same topology without a business operation, for the synchronous entry.
function syncBlockedWorkflow(initialDeps) {
  const wrapNode = { id: 'wrap', type: 'action', dependsOn: initialDeps, next: 'done' };
  const workflow = {
    id: 'dependency-isolation-sync', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { field: 'vip', operator: 'eq', value: true },
        then: 'priority', else: 'standard',
      },
      { id: 'priority', type: 'action', message: 'p', next: 'wrap' },
      { id: 'standard', type: 'action', message: 'standard', next: 'wrap' },
      wrapNode,
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  return { workflow, wrapNode };
}

// Park the run inside "hold", run `mutate` while it waits, then resume.
async function parkMutateAndResume(workflow, input, operations, mutate) {
  const hold = gatedHold();
  const merged = { ...hold.operations, ...operations };
  const runPromise = executeWorkflowAsync(workflow, input, merged);
  await hold.started;
  // Let the engine settle onto its await of the pending operation.
  await sleep(5);
  mutate();
  hold.release();
  return runPromise;
}

const VIP = { vip: true };
const IMMEDIATE = { hold: async () => 'p-2' };

test('a parked run keeps the dependency it started with when the property is deleted and the definition is revalidated', async () => {
  const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['standard', 'priority'] });

  const result = await parkMutateAndResume(workflow, VIP, {}, () => {
    // The never-traversed standard branch dependency disappears while the
    // run waits on priority; the revalidation accepts the current definition.
    delete wrapNode.dependsOn;
    validateWorkflow(workflow);
  });

  // The run still accepted the old relation: standard never completes on the
  // untaken exit, so wrap stays waiting and the run ends blocked after every
  // other executable node finished. The waiting node is neither traced nor
  // present in the output.
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'check', 'priority']);
  assert.deepEqual(Object.keys(result.context.output), ['priority']);

  // A later run under the current definition has no dependencies and completes.
  const later = await executeWorkflowAsync(workflow, VIP, IMMEDIATE);
  assert.equal(later.status, 'completed');
  assert.deepEqual(later.trace.map(node => node.nodeId),
    ['start', 'check', 'priority', 'wrap', 'done']);
});

test('a parked run is not blocked by a dependency added while it waited', async () => {
  const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['priority'] });

  const result = await parkMutateAndResume(workflow, VIP, {}, () => {
    // New relation pointing at the untaken branch; accepted for future runs.
    wrapNode.dependsOn = ['standard', 'priority'];
    validateWorkflow(workflow);
  });

  // The parked run accepted "priority only" at its start, so it completes.
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'check', 'priority', 'wrap', 'done']);

  // A later run is held by the newly added dependency and blocks.
  const later = await executeWorkflowAsync(workflow, VIP, IMMEDIATE);
  assert.equal(later.status, 'blocked');
  assert.deepEqual(later.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});

test('replacing the dependsOn array with a different array only affects later runs', async () => {
  const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['standard', 'priority'] });

  const result = await parkMutateAndResume(workflow, VIP, {}, () => {
    wrapNode.dependsOn = [];
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);

  const later = await executeWorkflowAsync(workflow, VIP, IMMEDIATE);
  assert.equal(later.status, 'completed');
});

test('in-place edits of the original dependsOn array cannot alias into a parked run', async () => {
  // Removing an entry in place after the run started.
  {
    const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['standard', 'priority'] });
    const result = await parkMutateAndResume(workflow, VIP, {}, () => {
      wrapNode.dependsOn.splice(wrapNode.dependsOn.indexOf('standard'), 1);
      validateWorkflow(workflow);
    });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  }

  // Adding an entry in place to the array the run started from.
  {
    const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['priority'] });
    const result = await parkMutateAndResume(workflow, VIP, {}, () => {
      wrapNode.dependsOn.push('standard');
      validateWorkflow(workflow);
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.trace.map(node => node.nodeId),
      ['start', 'check', 'priority', 'wrap', 'done']);

    const later = await executeWorkflowAsync(workflow, VIP, IMMEDIATE);
    assert.equal(later.status, 'blocked');
    assert.deepEqual(later.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  }
});

test('going from no dependencies to some only affects runs started afterwards', async () => {
  const { workflow, wrapNode } = blockedWorkflow({ initialDeps: [] });

  const result = await parkMutateAndResume(workflow, VIP, {}, () => {
    wrapNode.dependsOn = ['standard', 'priority'];
    validateWorkflow(workflow);
  });

  // The run started with an empty dependency list, so it still completes.
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'check', 'priority', 'wrap', 'done']);

  // The new relation applies to later runs.
  const later = await executeWorkflowAsync(workflow, VIP, IMMEDIATE);
  assert.equal(later.status, 'blocked');
  assert.deepEqual(later.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});

test('mutating the parked dependency list directly without revalidating never reaches the run', async () => {
  const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['standard', 'priority'] });

  const result = await parkMutateAndResume(workflow, VIP, {}, () => {
    // No validateWorkflow call at all: the run captured its own list at start.
    wrapNode.dependsOn.length = 0;
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});

test('a standalone validateWorkflow alone cannot change a running dependency gate', async () => {
  const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['standard', 'priority'] });
  const definitionSnapshot = JSON.stringify(workflow);

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, VIP, hold.operations);
  await hold.started;
  await sleep(5);

  // Only revalidate; the definition itself is untouched.
  validateWorkflow(workflow);

  hold.release();
  const result = await runPromise;
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  assert.equal(JSON.stringify(workflow), definitionSnapshot);
});

test('a revalidation that fails on a node checked after the dependencies still reports the error and keeps the parked relations', async () => {
  // "ghost" is declared after wrap: this pass normalizes wrap's new
  // dependencies first and only then fails on ghost's unknown successor. The
  // partial pass must neither swallow the error nor publish its checked
  // dependencies to the parked run.
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'done' };
  const { workflow, wrapNode } = blockedWorkflow({
    initialDeps: ['standard', 'priority'], extraNodes: [ghostNode],
  });

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, VIP, hold.operations);
  await hold.started;
  await sleep(5);

  wrapNode.dependsOn = ['priority'];
  ghostNode.next = 'nowhere';
  assert.throws(
    () => validateWorkflow(workflow),
    /node ghost points to an unknown destination/,
  );

  hold.release();
  const result = await runPromise;
  // Old relation set, even though the failed pass had already normalized the
  // new one: the run still ends blocked on the untaken standard branch.
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});

test('a revalidation that fails cycle detection still reports the cycle and keeps the parked relations', async () => {
  const loopA = { id: 'loop-a', type: 'action', message: 'a', next: 'done' };
  const loopB = { id: 'loop-b', type: 'action', message: 'b', next: 'done' };
  const { workflow, wrapNode } = blockedWorkflow({
    initialDeps: ['standard', 'priority'], extraNodes: [loopA, loopB],
  });

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, VIP, hold.operations);
  await hold.started;
  await sleep(5);

  // Change wrap's relation and close a successor cycle between the extras.
  wrapNode.dependsOn = ['priority'];
  loopA.next = 'loop-b';
  loopB.next = 'loop-a';
  assert.throws(() => validateWorkflow(workflow), /cycle is present/);

  hold.release();
  const result = await runPromise;
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});

test('two runs sharing one node set with different dependencies each keep their own, whichever finishes first', async () => {
  async function scenario(releaseOrder) {
    const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['standard', 'priority'] });

    // Each invocation of "hold" gets its own independent gate, in start order.
    const gates = [];
    let nextGate = 0;
    const operations = {
      hold: () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const index = nextGate;
        nextGate += 1;
        gates.push({ release });
        return gate.then(() => `p-${index}`);
      },
    };

    // Run A starts depending on both nodes and parks.
    const runA = executeWorkflowAsync(workflow, VIP, operations);
    while (gates.length < 1) await sleep(1);
    await sleep(5);

    // The shared definition loses the untaken-branch dependency and is
    // independently re-validated.
    wrapNode.dependsOn = ['priority'];
    validateWorkflow(workflow);

    // Run B starts under the new relation and parks too.
    const runB = executeWorkflowAsync(workflow, VIP, operations);
    while (gates.length < 2) await sleep(1);
    await sleep(5);

    if (releaseOrder === 'B-first') {
      gates[1].release();
      gates[0].release();
    } else {
      gates[0].release();
      gates[1].release();
    }

    const [a, b] = await Promise.all([runA, runB]);
    return { a, b };
  }

  for (const order of ['B-first', 'A-first']) {
    const { a, b } = await scenario(order);
    assert.equal(a.status, 'blocked', `A keeps its start-time wait on standard (${order})`);
    assert.deepEqual(a.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }],
      `A blocked details are its own unmet dependency (${order})`);
    assert.equal(b.status, 'completed', `B uses its start-time priority-only relation (${order})`);
    assert.deepEqual(b.trace.map(node => node.nodeId),
      ['start', 'check', 'priority', 'wrap', 'done'], `B trace (${order})`);
  }
});

test('missingDependencies come from the run original unmet deps and follow declaration order', async () => {
  // wrap declares them in scrambled order; "standard" and the unreachable
  // "zetaDep" never complete, while priority (the parked one) does.
  const wrapNode = {
    id: 'wrap', type: 'action',
    dependsOn: ['zetaDep', 'standard', 'priority'], next: 'done',
  };
  const workflow = {
    id: 'ordered-missing', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { field: 'vip', operator: 'eq', value: true },
        then: 'priority', else: 'standard',
      },
      { id: 'priority', type: 'action', operation: 'hold', next: 'wrap' },
      { id: 'standard', type: 'action', message: 'standard', next: 'wrap' },
      // Named by wrap but only reachable as a dependency name: dependencies
      // never activate, so this node never runs.
      { id: 'zetaDep', type: 'action', message: 'zeta', next: 'done' },
      wrapNode,
      { id: 'done', type: 'end', result: 'done' },
    ],
  };

  const result = await parkMutateAndResume(workflow, VIP, {}, () => {
    // Leave only priority while the run waits: neither ordering nor the set
    // the parked run reports may change.
    wrapNode.dependsOn = ['priority'];
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'blocked');
  // Declaration order is standard (index 3) then zetaDep (index 4), not the
  // scrambled dependsOn order; the completed priority is not listed.
  assert.deepEqual(result.blockedNodes, [
    { nodeId: 'wrap', missingDependencies: ['standard', 'zetaDep'] },
  ]);
  // Waiting nodes and never-activated nodes appear neither in trace nor output.
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'check', 'priority']);
  assert.deepEqual(Object.keys(result.context.output), ['priority']);
});

test('a blocked run that kept its start-time dependency still compensates in the existing format', async () => {
  const { workflow, wrapNode } = blockedWorkflow({
    initialDeps: ['standard', 'priority'], compensable: true,
  });

  const result = await parkMutateAndResume(
    workflow, VIP, { undo: () => 'undone' },
    () => {
      wrapNode.dependsOn = ['priority'];
      validateWorkflow(workflow);
    });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  assert.deepEqual(result.context.input, VIP);
  assert.deepEqual(result.context.output, { priority: 'p' });
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'check', 'priority']);
  assert.equal(result.compensationStatus, 'completed');
  assert.deepEqual(
    result.compensationAttempts.map(r => [r.nodeId, r.operation, r.attempt, r.ok, r.result]),
    [['priority', 'undo', 1, true, 'undone']],
  );
});

test('a new execution always checks the current definition: an illegal edited dependsOn fails before any node runs', async () => {
  const { workflow, wrapNode } = blockedWorkflow({ initialDeps: ['standard', 'priority'] });

  // The earlier run starts under the legal relations and parks.
  const hold = gatedHold();
  const runA = executeWorkflowAsync(workflow, VIP, hold.operations);
  await hold.started;
  await sleep(5);

  // The definition is made invalid but never re-validated; the parked run
  // already holds its own legal dependency list.
  wrapNode.dependsOn = ['ghost'];

  // A new run reports the definition error before a single node executes —
  // its "hold" is never invoked — through the async entry, the synchronous
  // entry (its own fresh compile) and standalone validation alike.
  let spyInvocations = 0;
  const spying = { hold: async () => { spyInvocations += 1; return 'never'; } };
  await assert.rejects(
    () => executeWorkflowAsync(workflow, VIP, spying),
    /node wrap depends on an unknown node/,
  );
  assert.equal(spyInvocations, 0);
  assert.throws(() => executeWorkflow(workflow, VIP), /node wrap depends on an unknown node/);
  assert.throws(() => validateWorkflow(workflow), /depends on an unknown node/);

  // The parked run is untouched by the illegal edit and ends blocked as its
  // own start-time relations dictate.
  hold.release();
  const a = await runA;
  assert.equal(a.status, 'blocked');
  assert.deepEqual(a.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});

test('the synchronous entry uses the relations its own compile accepted and never mutates definition or input', () => {
  const { workflow, wrapNode } = syncBlockedWorkflow(['standard', 'priority']);
  const caller = { ...VIP, note: 'keep' };

  const first = executeWorkflow(workflow, caller);
  assert.equal(first.status, 'blocked');
  assert.deepEqual(first.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  assert.deepEqual(first.trace.map(node => node.nodeId), ['start', 'check', 'priority']);

  // Change the definition and revalidate; a fresh synchronous run accepts the
  // new relations and completes.
  wrapNode.dependsOn = ['priority'];
  validateWorkflow(workflow);
  const definitionBeforeSecond = JSON.stringify(workflow);
  const second = executeWorkflow(workflow, caller);
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.trace.map(node => node.nodeId),
    ['start', 'check', 'priority', 'wrap', 'done']);
  // Execution does not mutate the definition or the caller's input.
  assert.equal(JSON.stringify(workflow), definitionBeforeSecond);
  assert.deepEqual(caller, { vip: true, note: 'keep' });

  // And a still-later run picks up a relation added afterwards.
  wrapNode.dependsOn = ['standard', 'priority'];
  const third = executeWorkflow(workflow, caller);
  assert.equal(third.status, 'blocked');
  assert.deepEqual(third.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  // The first result object is unchanged by any later compile or execution.
  assert.equal(first.status, 'blocked');
  assert.deepEqual(first.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});
