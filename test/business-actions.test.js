import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function linearWorkflow(actionProps = {}, { actionMessage = false } = {}) {
  return {
    id: 'ops',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', message: 'prepared', next: 'work' },
      {
        id: 'work', type: 'action',
        ...(actionMessage ? { message: 'legacy' } : actionProps),
        next: 'done',
      },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

test('legacy message actions keep working through the asynchronous entry', async () => {
  const execution = await executeWorkflowAsync(linearWorkflow(null, { actionMessage: true }), { x: 1 });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.context.output.work, 'legacy');
  assert.deepEqual(execution.actionAttempts, []);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'work', 'done']);
});

test('synchronous execution, validation and legacy behavior are unchanged for message actions', () => {
  const execution = executeWorkflow(linearWorkflow(null, { actionMessage: true }), {});
  assert.equal(execution.status, 'completed');
  assert.equal(execution.context.output.work, 'legacy');
  assert.doesNotThrow(() => validateWorkflow(linearWorkflow(null, { actionMessage: true })));
});

test('the synchronous entry refuses a workflow naming a business operation before any node runs', () => {
  const workflow = linearWorkflow({ operation: 'charge' });
  let called = 0;
  assert.throws(
    () => executeWorkflow(workflow, {}),
    error => /action node work/.test(error.message)
      && /charge/.test(error.message)
      && /executeWorkflowAsync/.test(error.message)
  );
  // Refusal happens before the first node executes; trace would be empty.
  try {
    executeWorkflow(workflow, {});
  } catch (error) {
    assert.equal(error.message.includes('work'), true);
  }
  assert.equal(called, 0);
});

test('an operation returning a plain value stores it as the node output', async () => {
  const workflow = linearWorkflow({ operation: 'echo' });
  const execution = await executeWorkflowAsync(workflow, { amount: 5 }, {
    echo: input => ({ doubled: input.amount * 2 }),
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.output.work, { doubled: 10 });
  assert.equal(execution.context.output.prep, 'prepared');
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: true, error: null, nextDelayMs: 0 },
  ]);
});

test('an operation returning a Promise is awaited and its resolution is stored', async () => {
  const workflow = linearWorkflow({ operation: 'slow' });
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async () => {
      await sleep(5);
      return 'ok';
    },
  });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.context.output.work, 'ok');
});

test('each invocation receives input, prior successful outputs, node id and a 1-based attempt number', async () => {
  const seen = [];
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 3, initialDelayMs: 1, backoffFactor: 1, maxDelayMs: 1 },
  });
  await executeWorkflowAsync(workflow, { amount: 10 }, {
    charge: (input, output, nodeId, attempt) => {
      seen.push({ input: structuredClone(input), output: structuredClone(output), nodeId, attempt });
      input.touched = attempt;
      if (attempt < 3) throw new Error(`boom ${attempt}`);
      return 'charged';
    },
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map(s => [s.nodeId, s.attempt]), [['work', 1], ['work', 2], ['work', 3]]);
  // Prior successful output is visible; the current node's own key is not.
  for (const call of seen) {
    assert.deepEqual(call.input, { amount: 10 });
    assert.deepEqual(call.output, { prep: 'prepared' });
  }
});

test('without a retry config a failing operation is tried exactly once', async () => {
  let calls = 0;
  const workflow = linearWorkflow({ operation: 'charge' });
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: () => { calls += 1; throw new Error('card declined'); },
  });
  assert.equal(calls, 1);
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.equal(execution.attempts, 1);
  assert.equal(execution.error, 'card declined');
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'work', attempt: 1, ok: false, error: 'card declined', nextDelayMs: 0 },
  ]);
  assert.equal(execution.context.output.work, undefined);
  assert.deepEqual(execution.context.output, { prep: 'prepared' });
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'work']);
});

test('a rejected Promise counts as a failed attempt exactly like a throw', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: async () => { throw new Error('rejected'); },
  });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.attempts, 2);
  assert.deepEqual(execution.actionAttempts.map(a => a.ok), [false, false]);
});

