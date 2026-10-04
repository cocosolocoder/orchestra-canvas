import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A linear trigger -> business action(s) -> end workflow. Every business
// action here succeeds and saves its return value under its full node id.
function chainWorkflow(nodeIds, { entry = 'start' } = {}) {
  const nodes = [{ id: entry, type: 'trigger', next: nodeIds[0] }];
  nodeIds.forEach((id, index) => {
    nodes.push({
      id, type: 'action', operation: id,
      ...(index < nodeIds.length - 1 ? { next: nodeIds[index + 1] } : { next: 'done' }),
    });
  });
  nodes.push({ id: 'done', type: 'end', result: 'finished' });
  return { id: 'cloneable-outputs', entry, nodes };
}

// Runs a two-operation chain; opNames lets a test provide implementations by
// node id without spelling the workflow shape every time.
async function runTwo(firstImpl, secondImpl) {
  const workflow = chainWorkflow(['first', 'second']);
  const operations = { first: firstImpl, second: secondImpl };
  return executeWorkflowAsync(workflow, {}, operations);
}

test('a return value combining Date, Map and typed bytes is saved as a normal business result', async () => {
  const when = new Date('2021-06-07T08:09:10.000Z');
  const bytes = new Uint8Array([10, 20, 30]);
  const execution = await executeWorkflowAsync(
    chainWorkflow(['first']), {},
    { first: () => ({ when, table: new Map([['a', 1], ['b', 2]]), bytes }) },
  );

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.first;
  // Dates stay Date instances rather than turning into strings.
  assert.ok(saved.when instanceof Date);
  assert.equal(saved.when.toISOString(), '2021-06-07T08:09:10.000Z');
  assert.equal(saved.when.getTime(), when.getTime());
  // Maps stay Maps with their entries, not plain objects.
  assert.ok(saved.table instanceof Map);
  assert.deepEqual([...saved.table.entries()], [['a', 1], ['b', 2]]);
  // Typed bytes stay typed bytes with the same values.
  assert.ok(saved.bytes instanceof Uint8Array);
  assert.deepEqual([...saved.bytes], [10, 20, 30]);
  assert.equal(saved.bytes.byteLength, 3);
});

test('repeated references to one detail object survive as one object in the saved output', async () => {
  const detail = { id: 'detail-1', note: 'shared' };
  const execution = await executeWorkflowAsync(
    chainWorkflow(['first']), {},
    {
      first: () => ({
        when: new Date(0),
        detailA: detail,
        detailB: detail,
        table: new Map([['row', detail]]),
        bag: new Set([detail]),
        bytes: new Uint8Array([1]),
      }),
    },
  );

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.first;
  // The two fields, the Map value and the Set member are the same saved detail.
  assert.equal(saved.detailA, saved.detailB);
  assert.equal(saved.table.get('row'), saved.detailA);
  assert.ok(saved.bag instanceof Set);
  assert.equal(saved.bag.has(saved.detailA), true);
  assert.equal(saved.bag.size, 1);
  // Mutating through one reference is visible through every alias, proving
  // the internal relationship — not just equal-looking content — survived.
  saved.detailA.note = 'edited once';
  assert.equal(saved.detailB.note, 'edited once');
  assert.equal(saved.table.get('row').note, 'edited once');
  assert.equal([...saved.bag][0].note, 'edited once');
});

test('a self-reference points at the saved object, not at the implementation-held original', async () => {
  let original;
  const execution = await executeWorkflowAsync(
    chainWorkflow(['first']), {},
    {
      first: () => {
        const value = {
          label: 'selfish',
          when: new Date('2000-01-01T00:00:00.000Z'),
          table: new Map([['k', 'v']]),
        };
        value.myself = value;
        original = value;
        return value;
      },
    },
  );

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.first;
  assert.equal(saved.myself, saved);
  // The cycle was re-targeted onto the clone: it must not lead back to the
  // object the operation implementation still holds.
  assert.notEqual(saved, original);
  assert.notEqual(saved.myself, original);
  assert.equal(original.myself, original);
});

