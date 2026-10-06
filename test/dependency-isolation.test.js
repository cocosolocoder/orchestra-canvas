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

// start -> hold (business "hold") -> [gate, later]
// gate (declared first) reads later's message output; with dependsOn
// ['later'] it must wait, so later runs first and gate takes "yes". Without
// the dependency gate runs first, sees a missing output and takes "no".
function branchWorkflow(dependsOn) {
  const laterNode = { id: 'later', type: 'action', message: 'ready', next: 'finish' };
  const gateNode = {
    id: 'gate', type: 'condition', dependsOn,
    condition: { outputField: { nodeId: 'later' }, operator: 'eq', value: 'ready' },
    then: 'yes', else: 'no',
  };
  const workflow = {
    id: 'dependency-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      { id: 'hold', type: 'action', operation: 'hold', next: ['gate', 'later'] },
      gateNode,
      laterNode,
      { id: 'yes', type: 'action', message: 'y', next: 'finish' },
      { id: 'no', type: 'action', message: 'n', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };
  return { workflow, gateNode, laterNode };
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

test('removing a downstream dependency while a run is parked cannot make its node run early', async () => {
  // The run starts WITH gate -> dependsOn later, and parks inside hold.
  const { workflow, gateNode } = branchWorkflow(['later']);

  const result = await parkMutateAndResume(workflow, {}, {}, () => {
    // Swap to a brand new empty array and independently re-validate while the
    // earlier run waits for hold.
    gateNode.dependsOn = [];
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // The parked run keeps its start-time dependency: later runs before gate,
  // gate sees "ready" and takes yes.
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'later', 'gate', 'yes', 'finish']);
  assert.equal(result.context.output.later, 'ready');
  assert.equal(result.context.output.yes, 'y');
  assert.ok(!Object.hasOwn(result.context.output, 'no'));

  // A new run against the re-validated definition has no dependency: gate is
  // declared before later, runs first, misses the output and takes no.
  const immediate = { hold: async () => 'held-2' };
  const later = await executeWorkflowAsync(workflow, {}, immediate);
  assert.deepEqual(later.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'later', 'no', 'finish']);
  assert.equal(later.context.output.no, 'n');
});

test('adding a dependency while a run is parked cannot block that run', async () => {
  // The run starts WITHOUT any dependency (gate runs first, output missing).
  const { workflow, gateNode } = branchWorkflow([]);

  const result = await parkMutateAndResume(workflow, {}, {}, () => {
    gateNode.dependsOn = ['later'];
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // Old relations: gate runs before later, misses the output and takes no —
  // the newly added "wait for later" never reaches this run.
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'later', 'no', 'finish']);

  // A new run waits for later as the current definition says.
  const immediate = { hold: async () => 'held-2' };
  const later = await executeWorkflowAsync(workflow, {}, immediate);
  assert.deepEqual(later.trace.map(node => node.nodeId),
    ['start', 'hold', 'later', 'gate', 'yes', 'finish']);
});

test('in-place edits of the original dependsOn array never alias into a parked run', async () => {
  const mutations = [
    gate => { gate.dependsOn.pop(); },
    gate => { gate.dependsOn.length = 0; },
    gate => { gate.dependsOn.splice(0, gate.dependsOn.length); },
    gate => { gate.dependsOn[0] = 'hold'; },
    gate => { delete gate.dependsOn; },
  ];
  for (const mutate of mutations) {
    const { workflow, gateNode } = branchWorkflow(['later']);
    const result = await parkMutateAndResume(workflow, {}, {}, () => {
      mutate(gateNode);
      // Revalidate too: the fresh per-pass list must not replace the run's.
      validateWorkflow(workflow);
    });
    assert.equal(result.status, 'completed', `mutation ${mutate.toString()}`);
    assert.deepEqual(result.trace.map(node => node.nodeId),
      ['start', 'hold', 'later', 'gate', 'yes', 'finish'],
      `mutation ${mutate.toString()}`);
  }
});

test('editing the node without revalidating never reaches a parked run either', async () => {
  const { workflow, gateNode } = branchWorkflow(['later']);
  const result = await parkMutateAndResume(workflow, {}, {}, () => {
    gateNode.dependsOn = []; // no validateWorkflow call
  });
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'later', 'gate', 'yes', 'finish']);
});

