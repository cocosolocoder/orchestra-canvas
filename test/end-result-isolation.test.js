import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A trigger leading straight to an end node carrying the given result.
function endWorkflow(result, { withResultKey = true } = {}) {
  const end = { id: 'done', type: 'end' };
  if (withResultKey) end.result = result;
  return {
    id: 'end-result',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      end,
    ],
  };
}

// The approval-shaped payload used across the isolation tests: nested objects
// and arrays, each of which used to be shared by reference with the definition.
const approvalResult = () => ({
  verdict: 'approved',
  detail: { approver: { name: 'Ada' }, flags: { urgent: false } },
  items: [{ id: 1, lines: [{ sku: 'a' }] }, { id: 2, lines: [] }],
  tags: ['finance'],
});

function approvalWorkflow() {
  return endWorkflow(approvalResult());
}

test('the synchronous entry hands back an independently owned deep copy', () => {
  const workflow = approvalWorkflow();
  const result = executeWorkflow(workflow).result;

  // The caller can freely edit the returned value at every nesting level.
  result.verdict = 'rejected';
  result.detail.approver.name = 'Grace';
  delete result.detail.flags.urgent;
  result.detail.newProp = { deep: [1, 2, { three: 3 }] };
  result.items[0].id = 99;
  result.items[0].lines[0].sku = 'b';
  result.items[0].lines.push({ sku: 'c' });
  result.items.push({ id: 3, lines: [] });
  result.tags.length = 0;

  // The workflow definition keeps its configured content.
  assert.deepEqual(workflow.nodes[1].result, approvalResult());

  // A later run of the same definition gets the configured content again.
  assert.deepEqual(executeWorkflow(workflow).result, approvalResult());
});

test('separate synchronous runs never share end result objects or arrays', () => {
  const workflow = approvalWorkflow();
  const first = executeWorkflow(workflow).result;
  const second = executeWorkflow(workflow).result;

  first.items[0].id = 100;
  first.detail.approver.name = 'Mallory';
  first.tags.push('injected');

  assert.notEqual(first, second);
  assert.notEqual(first.items, second.items);
  assert.notEqual(first.detail, second.detail);
  assert.deepEqual(second, approvalResult());
});

test('the asynchronous entry applies the same deep isolation rules', async () => {
  const workflow = approvalWorkflow();
  const execution = await executeWorkflowAsync(workflow);
  assert.equal(execution.status, 'completed');

  execution.result.items[0].lines[0].sku = 'changed';
  execution.result.detail.approver.name = 'changed';
  execution.result.tags.push('x');

  assert.deepEqual(workflow.nodes[1].result, approvalResult());
  assert.deepEqual((await executeWorkflowAsync(workflow)).result, approvalResult());
});

test('separate asynchronous runs never share end result objects or arrays', async () => {
  const workflow = approvalWorkflow();
  const [first, second] = await Promise.all([
    executeWorkflowAsync(workflow),
    executeWorkflowAsync(workflow),
  ]);

  first.result.items[0].id = 100;
  first.result.detail.flags.urgent = true;
  assert.deepEqual(second.result, approvalResult());
});

test('a returned result stays writable rather than being frozen', () => {
  const result = executeWorkflow(approvalWorkflow()).result;
  assert.doesNotThrow(() => {
    result.verdict = 'edited';
    result.items[0].id = 5;
    result.detail.approver.age = 40;
  });
  assert.equal(result.verdict, 'edited');
});

test('missing or null results become null and primitive values are preserved verbatim', () => {
  const cases = [
    ['absent result key', endWorkflow(undefined, { withResultKey: false }), null],
    ['explicit null', endWorkflow(null), null],
    ['number zero', endWorkflow(0), 0],
    ['false boolean', endWorkflow(false), false],
    ['empty string', endWorkflow(''), ''],
    ['ordinary number', endWorkflow(42), 42],
    ['true boolean', endWorkflow(true), true],
    ['non-empty string', endWorkflow('approved'), 'approved'],
  ];
  for (const [label, workflow, expected] of cases) {
    const execution = executeWorkflow(workflow);
    assert.equal(execution.status, 'completed', label);
    assert.equal(execution.result, expected, label);
    // null/primitive results are also independent values with no shared state.
    if (typeof expected === 'object') {
      assert.equal(execution.result, null);
    }
  }
});

test('an end result configured as null stays null even when other branches run', async () => {
  const workflow = {
    id: 'null-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'step', next: 'done' },
      { id: 'done', type: 'end', result: null },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, { step: () => ({ ok: 1 }) });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, null);
});

test('legal object and array results are accepted and copied', () => {
  for (const result of [{}, [], { a: [1, 2, { b: null }] }, [[[]]], { '': 0 }]) {
    assert.doesNotThrow(() => validateWorkflow(endWorkflow(result)));
    assert.deepEqual(executeWorkflow(endWorkflow(result)).result, result);
  }
});

test('validation never mutates a configured end result', () => {
  const workflow = approvalWorkflow();
  validateWorkflow(workflow);
  assert.deepEqual(workflow.nodes[1].result, approvalResult());
});