test('retries wait the initial delay, grow by the backoff factor and respect the cap', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 5, initialDelayMs: 20, backoffFactor: 2, maxDelayMs: 60 },
  });
  const gaps = [];
  let last = Date.now();
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: () => {
      gaps.push(Date.now() - last);
      last = Date.now();
      throw new Error('fail');
    },
  });
  assert.equal(execution.status, 'action_failed');
  assert.deepEqual(execution.actionAttempts.map(a => a.nextDelayMs), [20, 40, 60, 60, 0]);
  // First entry is immediate; each later call follows the recorded wait.
  assert.ok(gaps[0] < 10);
  assert.ok(gaps[1] >= 18);
  assert.ok(gaps[2] >= 38);
  assert.ok(gaps[3] >= 58);
});

test('a value that cannot be structured-cloned makes the attempt fail', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: (input, output, nodeId, attempt) =>
      (attempt === 1 ? { weird: () => 1 } : 'fine'),
  });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.context.output.work, 'fine');
  assert.equal(execution.actionAttempts[0].ok, false);
  assert.match(execution.actionAttempts[0].error, /structured-cloned/);
  assert.equal(execution.actionAttempts[0].nextDelayMs, 0);
  assert.equal(execution.actionAttempts[1].ok, true);
});

test('mutations of the per-attempt copies never leak into later attempts or the run context', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const execution = await executeWorkflowAsync(workflow, { amount: 10, nested: { v: 1 } }, {
    charge: (input, output, nodeId, attempt) => {
      if (attempt < 3) {
        input.amount = 999;
        input.nested.v = 999;
        input.added = true;
        output.prep = 'tampered';
        output.work = 'early';
        throw new Error('try again');
      }
      assert.deepEqual(input, { amount: 10, nested: { v: 1 } });
      assert.deepEqual(output, { prep: 'prepared' });
      return { ok: true };
    },
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.input, { amount: 10, nested: { v: 1 } });
  assert.deepEqual(execution.context.output, { prep: 'prepared', work: { ok: true } });
});

test('stored success output is independent of the object the implementation keeps holding', async () => {
  const workflow = linearWorkflow({ operation: 'charge' });
  const held = { total: 1 };
  const execution = await executeWorkflowAsync(workflow, {}, {
    charge: () => held,
  });
  held.total = 42;
  held.mutated = true;
  assert.deepEqual(execution.context.output.work, { total: 1 });
});

test('the caller input and the workflow definition are never mutated', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  const definitionSnapshot = JSON.stringify(workflow);
  const caller = { amount: 7 };
  const inputSnapshot = JSON.stringify(caller);
  const execution = await executeWorkflowAsync(workflow, caller, {
    charge: (input, output, nodeId, attempt) => {
      input.amount = 0;
      if (attempt === 1) throw new Error('once');
      return 'done';
    },
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(caller, { amount: 7 });
  assert.equal(JSON.stringify(workflow), definitionSnapshot);
  assert.equal(JSON.stringify(caller), inputSnapshot);
});

test('exhausted retries stop the run immediately even when an end node was already reached', async () => {
  const workflow = {
    id: 'early-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: 'early' },
      { id: 'work', type: 'action', operation: 'charge', next: 'after' },
      { id: 'after', type: 'action', message: 'never', next: 'finish' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, { charge: () => { throw new Error('nope'); } });
  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'work');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'finish', 'work']);
  assert.equal(execution.context.output.after, undefined);
});

test('success activates successors and satisfies dependencies; a shared join runs once', async () => {
  const workflow = {
    id: 'join', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['collect', 'audit'] },
      { id: 'collect', type: 'form', next: 'join', schema: { fields: [
        { path: 'score', type: 'number', default: 90 },
      ] } },
      { id: 'audit', type: 'action', operation: 'audit', next: 'join' },
      { id: 'join', type: 'action', dependsOn: ['collect', 'audit'], operation: 'merge', next: 'done' },
      { id: 'done', type: 'end', result: 'merged' },
    ],
  };
  let joinCalls = 0;
  const execution = await executeWorkflowAsync(workflow, {}, {
    audit: () => 'audited',
    merge: () => { joinCalls += 1; return 'merged-once'; },
  });
  assert.equal(execution.status, 'completed');
  assert.equal(joinCalls, 1);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'collect', 'audit', 'join', 'done']);
  assert.deepEqual(execution.context.output.audit, 'audited');
  assert.deepEqual(execution.context.output.join, 'merged-once');
  assert.deepEqual(execution.context.input, { score: 90 });
});

