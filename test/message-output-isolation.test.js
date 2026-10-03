import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A linear trigger -> message action -> end workflow for the synchronous
// entry and plain asynchronous runs.
function messageWorkflow(message) {
  return {
    id: 'message-linear',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'notice' },
      { id: 'notice', type: 'action', message, next: 'finish' },
      { id: 'finish', type: 'end', result: 'done' },
    ],
  };
}

const payload = () => ({
  status: 'ready',
  meta: { id: 'm-1', n: 1 },
  tags: ['finance', 'ops'],
  rows: [{ q: 1 }, { q: 2 }],
});

test('synchronous run stores an independent deep copy of an object message', () => {
  const workflow = messageWorkflow(payload());
  const first = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');

  // Edit nested fields, add/delete properties and change array members of the
  // output the caller received.
  first.context.output.notice.status = 'changed';
  first.context.output.notice.meta.n = 99;
  first.context.output.notice.tags[0] = 'tampered';
  first.context.output.notice.tags.push('late');
  first.context.output.notice.rows.pop();
  delete first.context.output.notice.meta.id;
  first.context.output.notice.added = { deep: [1] };

  // The definition keeps exactly the configured content.
  assert.equal(workflow.nodes[1].message.status, 'ready');
  assert.equal(workflow.nodes[1].message.meta.n, 1);
  assert.equal(workflow.nodes[1].message.meta.id, 'm-1');
  assert.deepEqual(workflow.nodes[1].message.tags, ['finance', 'ops']);
  assert.deepEqual(workflow.nodes[1].message.rows.map(r => r.q), [1, 2]);
  assert.equal('added' in workflow.nodes[1].message, false);

  // A second run yields the configured content in fresh objects.
  const second = executeWorkflow(workflow, {});
  assert.deepEqual(second.context.output.notice, payload());
  assert.notEqual(second.context.output.notice, workflow.nodes[1].message);
  assert.notEqual(second.context.output.notice.meta, workflow.nodes[1].message.meta);
  assert.notEqual(second.context.output.notice.rows, workflow.nodes[1].message.rows);

  // Editing one returned run cannot reach another returned run.
  first.context.output.notice.tags.length = 0;
  assert.equal(second.context.output.notice.tags.length, 2);
});

test('top-level array messages and their members are isolated too', () => {
  const workflow = messageWorkflow([{ a: 1 }, { b: [2] }]);
  const execution = executeWorkflow(workflow, {});
  execution.context.output.notice[0].a = 100;
  execution.context.output.notice[1].b.push(3);
  execution.context.output.notice.length = 0;
  assert.deepEqual(workflow.nodes[1].message, [{ a: 1 }, { b: [2] }]);
  assert.deepEqual(executeWorkflow(workflow, {}).context.output.notice, [{ a: 1 }, { b: [2] }]);
});

test('asynchronous run follows the same deep-copy isolation rules', async () => {
  const workflow = messageWorkflow(payload());
  const execution = await executeWorkflowAsync(workflow, {});
  assert.equal(execution.status, 'completed');
  // Legacy message actions leave no business attempt records.
  assert.deepEqual(execution.actionAttempts, []);

  execution.context.output.notice.status = 'changed';
  execution.context.output.notice.meta.n = 99;
  execution.context.output.notice.rows[1].q = 50;
  execution.context.output.notice.tags.push('late');

  assert.equal(workflow.nodes[1].message.status, 'ready');
  assert.equal(workflow.nodes[1].message.meta.n, 1);
  assert.equal(workflow.nodes[1].message.rows[1].q, 2);
  assert.deepEqual(workflow.nodes[1].message.tags, ['finance', 'ops']);

  const another = await executeWorkflowAsync(workflow, {});
  assert.deepEqual(another.context.output.notice, payload());
  assert.notEqual(another.context.output.notice, execution.context.output.notice);
});