test('a revalidation that compiles new dependencies but fails on a later node reports the error and keeps the parked relations', async () => {
  // "ghost" is declared after gate: the failing pass normalizes gate's new
  // (empty) dependency first and only then throws on ghost's unknown
  // successor. The partial pass must be discarded entirely — the parked run
  // keeps waiting on later.
  const ghostNode = { id: 'ghost', type: 'action', message: 'g', next: 'finish' };
  const { workflow, gateNode } = branchWorkflow(['later']);
  workflow.nodes.push(ghostNode);

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;
  await sleep(5);

  gateNode.dependsOn = [];
  ghostNode.next = 'nowhere';
  assert.throws(
    () => validateWorkflow(workflow),
    /node ghost points to an unknown destination/,
  );

  hold.release();
  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'later', 'gate', 'yes', 'finish']);
});

test('a revalidation that fails cycle detection still never leaves its checked dependencies with the parked run', async () => {
  // Original relations: gate waits for later. While parked, adding
  // later -> dependsOn gate creates a gate <-> later cycle, so validation
  // fails. The rejected pass publishes nothing: the old run still sees later
  // with no dependencies and completes; under shared storage the two freshly
  // written lists would deadlock the run into "blocked".
  const { workflow, laterNode } = branchWorkflow(['later']);

  const hold = gatedHold();
  const runPromise = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;
  await sleep(5);

  laterNode.dependsOn = ['gate'];
  assert.throws(() => validateWorkflow(workflow), /cycle is present: gate -> later -> gate/);

  hold.release();
  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'later', 'gate', 'yes', 'finish']);
});

// A workflow whose gate waits on a node no traversed edge ever activates:
// start -> hold -> gate, and ghost is only reachable through nothing.
function blockedWorkflow(dependsOn, { extraDeps = [] } = {}) {
  const gateNode = {
    id: 'gate', type: 'condition', dependsOn,
    condition: { outputField: { nodeId: 'ghost' }, operator: 'eq', value: 'ready' },
    then: 'yes', else: 'no',
  };
  const workflow = {
    id: 'dependency-blocked-isolation', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'hold' },
      { id: 'hold', type: 'action', operation: 'hold', next: 'gate' },
      gateNode,
      { id: 'ghost', type: 'action', message: 'ready', next: 'finish' },
      { id: 'yes', type: 'action', message: 'y', next: 'finish' },
      { id: 'no', type: 'action', message: 'n', next: 'finish' },
      ...extraDeps,
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };
  return { workflow, gateNode };
}

test('removing a dependency on a never-activated node while parked still blocks the old run', async () => {
  const { workflow, gateNode } = blockedWorkflow(['ghost']);

  const result = await parkMutateAndResume(workflow, {}, {}, () => {
    delete gateNode.dependsOn;
    validateWorkflow(workflow);
  });

  // The old run accepted the wait: after every other executable node
  // finishes it still returns blocked, naming the original dependency. The
  // waiting gate is absent from trace and output.
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'gate', missingDependencies: ['ghost'] }]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'hold']);
  assert.deepEqual({ ...result.context.output }, { hold: 'held' });

  // A new run under the current definition completes.
  const immediate = { hold: async () => 'held-2' };
  const later = await executeWorkflowAsync(workflow, {}, immediate);
  assert.equal(later.status, 'completed');
  assert.deepEqual(later.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'no', 'finish']);
});