test('no node is scheduled while an action waits or retries', async () => {
  const events = [];
  const workflow = {
    id: 'serial', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['slow', 'fast'] },
      { id: 'slow', type: 'action', operation: 'slow', retry: { attempts: 2, initialDelayMs: 5, backoffFactor: 1, maxDelayMs: 5 }, next: 'done' },
      { id: 'fast', type: 'action', operation: 'fast', next: 'done' },
      { id: 'done', type: 'end', result: 'ordered' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    slow: async (input, output, nodeId, attempt) => {
      events.push(`${nodeId}:${attempt}:start`);
      await sleep(15);
      if (attempt === 1) {
        events.push(`${nodeId}:${attempt}:fail`);
        throw new Error('retry');
      }
      events.push(`${nodeId}:${attempt}:end`);
      return 'slow-done';
    },
    fast: () => {
      events.push('fast:start');
      return 'fast-done';
    },
  });
  assert.equal(execution.status, 'completed');
  // fast never appears between two slow events: the retry wait blocks all
  // scheduling even though fast became active at the same time.
  assert.deepEqual(events, ['slow:1:start', 'slow:1:fail', 'slow:2:start', 'slow:2:end', 'fast:start']);
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'slow', 'fast', 'done']);
});

test('attempt records stay in invocation order across nodes and every node traces once', async () => {
  const workflow = {
    id: 'multi', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', operation: 'opA', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }, next: 'b' },
      { id: 'b', type: 'action', operation: 'opB', next: 'done' },
      { id: 'done', type: 'end', result: 'ok' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    opA: (input, output, nodeId, attempt) => (attempt === 1 ? Promise.reject(new Error('a-boom')) : 'a'),
    opB: () => 'b',
  });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.actionAttempts.map(r => [r.nodeId, r.attempt, r.ok]), [
    ['a', 1, false], ['a', 2, true], ['b', 1, true],
  ]);
  assert.equal(execution.actionAttempts[0].error, 'a-boom');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b', 'done']);
});

test('form failures, condition failures and blocking keep their original results in async runs', async () => {
  const badForm = {
    id: 'form-fail', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', operation: 'prep', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'a.c', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const formRun = await executeWorkflowAsync(badForm, {}, { prep: () => 'prepared' });
  assert.equal(formRun.status, 'invalid_input');
  assert.deepEqual(formRun.errors, [{ nodeId: 'collect', path: 'a.c', code: 'required' }]);
  assert.equal(formRun.context.output.prep, 'prepared');
  assert.equal(formRun.actionAttempts[0].nodeId, 'prep');

  const badCondition = {
    id: 'cond-fail', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'x', operator: 'gte', value: 0 }, then: 'done', else: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const conditionRun = await executeWorkflowAsync(badCondition, { x: {} }, {});
  assert.equal(conditionRun.status, 'invalid_condition');
  assert.deepEqual(conditionRun.actionAttempts, []);

  const blocked = {
    id: 'blocked', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'vip', operator: 'eq', value: true }, then: 'priority', else: 'standard' },
      { id: 'priority', type: 'action', operation: 'priority', next: 'wrap' },
      { id: 'standard', type: 'action', message: 'standard', next: 'wrap' },
      { id: 'wrap', type: 'action', dependsOn: ['standard', 'priority'], next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const blockedRun = await executeWorkflowAsync(blocked, { vip: true }, { priority: () => 'p' });
  assert.equal(blockedRun.status, 'blocked');
  assert.deepEqual(blockedRun.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
  assert.equal(blockedRun.context.output.priority, 'p');
  assert.equal(blockedRun.actionAttempts[0].ok, true);
});

test('missing or non-function implementations are rejected naming the node and invoke nothing', async () => {
  const workflow = linearWorkflow({ operation: 'charge' });
  let called = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { charge: 'not-a-function' }),
    error => /action node work/.test(error.message) && /charge/.test(error.message)
  );
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, undefined), /action node work/);
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, { other: () => 'x' }), /charge/);
  const ops = { charge: () => { called += 1; } };
  await assert.rejects(() => executeWorkflowAsync(workflow, {}, { charge: 42 }), /action node work/);
  assert.equal(called, 0);
  void ops;
});