test('two concurrent asynchronous runs keep independent message outputs', async () => {
  const workflow = messageWorkflow(payload());
  const [first, second] = await Promise.all([
    executeWorkflowAsync(workflow, {}),
    executeWorkflowAsync(workflow, {}),
  ]);
  first.context.output.notice.meta.n = 111;
  first.context.output.notice.tags.push('only-here');
  assert.equal(second.context.output.notice.meta.n, 1);
  assert.deepEqual(second.context.output.notice.tags, ['finance', 'ops']);
  assert.equal(workflow.nodes[1].message.meta.n, 1);
});

test('unset, undefined and null messages keep the action:<id> default; "", 0 and false survive', () => {
  const cases = [
    ['absent', 'absent'],
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['zero', 0],
    ['false', false],
  ];
  for (const [label, configured] of cases) {
    const workflow = {
      id: `primitive-${label}`,
      entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'notice' },
        configured === 'absent'
          ? { id: 'notice', type: 'action', next: 'finish' }
          : { id: 'notice', type: 'action', message: configured, next: 'finish' },
        { id: 'finish', type: 'end', result: 'done' },
      ],
    };
    const sync = executeWorkflow(workflow, {});
    const expected = configured === 'absent' || configured === undefined || configured === null
      ? 'action:notice'
      : configured;
    assert.equal(sync.context.output.notice, expected, label);
    assert.equal(Object.hasOwn(sync.context.output, 'notice'), true);
  }

  // Structured-cloneable built-ins round-trip as independent copies.
  const builtins = messageWorkflow({ when: new Date(0), pattern: /ok/, bytes: new Uint8Array([1, 2]) });
  const run = executeWorkflow(builtins, {});
  assert.ok(run.context.output.notice.when instanceof Date);
  assert.notEqual(run.context.output.notice.when, builtins.nodes[1].message.when);
  assert.ok(run.context.output.notice.pattern instanceof RegExp);
  assert.deepEqual([...run.context.output.notice.bytes], [1, 2]);
});

// A single-end workflow in which the message action completes first while a
// business action on another activated branch is still waiting; a condition
// after the wait reads the message action's saved value. Array successors
// force the one-end rule.
function waitWorkflow() {
  return {
    id: 'message-wait',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['notice', 'work'] },
      { id: 'notice', type: 'action', message: payload(), next: 'check' },
      { id: 'work', type: 'action', operation: 'slow', next: 'finish' },
      {
        id: 'check', type: 'condition',
        condition: { outputField: { nodeId: 'notice', path: 'meta.n' }, operator: 'gte', value: 1 },
        then: 'finish', else: 'wrong',
      },
      { id: 'wrong', type: 'action', message: 'wrong-branch', next: 'finish' },
      { id: 'finish', type: 'end', result: 'ok' },
    ],
  };
}

// Returns the definition node (by id) so the waiting operation can mutate the
// definition's original message internals while the run is suspended.
function nodeById(workflow, id) {
  return workflow.nodes.find(node => node.id === id);
}

test('a saved message output and later condition reads survive definition mutation during a wait', async () => {
  const workflow = waitWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      // The notice action has already run; tamper with the definition's
      // message object while this branch is still waiting.
      setTimeout(() => {
        const message = nodeById(workflow, 'notice').message;
        message.meta.n = 0; // would flip the gte condition had it read live
        message.status = 'tampered';
        message.tags.push('late');
        message.rows[0].q = 999;
        delete message.meta.id;
      }, 10);
      await sleep(40);
      return 'done';
    },
  });

  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'ok');
  // The condition read the value frozen at the notice action's execution.
  assert.equal('wrong' in execution.context.output, false);
  assert.deepEqual(execution.context.output.notice, payload());
  // The tamper really landed on the definition; only the saved copy was safe.
  assert.equal(nodeById(workflow, 'notice').message.meta.n, 0);
  assert.equal(nodeById(workflow, 'notice').message.status, 'tampered');
});

test('a failed run after the wait still returns the frozen message output', async () => {
  const workflow = waitWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      setTimeout(() => {
        const message = nodeById(workflow, 'notice').message;
        message.meta.n = 0;
        message.tags.length = 0;
      }, 10);
      await sleep(40);
      throw new Error('branch failed');
    },
  });

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.deepEqual(execution.context.output.notice, payload());
});