test('the saved output shares no mutable objects or byte storage with the returned value', async () => {
  const detail = { v: 1 };
  const bytes = new Uint8Array([1, 2, 3]);
  const held = {
    when: new Date('2020-05-05T05:05:05.000Z'),
    table: new Map([['detail', detail]]),
    detail,
    bytes,
  };
  const execution = await executeWorkflowAsync(
    chainWorkflow(['first']), {}, { first: () => held },
  );
  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.first;

  // The saved graph is disjoint from the returned graph at every level.
  assert.notEqual(saved, held);
  assert.notEqual(saved.detail, detail);
  assert.notEqual(saved.table, held.table);
  assert.notEqual(saved.table.get('detail'), detail);
  assert.notEqual(saved.bytes, bytes);
  assert.notEqual(saved.bytes.buffer, bytes.buffer);

  // Rewriting the held value after the run cannot touch the saved output.
  held.when.setFullYear(1999);
  held.table.set('late', 'member');
  held.table.delete('detail');
  held.detail.v = 42;
  held.bytes[0] = 99;
  assert.equal(saved.when.getUTCFullYear(), 2020);
  assert.deepEqual([...saved.table.keys()], ['detail']);
  assert.equal(saved.detail.v, 1);
  assert.deepEqual([...saved.bytes], [1, 2, 3]);
});

test('mutating the earlier operation-held original while a later operation waits leaves the saved output intact', async () => {
  const detail = { id: 'd1', qty: 2 };
  const bytes = new Uint8Array([4, 5, 6]);
  const held = {
    when: new Date('2022-02-02T02:02:02.000Z'),
    rows: new Map([['d1', detail]]),
    primary: detail,
    bytes,
  };

  const execution = await runTwo(
    () => held,
    async () => {
      // `first` already succeeded; rewrite every part of the value its
      // implementation still holds while this operation is waiting.
      held.when.setUTCFullYear(1988);
      held.rows.delete('d1');
      held.rows.set('added', { id: 'late' });
      detail.qty = 77;
      held.bytes[2] = 0;
      await sleep(20);
      return 'second-done';
    },
  );

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.first;
  // A later node still reads the output captured at the first success moment.
  assert.ok(saved.when instanceof Date);
  assert.equal(saved.when.getUTCFullYear(), 2022);
  assert.ok(saved.rows instanceof Map);
  assert.deepEqual([...saved.rows.keys()], ['d1']);
  assert.equal(saved.rows.get('d1'), saved.primary);
  assert.equal(saved.primary.qty, 2);
  assert.deepEqual([...saved.bytes], [4, 5, 6]);
  // The tampering really reached the held original; only the save was safe.
  assert.equal(held.primary.qty, 77);
  assert.equal(held.rows.has('added'), true);
});

test('a later operation may freely mutate its output-parameter copy without touching the saved output', async () => {
  const detail = { id: 'd1', qty: 2 };
  const held = {
    when: new Date('2022-03-03T03:03:03.000Z'),
    rows: new Map([['d1', detail]]),
    primary: detail,
    bytes: new Uint8Array([7, 8, 9]),
  };

  const seenBySecond = [];
  const execution = await runTwo(
    () => held,
    async (input, output) => {
      seenBySecond.push({
        when: output.first.when.getTime(),
        rows: [...output.first.rows.keys()],
        qty: output.first.primary.qty,
        bytes: [...output.first.bytes],
      });
      // These mutations belong to this call's copy only.
      output.first.when.setUTCFullYear(1977);
      output.first.rows.clear();
      output.first.rows.set('mine', { id: 'mine' });
      output.first.primary.qty = -1;
      output.first.bytes[0] = 100;
      await sleep(5);
      return 'second-done';
    },
  );

  assert.equal(execution.status, 'completed');
  // The copy the second operation received started from the saved value.
  assert.deepEqual(seenBySecond[0], {
    when: new Date('2022-03-03T03:03:03.000Z').getTime(),
    rows: ['d1'], qty: 2, bytes: [7, 8, 9],
  });
  const saved = execution.context.output.first;
  // context.output keeps the first node's content exactly as saved.
  assert.equal(saved.when.getUTCFullYear(), 2022);
  assert.deepEqual([...saved.rows.entries()].map(([k, v]) => [k, v.id]), [['d1', 'd1']]);
  assert.equal(saved.primary.qty, 2);
  assert.deepEqual([...saved.bytes], [7, 8, 9]);
  // The original return value is untouched by the copy mutation as well.
  assert.equal(held.primary.qty, 2);
  assert.deepEqual([...held.rows.keys()], ['d1']);
  assert.equal(held.bytes[0], 7);
});