test('implementation checks cover untaken branches and entry-unreachable nodes', async () => {
  const workflow = {
    id: 'dormant', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'route', operator: 'eq', value: 'a' }, then: 'a', else: 'b' },
      { id: 'a', type: 'action', operation: 'opA', next: 'end' },
      { id: 'b', type: 'end', result: 'b' },
      { id: 'ghost', type: 'action', operation: 'opGhost', next: 'end' },
      { id: 'end', type: 'end', result: 'end' },
    ],
  };
  // opA sits on the untaken branch and opGhost is unreachable: both still checked.
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'b' }, {}),
    /action node a/
  );
  await assert.rejects(
    () => executeWorkflowAsync(workflow, { route: 'b' }, { opA: () => 'a' }),
    /action node ghost/
  );
});

test('operation names and retry configs are validated for every action before execution', () => {
  const badDefinitions = [
    [{ operation: '' }, /operation must be a non-empty string/],
    [{ operation: '   ' }, /operation must be a non-empty string/],
    [{ operation: 7 }, /operation must be a non-empty string/],
    [{ operation: null }, /operation must be a non-empty string/],
    [{ message: 'm', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, /only allowed/],
    [{ operation: 'x', retry: null }, /retry must be an object/],
    [{ operation: 'x', retry: { initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, /attempts/],
    [{ operation: 'x', retry: { attempts: 2, backoffFactor: 1, maxDelayMs: 0 } }, /initialDelayMs/],
    [{ operation: 'x', retry: { attempts: 2, initialDelayMs: 0, maxDelayMs: 0 } }, /backoffFactor/],
    [{ operation: 'x', retry: { attempts: 2, initialDelayMs: 0, backoffFactor: 1 } }, /maxDelayMs/],
    [{ operation: 'x', retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, /attempts must be an integer between 1 and 10/],
    [{ operation: 'x', retry: { attempts: 11, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, /attempts must be an integer between 1 and 10/],
    [{ operation: 'x', retry: { attempts: 2.5, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, /attempts must be an integer between 1 and 10/],
    [{ operation: 'x', retry: { attempts: '2', initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 } }, /attempts must be an integer between 1 and 10/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: -1, backoffFactor: 1, maxDelayMs: 0 } }, /initialDelayMs/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: 60001, backoffFactor: 1, maxDelayMs: 60001 } }, /initialDelayMs/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 60001 } }, /maxDelayMs/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: 10, backoffFactor: 0.9, maxDelayMs: 10 } }, /backoffFactor/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: 10, backoffFactor: 4.1, maxDelayMs: 10 } }, /backoffFactor/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: 10, backoffFactor: NaN, maxDelayMs: 10 } }, /backoffFactor/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: 10, backoffFactor: '2', maxDelayMs: 10 } }, /backoffFactor/],
    [{ operation: 'x', retry: { attempts: 1, initialDelayMs: 20, backoffFactor: 1, maxDelayMs: 10 } }, /maxDelayMs must not be less than/],
  ];
  for (const [actionProps, matcher] of badDefinitions) {
    const workflow = linearWorkflow(actionProps);
    assert.throws(() => validateWorkflow(workflow), matcher);
  }

  // A bad config on an unreachable action is still rejected by validation.
  const dormant = {
    id: 'dormant', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'ghost', type: 'action', operation: 'x', retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }, next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(dormant), /action node ghost/);
});

test('validation failures never invoke an operation', async () => {
  const workflow = linearWorkflow({
    operation: 'charge',
    retry: { attempts: 0, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
  });
  let called = 0;
  await assert.rejects(
    () => executeWorkflowAsync(workflow, {}, { charge: () => { called += 1; } }),
    /attempts must be an integer between 1 and 10/
  );
  assert.equal(called, 0);
});