test('adding a dependency on a never-activated node while parked cannot block the old run', async () => {
  const { workflow, gateNode } = blockedWorkflow([]);

  const result = await parkMutateAndResume(workflow, {}, {}, () => {
    gateNode.dependsOn = ['ghost'];
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'completed');
  // The old run had no dependency: gate runs, the ghost output is missing,
  // the run takes no and completes.
  assert.deepEqual(result.trace.map(node => node.nodeId),
    ['start', 'hold', 'gate', 'no', 'finish']);

  // A new run under the changed definition blocks.
  const immediate = { hold: async () => 'held-2' };
  const later = await executeWorkflowAsync(workflow, {}, immediate);
  assert.equal(later.status, 'blocked');
  assert.deepEqual(later.blockedNodes, [{ nodeId: 'gate', missingDependencies: ['ghost'] }]);
});

test('blockedNodes missingDependencies keep the run original set and names, in nodes declaration order', async () => {
  // gate lists zzz before aaa; both are never activated and declared aaa
  // first, so missingDependencies must read [aaa, zzz] regardless of the
  // dependsOn order or a later revalidation that swaps the list.
  const aaaNode = { id: 'aaa', type: 'action', message: 'a', next: 'finish' };
  const zzzNode = { id: 'zzz', type: 'action', message: 'z', next: 'finish' };
  const otherNode = { id: 'other', type: 'action', message: 'o', next: 'finish' };
  const { workflow, gateNode } = blockedWorkflow(['zzz', 'aaa'], {
    extraDeps: [aaaNode, zzzNode, otherNode],
  });

  const result = await parkMutateAndResume(workflow, {}, {}, () => {
    // Reverse the original entries and point at a different never-activated
    // node; the parked run's blocked report must not move.
    gateNode.dependsOn = ['other'];
    validateWorkflow(workflow);
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockedNodes, [
    { nodeId: 'gate', missingDependencies: ['aaa', 'zzz'] },
  ]);
  assert.deepEqual(result.trace.map(node => node.nodeId), ['start', 'hold']);
});

test('two runs sharing one node object with different dependencies stay isolated whichever run finishes first', async () => {
  async function scenario(releaseOrder) {
    // Run A starts WITH the dependency (later first -> gate takes yes).
    const { workflow, gateNode } = branchWorkflow(['later']);

    const gates = [];
    let nextGate = 0;
    const operations = {
      hold: () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const index = nextGate;
        nextGate += 1;
        gates.push({ release });
        return gate.then(() => `held-${index}`);
      },
    };

    const runA = executeWorkflowAsync(workflow, {}, operations);
    while (gates.length < 1) await sleep(1);
    await sleep(5);

    // The shared definition drops the dependency and is re-validated.
    gateNode.dependsOn = [];
    validateWorkflow(workflow);

    // Run B starts WITHOUT it (gate first -> gate takes no).
    const runB = executeWorkflowAsync(workflow, {}, operations);
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
    assert.equal(a.status, 'completed', `A completes (${order})`);
    assert.deepEqual(a.trace.map(node => node.nodeId),
      ['start', 'hold', 'later', 'gate', 'yes', 'finish'], `A waits as it accepted at start (${order})`);
    assert.equal(b.status, 'completed', `B completes (${order})`);
    assert.deepEqual(b.trace.map(node => node.nodeId),
      ['start', 'hold', 'gate', 'later', 'no', 'finish'], `B uses the dependency-free definition (${order})`);
  }
});

test('a new execution still validates the current dependencies before any node runs', async () => {
  const { workflow, gateNode } = branchWorkflow(['later']);

  // Park a legal run.
  const hold = gatedHold();
  const runA = executeWorkflowAsync(workflow, {}, hold.operations);
  await hold.started;
  await sleep(5);

  let invocations = 0;
  const spying = { hold: async () => { invocations += 1; return 'never'; } };

  // Non-array dependsOn.
  gateNode.dependsOn = 'later';
  assert.throws(() => validateWorkflow(workflow), /node gate: dependsOn must be an array/);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, spying),
    /node gate: dependsOn must be an array/,
  );
  assert.throws(() => executeWorkflow(workflow, {}), /node gate: dependsOn must be an array/);

  // Unknown dependency target.
  gateNode.dependsOn = ['nope'];
  assert.throws(() => validateWorkflow(workflow), /node gate depends on an unknown node/);
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, spying),
    /node gate depends on an unknown node/,
  );

  // Duplicate dependency.
  gateNode.dependsOn = ['later', 'later'];
  assert.throws(() => validateWorkflow(workflow), /node gate: duplicate dependency later/);

  assert.equal(invocations, 0, 'no new run ever invokes an operation');

  // The parked run keeps its original, legal relations and finishes.
  hold.release();
  const a = await runA;
  assert.equal(a.status, 'completed');
  assert.deepEqual(a.trace.map(node => node.nodeId),
    ['start', 'hold', 'later', 'gate', 'yes', 'finish']);
});
