import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A linear trigger -> end workflow usable by the synchronous entry.
function linearEndWorkflow(endResult) {
  return {
    id: 'linear-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'finish' },
      { id: 'finish', type: 'end', result: endResult },
    ],
  };
}

// A single-end workflow whose end carries a nested approval result. Array
// successors force the "exactly one end node" rule, which is also what lets
// the end run before another activated branch's business action finishes.
function approvalWorkflow(endResult) {
  return {
    id: 'approval',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: endResult },
      { id: 'work', type: 'action', operation: 'work', next: 'finish' },
    ],
  };
}

const approvalPayload = () => ({
  verdict: 'approved',
  approver: { id: 'u-7', name: 'Lee' },
  details: [
    { item: 'keyboard', qty: 2 },
    { item: 'monitor', qty: 1 },
  ],
  flags: { urgent: false, tags: ['finance'] },
});

test('synchronous run returns an independent deep copy of an object end result', () => {
  const workflow = linearEndWorkflow(approvalPayload());
  const first = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');

  // The caller can freely edit fields, add/delete nested properties and
  // change array contents of the value it received.
  first.result.verdict = 'rejected';
  first.result.approver.name = 'Someone Else';
  first.result.details[0].qty = 99;
  first.result.details.push({ item: 'webcam', qty: 3 });
  delete first.result.flags.tags;
  first.result.extra = { nested: [1, 2, 3] };

  // The definition keeps its configured content, nested levels included.
  assert.equal(workflow.nodes[1].result.verdict, 'approved');
  assert.equal(workflow.nodes[1].result.approver.name, 'Lee');
  assert.equal(workflow.nodes[1].result.details[0].qty, 2);
  assert.deepEqual(workflow.nodes[1].result.details.map(d => d.item), ['keyboard', 'monitor']);
  assert.equal(Object.hasOwn(workflow.nodes[1].result.flags, 'tags'), true);
  assert.equal('extra' in workflow.nodes[1].result, false);

  // Re-running the same definition still yields the configured content.
  const second = executeWorkflow(workflow, {});
  assert.deepEqual(second.result, approvalPayload());
  assert.notEqual(second.result, workflow.nodes[1].result);
  assert.notEqual(second.result.details, workflow.nodes[1].result.details);

  // Editing one run's result cannot change another completed run's result.
  first.result.details.length = 0;
  assert.equal(second.result.details.length, 2);
});

test('arrays at the top level and primitive leaves are isolated too', () => {
  const workflow = linearEndWorkflow({ rows: [{ n: 1 }, { n: 2 }] });
  const execution = executeWorkflow(workflow, {});
  execution.result.rows[0].n = 100;
  execution.result.rows.pop();
  assert.deepEqual(workflow.nodes[1].result.rows, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(executeWorkflow(workflow, {}).result.rows, [{ n: 1 }, { n: 2 }]);
});

test('asynchronous run follows the same deep-copy isolation rules', async () => {
  const workflow = approvalWorkflow(approvalPayload());
  const execution = await executeWorkflowAsync(workflow, {}, { work: () => 'done' });
  assert.equal(execution.status, 'completed');

  execution.result.verdict = 'rejected';
  execution.result.details[1].item = 'changed';
  execution.result.flags.tags.push('tampered');

  assert.equal(workflow.nodes[1].result.verdict, 'approved');
  assert.equal(workflow.nodes[1].result.details[1].item, 'monitor');
  assert.deepEqual(workflow.nodes[1].result.flags.tags, ['finance']);

  const another = await executeWorkflowAsync(workflow, {}, { work: () => 'done' });
  assert.deepEqual(another.result, approvalPayload());
  assert.notEqual(another.result, execution.result);
});

test('unset, null and primitive results keep their exact values', async () => {
  const cases = [
    ['absent', undefined, value => assert.equal(value, null)],
    ['null', null, value => assert.equal(value, null)],
    ['empty string', '', value => assert.equal(value, '')],
    ['zero', 0, value => assert.equal(value, 0)],
    ['false', false, value => assert.equal(value, false)],
    ['number', 42, value => assert.equal(value, 42)],
    ['boolean', true, value => assert.equal(value, true)],
  ];
  for (const [label, configured, check] of cases) {
    const workflow = {
      id: `primitive-${label}`,
      entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'done' },
        configured === undefined
          ? { id: 'done', type: 'end' }
          : { id: 'done', type: 'end', result: configured },
      ],
    };
    const sync = executeWorkflow(workflow, {});
    check(sync.result);
  }

  // The asynchronous entry preserves them as well, especially 0 and false.
  for (const configured of [0, false, '']) {
    const workflow = {
      id: 'async-primitives', entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'done' },
        { id: 'done', type: 'end', result: configured },
      ],
    };
    const execution = await executeWorkflowAsync(workflow, {});
    assert.equal(execution.result, configured);
  }
});

