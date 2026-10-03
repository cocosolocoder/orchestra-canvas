import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A trigger -> legacy message action -> end workflow usable by the
// synchronous entry.
function linearMessageWorkflow(message, { omit = false } = {}) {
  return {
    id: 'linear-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      omit
        ? { id: 'note', type: 'action', next: 'done' }
        : { id: 'note', type: 'action', message, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

const messagePayload = () => ({
  score: 80,
  reviewer: { id: 'u-7', name: 'Lee' },
  tags: ['finance', { when: new Date(0) }],
  flags: { urgent: false, rows: [1, 2] },
});

test('synchronous run returns an independent deep copy of an object message', () => {
  const workflow = linearMessageWorkflow(messagePayload());
  const first = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');
  const output = first.context.output;

  // The caller can freely edit nested fields, add/delete properties and
  // change array members of the output it received.
  output.note.score = 10;
  output.note.reviewer.name = 'Someone Else';
  output.note.tags[0] = 'tampered';
  output.note.tags.push('late');
  delete output.note.flags.rows;
  output.note.added = { nested: [1, 2, 3] };

  // The definition keeps its configured message, nested levels included.
  assert.equal(workflow.nodes[1].message.score, 80);
  assert.equal(workflow.nodes[1].message.reviewer.name, 'Lee');
  assert.equal(workflow.nodes[1].message.tags[0], 'finance');
  assert.equal(workflow.nodes[1].message.tags.length, 2);
  assert.equal(Object.hasOwn(workflow.nodes[1].message.flags, 'rows'), true);
  assert.equal('added' in workflow.nodes[1].message, false);

  // Re-running the same definition still yields the configured content.
  const second = executeWorkflow(workflow, {});
  assert.deepEqual(second.context.output.note, messagePayload());
  assert.notEqual(second.context.output.note, workflow.nodes[1].message);
  assert.notEqual(second.context.output.note.reviewer, workflow.nodes[1].message.reviewer);

  // Editing one run's output cannot change another completed run's output.
  first.context.output.note.flags.rows = [];
  assert.deepEqual(second.context.output.note.flags.rows, [1, 2]);
});

test('an array message and nested arrays are isolated per run too', () => {
  const workflow = linearMessageWorkflow([{ n: 1 }, { n: 2 }]);
  const first = executeWorkflow(workflow, {});
  first.context.output.note[0].n = 100;
  first.context.output.note.pop();
  assert.deepEqual(workflow.nodes[1].message, [{ n: 1 }, { n: 2 }]);
  const second = executeWorkflow(workflow, {});
  assert.deepEqual(second.context.output.note, [{ n: 1 }, { n: 2 }]);
  assert.notEqual(second.context.output.note, first.context.output.note);
});

test('the asynchronous entry gives its run an equally independent copy', async () => {
  const workflow = linearMessageWorkflow(messagePayload());
  const execution = await executeWorkflowAsync(workflow, {});
  assert.equal(execution.status, 'completed');

  execution.context.output.note.score = 1;
  execution.context.output.note.tags.length = 0;

  assert.equal(workflow.nodes[1].message.score, 80);
  assert.equal(workflow.nodes[1].message.tags.length, 2);

  const another = await executeWorkflowAsync(workflow, {});
  assert.deepEqual(another.context.output.note, messagePayload());
  assert.notEqual(another.context.output.note, execution.context.output.note);
});

test('unset, undefined and null messages default to action:<node id>; "", 0 and false survive', async () => {
  const cases = [
    ['absent', 'omit', `action:note`],
    ['undefined', undefined, `action:note`],
    ['null', null, `action:note`],
    ['empty string', '', ''],
    ['zero', 0, 0],
    ['false', false, false],
    ['number', 42, 42],
    ['boolean', true, true],
  ];
  for (const [label, configured, expected] of cases) {
    const workflow = linearMessageWorkflow(configured, { omit: label === 'absent' });
    const sync = executeWorkflow(workflow, {});
    assert.equal(sync.context.output.note, expected, `sync ${label}`);

    const asynced = await executeWorkflowAsync(workflow, {});
    assert.equal(asynced.context.output.note, expected, `async ${label}`);
  }
});

test('structured messages keep working with dotted ids and a __proto__ node id', () => {
  const workflow = {
    id: 'special-message-id',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: '__proto__' },
      { id: '__proto__', type: 'action', message: { inner: { v: 1 } }, next: 'a.b' },
      { id: 'a.b', type: 'action', message: [1, { x: 2 }], next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const run = executeWorkflow(workflow, {});
  assert.deepEqual(run.context.output['__proto__'], { inner: { v: 1 } });
  assert.deepEqual(run.context.output['a.b'], [1, { x: 2 }]);
  assert.deepEqual(Object.keys(run.context.output).sort(), ['__proto__', 'a.b']);

  run.context.output['__proto__'].inner.v = 99;
  assert.deepEqual(workflow.nodes[1].message, { inner: { v: 1 } });
  assert.equal(JSON.stringify(run.context.output['a.b']), '[1,{"x":2}]');
});

test('message actions stay out of business attempts and compensation', async () => {
  let compensated = 0;
  const workflow = {
    id: 'message-trace',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      { id: 'note', type: 'action', message: messagePayload(), next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {});
  assert.deepEqual(run.actionAttempts, []);
  assert.equal(run.compensationStatus, 'not_needed');
  assert.deepEqual(run.compensationAttempts, []);
  assert.deepEqual(run.trace.map(n => `${n.nodeId}:${n.type}`), [
    'start:trigger', 'note:action', 'done:end',
  ]);
  assert.equal(compensated, 0);
});

test('later conditions and business actions read the executed-moment copy', async () => {
  const seenByOperation = [];
  const workflow = {
    id: 'snapshot-reads',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      { id: 'note', type: 'action', message: messagePayload(), next: 'work' },
      { id: 'work', type: 'action', operation: 'consume', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { outputField: { nodeId: 'note', path: 'score' }, operator: 'gte', value: 80 },
        then: 'pass', else: 'fail',
      },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    consume: (input, output) => {
      seenByOperation.push(structuredClone(output.note));
      output.note.score = 0;
      return 'consumed';
    },
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.result, 'passed');
  assert.deepEqual(seenByOperation[0], messagePayload());
  // The operation only saw a copy: the stored message output is unchanged.
  assert.equal(run.context.output.note.score, 80);
  // The caller input is never touched by a message action.
  assert.deepEqual(run.context.input, {});
});

test('mutating the definition message while a later business action is in flight cannot change the saved output', async () => {
  const workflow = {
    id: 'mutate-during-wait',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'note' },
      { id: 'note', type: 'action', message: messagePayload(), next: 'work' },
      { id: 'work', type: 'action', operation: 'slow', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { outputField: { nodeId: 'note', path: 'score' }, operator: 'gte', value: 80 },
        then: 'pass', else: 'fail',
      },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  const run = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      // The message action has already completed; rewrite the definition's
      // message object while this business action is still waiting.
      workflow.nodes[1].message.score = 10;
      workflow.nodes[1].message.reviewer.name = 'tampered';
      workflow.nodes[1].message.tags.push('late');
      delete workflow.nodes[1].message.flags;
      await sleep(20);
      return 'done';
    },
  });

  // The condition read the value captured when note executed, not the
  // tampered definition.
  assert.equal(run.result, 'passed');
  assert.deepEqual(run.context.output.note, messagePayload());
  // The tampering really reached the definition; only the saved copy was
  // protected.
  assert.equal(workflow.nodes[1].message.score, 10);
  assert.equal(Object.hasOwn(workflow.nodes[1].message, 'flags'), false);
});

test('a failed later node returns the same protected message output and still compensates', async () => {
  let compensated = 0;
  const workflow = {
    id: 'mutate-then-fail',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'charge' },
      { id: 'charge', type: 'action', operation: 'opA', compensation: { operation: 'undoA' }, next: 'note' },
      { id: 'note', type: 'action', message: messagePayload(), next: 'work' },
      { id: 'work', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  const result = await executeWorkflowAsync(workflow, {}, {
    opA: () => 'A',
    opB: async () => {
      workflow.nodes[2].message.score = 1;
      workflow.nodes[2].message.tags.length = 0;
      throw new Error('branch failed');
    },
    undoA: () => { compensated += 1; return 'undone'; },
  });

  assert.equal(result.status, 'action_failed');
  assert.equal(result.nodeId, 'work');
  assert.deepEqual(result.context.output.note, messagePayload());
  assert.equal(compensated, 1);
  assert.equal(result.compensationStatus, 'completed');
  // The legacy message action itself was never compensated.
  assert.deepEqual(result.compensationAttempts.map(r => r.nodeId), ['charge']);
});

test('a bare function message is a definition error naming the action node', () => {
  const workflow = linearMessageWorkflow(() => 'nope');
  assert.throws(
    () => validateWorkflow(workflow),
    /action node note: message must be a structured-cloneable value/,
  );
});

test('a function nested in an object or array message is rejected too', () => {
  for (const message of [
    { save: () => 'nope' },
    { rows: [{ ok: true }, { hook: () => 'nope' }] },
    [1, { nested: [() => 'nope'] }],
  ]) {
    assert.throws(() => validateWorkflow(linearMessageWorkflow(message)), /action node note/);
  }
});

test('plain objects, arrays and cloneable built-ins are accepted as messages', () => {
  for (const message of [
    messagePayload(),
    [1, 2, { a: [] }],
    { when: new Date(0), pattern: /ok/, bytes: new Uint8Array([1, 2]) },
  ]) {
    assert.doesNotThrow(() => validateWorkflow(linearMessageWorkflow(message)));
  }
});

test('all three entries reject an uncloneable message before any node or action runs', async () => {
  const workflow = {
    id: 'before-any-run',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'early' },
      { id: 'early', type: 'action', operation: 'opEarly', next: 'note' },
      { id: 'note', type: 'action', message: { bad: () => 'nope' }, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  let businessCalls = 0;
  const operations = { opEarly: () => { businessCalls += 1; return 'early'; } };

  assert.throws(() => executeWorkflow(workflow, {}), /action node note/);
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, operations), /action node note/);
  assert.equal(businessCalls, 0);
});

test('message actions on untaken branches and entry-unreachable nodes are still checked', () => {
  const untaken = {
    id: 'untaken-message-branch',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'choose' },
      {
        id: 'choose', type: 'condition',
        condition: { field: 'route', operator: 'eq', value: 'good' },
        then: 'good-note', else: 'bad-note',
      },
      { id: 'good-note', type: 'action', message: 'good', next: 'good-end' },
      { id: 'good-end', type: 'end', result: 'good' },
      { id: 'bad-note', type: 'action', message: { broken: () => 'nope' }, next: 'bad-end' },
      { id: 'bad-end', type: 'end', result: 'bad' },
    ],
  };
  // Input selects the good branch; the bad message action never runs but is
  // still rejected at validation time.
  assert.throws(() => validateWorkflow(untaken), /action node bad-note/);
  assert.throws(() => executeWorkflow(untaken, { route: 'good' }), /action node bad-note/);

  const unreachable = {
    id: 'unreachable-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
      { id: 'orphan', type: 'action', message: () => 'nope', next: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(unreachable), /action node orphan/);
});

test('an action with an operation is never rejected for an unused uncloneable message', async () => {
  const workflow = {
    id: 'unused-message',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'work' },
      { id: 'work', type: 'action', operation: 'real', message: { ignored: () => 'nope' }, next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
  assert.doesNotThrow(() => validateWorkflow(workflow));
  const run = await executeWorkflowAsync(workflow, {}, { real: () => 'from-operation' });
  assert.equal(run.status, 'completed');
  // The business operation's return value remains the output; the message
  // configuration is ignored entirely.
  assert.equal(run.context.output.work, 'from-operation');
  assert.equal(run.actionAttempts.length, 1);
});