test('an end result containing a function is a definition error naming the node and reason', () => {
  const cases = [
    ['bare function', () => {}],
    ['function nested in an object', { verdict: 'ok', handler() {} }],
    ['function nested deep in an object', { a: { b: [{ c: () => {} }] } }],
    ['function nested in an array', [1, 2, () => {}]],
    ['promise', Promise.resolve()],
    ['symbol', Symbol('s')],
  ];
  for (const [label, result] of cases) {
    const workflow = endWorkflow(result);
    assert.throws(
      () => validateWorkflow(workflow),
      error => /end node done/.test(error.message)
        && /structured-clon|cloned/i.test(error.message),
      label,
    );
  }
});

test('all three entries reject an uncloneable result before any node or action runs', async () => {
  let actionCalls = 0;
  const workflow = {
    id: 'early-reject',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'step', next: 'done' },
      { id: 'done', type: 'end', result: { payload() {} } },
    ],
  };
  const operations = { step: () => { actionCalls += 1; return 'ran'; } };

  assert.throws(() => validateWorkflow(workflow), /end node done/);
  assert.throws(() => executeWorkflow(workflow), /end node done/);
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, operations), /end node done/);
  assert.equal(actionCalls, 0);
});

test('uncloneable results are checked even on an untaken condition branch', async () => {
  let actionCalls = 0;
  const workflow = {
    id: 'dormant-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-end', else: 'bad-end',
      },
      { id: 'good-end', type: 'end', result: 'good' },
      { id: 'bad-end', type: 'end', result: { boom: () => {} } },
    ],
  };
  // Execution always takes the good branch; the bad end must still be rejected.
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'good' }, {
      step: () => { actionCalls += 1; },
    }),
    /end node bad-end/,
  );
  assert.equal(actionCalls, 0);
  assert.throws(() => executeWorkflow({ ...workflow }, { route: 'good' }), /end node bad-end/);
});

test('uncloneable results are checked even on an entry-unreachable end node', () => {
  const workflow = {
    id: 'unreachable-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'ghost-end', type: 'end', result: [() => {}] },
    ],
  };
  assert.throws(() => validateWorkflow(workflow), /end node ghost-end/);
});

function earlyEndWorkflow(result) {
  // The trigger forks: the end node (declared first) is reached before the
  // still-running business action on the other branch.
  return {
    id: 'early-end',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: result ?? approvalResult() },
      { id: 'work', type: 'action', operation: 'slow', next: 'finish' },
    ],
  };
}

test('an async run keeps the end content as it was when the end node executed', async () => {
  const workflow = earlyEndWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      await sleep(10);
      // While this branch is still pending, mutate the definition's own
      // result object: the already-recorded end result must not move.
      workflow.nodes[1].result.verdict = 'tampered';
      workflow.nodes[1].result.items[0].id = 999;
      workflow.nodes[1].result.items.push({ id: 4, lines: [] });
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.result, approvalResult());
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'finish', 'work']);
});

test('a failing branch after the end node still yields action_failed without a success result', async () => {
  const workflow = earlyEndWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: () => { throw new Error('branch boom'); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.equal('result' in execution, false);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'finish', 'work']);
  assert.equal(execution.compensationStatus, 'not_needed');
});

test('a failing branch after the end node is still compensated under the usual rules', async () => {
  const workflow = {
    id: 'early-end-compensate',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'book'] },
      { id: 'finish', type: 'end', result: { ok: true } },
      {
        id: 'book', type: 'action', operation: 'reserve',
        compensation: { operation: 'release' }, next: 'explode',
      },
      { id: 'explode', type: 'action', operation: 'fail', next: 'finish' },
    ],
  };
  const calls = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    reserve: () => { calls.push('reserve'); return 'seat'; },
    fail: () => { throw new Error('boom'); },
    release: () => { calls.push('release'); return 'freed'; },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'explode');
  assert.equal('result' in execution, false);
  assert.deepEqual(calls, ['reserve', 'release']);
  assert.equal(execution.compensationStatus, 'completed');
});

test('cancellation after the end node returns cancelled, never the recorded success result', async () => {
  const controller = new AbortController();
  const workflow = earlyEndWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      setTimeout(() => controller.abort(), 10);
      await sleep(30);
      return 'done';
    },
  }, { signal: controller.signal });
  assert.equal(execution.status, 'cancelled');
  assert.equal('result' in execution, false);
  assert.ok(execution.trace.some(n => n.nodeId === 'finish'));
});

test('two interleaved async runs keep independent early-end snapshots', async () => {
  const workflow = earlyEndWorkflow();
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = executeWorkflowAsync(workflow, {}, {
    slow: async () => { await firstGate; return 1; },
  });
  // Let the first run reach its end node and park on the pending action.
  await sleep(10);
  const second = await executeWorkflowAsync(workflow, {}, {
    slow: async () => { await sleep(5); return 2; },
  });
  releaseFirst();
  const firstResult = (await first).result;

  firstResult.items[0].id = 777;
  firstResult.verdict = 'first-only';
  assert.deepEqual(second.result, approvalResult());
});