test('end result recorded before a waiting branch is immune to definition mutation during the wait', async () => {
  const workflow = {
    id: 'early-end-wait', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: approvalPayload() },
      { id: 'work', type: 'action', operation: 'slow', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      // The end node has already run; mutate the definition's result object
      // while this branch is still waiting.
      setTimeout(() => {
        workflow.nodes[1].result.verdict = 'tampered';
        workflow.nodes[1].result.details[0].item = 'tampered-item';
        workflow.nodes[1].result.details.push({ item: 'late', qty: 9 });
      }, 10);
      await sleep(40);
      return 'done';
    },
  });

  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.result, approvalPayload());
  // The mutation really happened on the definition; only the recorded result
  // was protected.
  assert.equal(workflow.nodes[1].result.verdict, 'tampered');
});

test('an end reached before another branch fails still reports failure and compensates', async () => {
  let compensated = 0;
  const workflow = {
    id: 'early-end-fail', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'work'] },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'finish' },
      { id: 'finish', type: 'end', result: approvalPayload() },
      { id: 'work', type: 'action', operation: 'opB', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: async () => {
      // The end node already ran by the time this branch fails.
      workflow.nodes[2].result.verdict = 'tampered';
      throw new Error('branch failed');
    },
    undoA: () => { compensated += 1; return 'undone'; },
  });

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.equal('result' in execution, false);
  assert.equal(compensated, 1);
  assert.equal(execution.compensationStatus, 'completed');
});

test('an end reached before cancellation still returns cancelled and compensates', async () => {
  const controller = new AbortController();
  let compensated = 0;
  const workflow = {
    id: 'early-end-cancel', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'work'] },
      { id: 'a', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'finish' },
      { id: 'finish', type: 'end', result: approvalPayload() },
      { id: 'work', type: 'action', operation: 'opB', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: async () => {
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      return 'B';
    },
    undoA: () => { compensated += 1; return 'undone'; },
  }, { signal: controller.signal });

  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  assert.equal(compensated, 1);
});

test('a function nested in an end result is a definition error naming the end node', () => {
  const workflow = approvalWorkflow({ verdict: 'approved', save: () => 'nope' });
  assert.throws(
    () => validateWorkflow(workflow),
    /end node finish: result must be a structured-cloneable value/,
  );
});

test('a bare function result and a function inside a nested array are rejected too', () => {
  const bare = {
    id: 'bare-fn', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: () => 'x' },
    ],
  };
  assert.throws(() => validateWorkflow(bare), /end node done/);

  const nested = approvalWorkflow({ rows: [{ ok: true }, { hook: () => 'nope' }] });
  assert.throws(() => validateWorkflow(nested), /end node finish/);
});

test('valid plain objects, arrays and cloneable built-ins are accepted', () => {
  for (const result of [
    approvalPayload(),
    [1, 2, { a: [] }],
    { when: new Date(0), pattern: /ok/, bytes: new Uint8Array([1, 2]) },
  ]) {
    assert.doesNotThrow(() => validateWorkflow(approvalWorkflow(result)));
  }
});

test('all three entries report an uncloneable end result before any node or action runs', async () => {
  const workflow = approvalWorkflow({ verdict: 'approved', save: () => 'nope' });
  let businessCalls = 0;
  const operations = { work: () => { businessCalls += 1; return 'done'; } };

  assert.throws(() => executeWorkflow(workflow, {}), /end node finish/);
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, operations), /end node finish/);
  assert.equal(businessCalls, 0);
});

test('end nodes on branches that never run are still checked', () => {
  const workflow = {
    id: 'untaken-branch', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-end', else: 'bad-end',
      },
      { id: 'good-end', type: 'end', result: 'good' },
      { id: 'bad-end', type: 'end', result: { broken: () => 'nope' } },
    ],
  };
  // Input selects the good branch; the bad end is never visited but still
  // rejected at validation time.
  assert.throws(() => executeWorkflow(workflow, { route: 'good' }), /end node bad-end/);
  assert.throws(() => validateWorkflow(workflow), /end node bad-end/);
});

test('an entry-unreachable end node with an uncloneable result is still checked', () => {
  const workflow = {
    id: 'unreachable-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'orphan-end', type: 'end', result: { fn: () => 'nope' } },
    ],
  };
  assert.throws(() => validateWorkflow(workflow), /end node orphan-end/);
});