test('changes already present in the return value are saved — pre-return mutation is not discarded', async () => {
  const detail = { step: 0 };
  const table = new Map();
  const execution = await executeWorkflowAsync(
    chainWorkflow(['first']), {},
    {
      first: () => {
        // Mutating the value while building it is part of the return value
        // itself and must survive in the save.
        const value = { when: new Date(0), table, detail, bytes: new Uint8Array(2) };
        value.when.setUTCFullYear(2015);
        table.set('detail', detail);
        detail.step = 3;
        value.bytes[0] = 42;
        value.bytes[1] = 43;
        value.table.set('second-key', 'kept');
        return value;
      },
    },
  );

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.first;
  assert.equal(saved.when.getUTCFullYear(), 2015);
  assert.equal(saved.detail.step, 3);
  assert.deepEqual([...saved.table.keys()].sort(), ['detail', 'second-key']);
  assert.equal(saved.table.get('detail'), saved.detail);
  assert.deepEqual([...saved.bytes], [42, 43]);
});

test('a circular cloneable return value completes with one success record and one trace entry', async () => {
  const execution = await executeWorkflowAsync(
    chainWorkflow(['first']), {},
    {
      first: () => {
        const root = {
          when: new Date('1999-12-31T23:59:59.000Z'),
          table: new Map(),
          bytes: new Uint8Array([255, 0, 127]),
          children: [],
        };
        const child = { parent: root, label: 'c1' };
        root.children.push(child);
        root.table.set('child', child);
        root.self = root;
        return root;
      },
    },
  );

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.first;
  // The whole reference graph is preserved on the saved copy.
  assert.equal(saved.self, saved);
  assert.equal(saved.children[0].parent, saved);
  assert.equal(saved.table.get('child'), saved.children[0]);
  assert.ok(saved.when instanceof Date);
  assert.ok(saved.table instanceof Map);
  assert.ok(saved.bytes instanceof Uint8Array);
  // The successful node produced exactly one trace entry and one successful
  // attempt record, saved under its full node id; the run then completed.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'first', 'done']);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'first', attempt: 1, ok: true, error: null, nextDelayMs: 0 },
  ]);
  assert.deepEqual(Object.keys(execution.context.output), ['first']);
});

test('an actual function in the return value still fails the attempt and leaves no output', async () => {
  const badValues = [
    () => 1,
    { hook: () => 1 },
    { table: new Map([['k', () => 1]]) },
    (() => {
      // Cloneable-looking graph that also carries a function: the cycle does
      // not make it cloneable.
      const value = { when: new Date(0) };
      value.self = value;
      value.fn = () => 1;
      return value;
    })(),
  ];

  for (const badValue of badValues) {
    const workflow = chainWorkflow(['first', 'second']);
    let secondCalled = false;
    const execution = await executeWorkflowAsync(workflow, {}, {
      first: () => badValue,
      second: () => { secondCalled = true; return 'never'; },
    });

    assert.equal(execution.status, 'action_failed');
    assert.equal(execution.nodeId, 'first');
    assert.equal(execution.attempts, 1);
    assert.match(execution.error, /structured-cloned/);
    // The failed node leaves no output and no later node runs.
    assert.equal(Object.hasOwn(execution.context.output, 'first'), false);
    assert.equal(Object.hasOwn(execution.context.output, 'second'), false);
    assert.equal(secondCalled, false);
    assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'first']);
    assert.equal(execution.actionAttempts.length, 1);
    assert.equal(execution.actionAttempts[0].ok, false);
    assert.equal(execution.actionAttempts[0].nextDelayMs, 0);
  }
});

test('successful cloneable outputs and the caller input keep their isolation and ordering guarantees', async () => {
  const caller = { amount: 5 };
  const definition = chainWorkflow(['first', 'second']);
  const definitionSnapshot = JSON.stringify(definition);

  const detail = { id: 'd' };
  const held = { when: new Date('2010-10-10T10:10:10.000Z'), detail, bytes: new Uint8Array([3]) };

  const execution = await executeWorkflowAsync(definition, caller, {
    first: (input, output) => {
      assert.deepEqual(input, { amount: 5 });
      assert.deepEqual(output, {});
      input.amount = 999; // mutating the independent input copy
      return held;
    },
    second: (input, output) => {
      // Each later operation sees its own fresh copy of the earlier output.
      assert.equal(input.amount, 5);
      assert.ok(output.first.when instanceof Date);
      output.first.when.setFullYear(1900);
      return 'ok';
    },
  });

  assert.equal(execution.status, 'completed');
  assert.deepEqual(caller, { amount: 5 });
  assert.equal(JSON.stringify(definition), definitionSnapshot);
  assert.equal(execution.context.input.amount, 5);
  assert.equal(execution.context.output.first.when.getUTCFullYear(), 2010);
  assert.equal(execution.context.output.second, 'ok');
  // Nodes still ran one at a time in declaration order.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'first', 'second', 'done']);
  assert.deepEqual(execution.actionAttempts.map(a => [a.nodeId, a.ok]), [['first', true], ['second', true]]);
});