test('a bare function message is a definition error naming the action node', () => {
  assert.throws(
    () => validateWorkflow(messageWorkflow(() => 'nope')),
    /action node notice: message must be a structured-cloneable value/,
  );
});

test('functions nested in message objects and arrays are rejected too', () => {
  assert.throws(
    () => validateWorkflow(messageWorkflow({ nested: { save: () => 'nope' } })),
    /action node notice: message must be a structured-cloneable value/,
  );
  assert.throws(
    () => validateWorkflow(messageWorkflow([1, { hook: () => 'nope' }])),
    /action node notice/,
  );
  assert.throws(
    () => validateWorkflow(messageWorkflow([() => 'nope'])),
    /action node notice/,
  );
});

test('all three entries reject an uncloneable message before any node or action runs', async () => {
  const workflow = messageWorkflow({ save: () => 'nope' });
  let businessCalls = 0;
  const operations = { work: () => { businessCalls += 1; return 'done'; } };

  assert.throws(() => executeWorkflow(workflow, {}), /action node notice/);
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, operations), /action node notice/);
  assert.equal(businessCalls, 0);
});

test('message actions on untaken branches and entry-unreachable nodes are still checked', () => {
  const untaken = {
    id: 'untaken-message', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-end', else: 'bad-message',
      },
      { id: 'good-end', type: 'end', result: 'good' },
      { id: 'bad-message', type: 'action', message: { fn: () => 'nope' }, next: 'good-end' },
    ],
  };
  // Input takes the good branch; bad-message never runs but is still rejected.
  assert.throws(() => executeWorkflow(untaken, { route: 'good' }), /action node bad-message/);
  assert.throws(() => validateWorkflow(untaken), /action node bad-message/);

  const unreachable = {
    id: 'unreachable-message', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'finish' },
      { id: 'finish', type: 'end', result: 'ok' },
      { id: 'orphan', type: 'action', message: () => 'nope', next: 'finish' },
    ],
  };
  assert.throws(() => validateWorkflow(unreachable), /action node orphan/);
});

test('an operation action is not rejected for an unused uncloneable message and keeps the operation output', async () => {
  const workflow = {
    id: 'operation-with-message', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'charge', message: { unused: () => 'nope' }, next: 'finish' },
      { id: 'finish', type: 'end', result: 'done' },
    ],
  };
  assert.doesNotThrow(() => validateWorkflow(workflow));
  const execution = await executeWorkflowAsync(workflow, {}, { charge: () => ({ ok: true }) });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.output.work, { ok: true });
});

test('dotted ids and a __proto__ id keep object messages under their full node id', async () => {
  const dotted = {
    id: 'dotted-message', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'notice.letter' },
      { id: 'notice.letter', type: 'action', message: payload(), next: 'finish' },
      { id: 'finish', type: 'end', result: 'done' },
    ],
  };
  const dottedRun = executeWorkflow(dotted, {});
  assert.deepEqual(dottedRun.context.output['notice.letter'], payload());
  dottedRun.context.output['notice.letter'].meta.n = 5;
  assert.equal(dotted.nodes[1].message.meta.n, 1);

  const protoWorkflow = {
    id: 'proto-message', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', message: payload(), next: 'finish' },
      { id: 'finish', type: 'end', result: 'done' },
    ],
  };
  const syncRun = executeWorkflow(protoWorkflow, {});
  assert.equal(Object.hasOwn(syncRun.context.output, '__proto__'), true);
  assert.deepEqual(syncRun.context.output['__proto__'], payload());
  assert.equal(JSON.stringify(syncRun.context.output).startsWith('{"__proto__":'), true);
  syncRun.context.output['__proto__'].tags.push('x');
  assert.deepEqual(protoWorkflow.nodes[1].message.tags, ['finance', 'ops']);

  const asyncRun = await executeWorkflowAsync(protoWorkflow, {});
  assert.deepEqual(asyncRun.context.output['__proto__'], payload());
});
