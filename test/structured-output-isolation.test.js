import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflowAsync } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A fixed instant shared by the Date-bearing outputs below.
const WHEN = new Date('2026-01-15T10:30:00.000Z');

// Builds a successful business result that mixes every structured kind in
// scope: a Date, a Map, a Uint8Array, a plain detail object referenced from
// more than one place, and a self reference. Every test starts from a fresh
// graph so independent runs never share nodes.
function buildStructuredResult() {
  const detail = { id: 'detail-1', label: 'shared detail' };
  const root = {
    when: new Date(WHEN.getTime()),
    primary: detail,
    index: new Map([
      ['detail', detail],
      ['count', 2],
      ['when', new Date(WHEN.getTime())],
    ]),
    payload: new Uint8Array([9, 8, 7, 6]),
    listed: [detail],
    meta: { nested: { v: 1 } },
  };
  // The object points back at itself; the saved copy must point at the copy.
  root.self = root;
  return root;
}

// start -> produce -> consume -> finish, both middle nodes business actions.
function twoActionWorkflow(produceId = 'produce', consumeId = 'consume') {
  return {
    id: 'structured-outputs',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: produceId },
      { id: produceId, type: 'action', operation: 'produce', next: consumeId },
      { id: consumeId, type: 'action', operation: 'consume', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };
}

test('Date, Map and Uint8Array in a successful output are saved as their real types, not JSON stand-ins', async () => {
  const workflow = twoActionWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => buildStructuredResult(),
    consume: () => 'consumed',
  });

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.produce;

  assert.ok(saved.when instanceof Date, 'date must stay a Date');
  assert.equal(saved.when.getTime(), WHEN.getTime());
  assert.ok(saved.index instanceof Map, 'map must stay a Map (not a plain object)');
  assert.deepEqual([...saved.index.keys()], ['detail', 'count', 'when']);
  assert.equal(saved.index.get('count'), 2);
  assert.ok(saved.index.get('when') instanceof Date);
  assert.equal(saved.index.get('when').getTime(), WHEN.getTime());
  assert.ok(saved.payload instanceof Uint8Array, 'bytes must stay a Uint8Array');
  assert.deepEqual([...saved.payload], [9, 8, 7, 6]);
});

test('repeated references inside one output keep pointing at the same saved detail object', async () => {
  const workflow = twoActionWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => buildStructuredResult(),
    consume: () => 'consumed',
  });

  const saved = execution.context.output.produce;
  // Two top-level fields and one Map entry all named the same detail object;
  // the saved graph keeps that identity instead of producing three copies.
  assert.equal(saved.primary, saved.listed[0]);
  assert.equal(saved.primary, saved.index.get('detail'));
  assert.equal(saved.primary.id, 'detail-1');
});

test('the self reference of a returned object points at the saved output, not the implementation original', async () => {
  const workflow = twoActionWorkflow();
  let retainedOriginal = null;
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const value = buildStructuredResult();
      retainedOriginal = value;
      return value;
    },
    consume: () => 'consumed',
  });

  const saved = execution.context.output.produce;
  assert.equal(saved.self, saved);
  assert.notEqual(saved.self, retainedOriginal);
  assert.notEqual(saved, retainedOriginal);
  // The cycle stays navigable through the shared detail too.
  assert.equal(saved.self.primary, saved.primary);
});

test('the saved output shares no mutable object or byte storage with the returned value', async () => {
  const workflow = twoActionWorkflow();
  let retainedOriginal = null;
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const value = buildStructuredResult();
      retainedOriginal = value;
      return value;
    },
    consume: () => 'consumed',
  });

  const saved = execution.context.output.produce;
  assert.notEqual(saved.when, retainedOriginal.when);
  assert.notEqual(saved.index, retainedOriginal.index);
  assert.notEqual(saved.index.get('when'), retainedOriginal.index.get('when'));
  assert.notEqual(saved.primary, retainedOriginal.primary);
  assert.notEqual(saved.meta.nested, retainedOriginal.meta.nested);
  assert.notEqual(saved.payload, retainedOriginal.payload);
  // The byte storage itself is independent: typed arrays must not share a buffer.
  assert.notEqual(saved.payload.buffer, retainedOriginal.payload.buffer);
});

test('a later operation receives a copy that keeps the internal identities and self reference', async () => {
  const workflow = twoActionWorkflow();
  let seen = null;
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => buildStructuredResult(),
    consume: (input, output) => {
      seen = output.produce;
      return 'consumed';
    },
  });

  assert.equal(execution.status, 'completed');
  assert.ok(seen.when instanceof Date);
  assert.ok(seen.index instanceof Map);
  assert.ok(seen.payload instanceof Uint8Array);
  assert.equal(seen.self, seen);
  assert.equal(seen.primary, seen.listed[0]);
  assert.equal(seen.primary, seen.index.get('detail'));
  // The argument copy is distinct from the saved output object.
  assert.notEqual(seen, execution.context.output.produce);
  assert.notEqual(seen.payload.buffer, execution.context.output.produce.payload.buffer);
});

test('mutating the retained original while a later operation waits cannot change the already-saved output', async () => {
  const workflow = {
    id: 'mutate-retained',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'produce' },
      { id: 'produce', type: 'action', operation: 'produce', next: 'slow' },
      { id: 'slow', type: 'action', operation: 'slow', next: 'reader' },
      { id: 'reader', type: 'action', operation: 'reader', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };

  let retained = null;
  const readerSaw = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const value = buildStructuredResult();
      retained = value;
      return value;
    },
    slow: async () => {
      // `produce` has already succeeded; rewrite every corner of the original
      // it kept while this operation is still waiting to return.
      retained.when.setUTCFullYear(1999);
      retained.index.delete('detail');
      retained.index.set('added-late', 'late');
      retained.primary.label = 'tampered';
      retained.payload[0] = 255;
      retained.meta.nested.v = 42;
      await sleep(20);
      return 'slow-done';
    },
    reader: (input, output) => {
      readerSaw.push(structuredClone(output.produce));
      return 'read-done';
    },
  });

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.produce;

  // What the still-later node reads is the success-moment snapshot.
  const read = readerSaw[0];
  assert.equal(read.when.getUTCFullYear(), 2026);
  assert.deepEqual([...read.index.keys()], ['detail', 'count', 'when']);
  assert.equal(read.index.get('detail').label, 'shared detail');
  assert.equal(read.primary.label, 'shared detail');
  assert.deepEqual([...read.payload], [9, 8, 7, 6]);
  assert.equal(read.meta.nested.v, 1);

  // The final context.output holds that same snapshot.
  assert.equal(saved.when.getTime(), WHEN.getTime());
  assert.equal(saved.primary.label, 'shared detail');
  assert.equal(saved.index.get('detail'), saved.primary);
  assert.equal(saved.index.has('added-late'), false);
  assert.deepEqual([...saved.payload], [9, 8, 7, 6]);
  assert.equal(saved.meta.nested.v, 1);
  assert.equal(saved.self, saved);

  // The tampering really landed on the implementation's own object.
  assert.equal(retained.when.getUTCFullYear(), 1999);
  assert.equal(retained.primary.label, 'tampered');
  assert.equal(retained.payload[0], 255);
  assert.equal(retained.index.has('detail'), false);
});

test('edits a later operation makes to its output argument are local to that one call', async () => {
  const workflow = {
    id: 'local-arg-edits',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'produce' },
      { id: 'produce', type: 'action', operation: 'produce', next: 'mutator' },
      { id: 'mutator', type: 'action', operation: 'mutator', next: 'reader' },
      { id: 'reader', type: 'action', operation: 'reader', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };

  let retainedOriginal = null;
  const readerSaw = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const value = buildStructuredResult();
      retainedOriginal = value;
      return value;
    },
    mutator: (input, output) => {
      // Re-typing the date, deleting/adding Map members, rewriting a detail
      // field and overwriting bytes — all on this call's private copy.
      output.produce.when.setUTCFullYear(2001);
      output.produce.index.delete('count');
      output.produce.index.set('local-only', 'x');
      output.produce.primary.label = 'local label';
      output.produce.payload.fill(0);
      output.produce.self.meta.nested.v = 77;
      return 'mutated';
    },
    reader: (input, output) => {
      readerSaw.push(structuredClone(output.produce));
      return 'read-done';
    },
  });

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.produce;

  // The next node reads the untouched saved output, field by field.
  const read = readerSaw[0];
  assert.equal(read.when.getUTCFullYear(), 2026);
  assert.deepEqual([...read.index.keys()], ['detail', 'count', 'when']);
  assert.equal(read.index.has('local-only'), false);
  assert.equal(read.primary.label, 'shared detail');
  assert.deepEqual([...read.payload], [9, 8, 7, 6]);
  assert.equal(read.meta.nested.v, 1);

  // context.output keeps the produce node's success-time value.
  assert.equal(saved.when.getTime(), WHEN.getTime());
  assert.equal(saved.primary.label, 'shared detail');
  assert.deepEqual([...saved.index.keys()], ['detail', 'count', 'when']);
  assert.deepEqual([...saved.payload], [9, 8, 7, 6]);
  assert.equal(saved.meta.nested.v, 1);

  // The implementation's own returned object was never reached either.
  assert.equal(retainedOriginal.primary.label, 'shared detail');
  assert.deepEqual([...retainedOriginal.payload], [9, 8, 7, 6]);
});

test('changes formed before the operation returns belong to the saved output', async () => {
  const workflow = twoActionWorkflow();
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const detail = { id: 'd', revisions: 0 };
      const map = new Map();
      const bytes = new Uint8Array(3);
      const value = { when: new Date(0), detail, map, bytes };
      // Mutations completed before the return are part of the result itself;
      // they must be saved, not treated as noise to discard.
      value.when.setUTCFullYear(2011);
      detail.revisions += 1;
      map.set('first', detail);
      map.set('second', new Date(WHEN.getTime()));
      bytes[0] = 4;
      value.loop = value;
      return value;
    },
    consume: () => 'consumed',
  });

  assert.equal(execution.status, 'completed');
  const saved = execution.context.output.produce;
  assert.equal(saved.when.getUTCFullYear(), 2011);
  assert.equal(saved.detail.revisions, 1);
  assert.equal(saved.map.get('first'), saved.detail);
  assert.ok(saved.map.get('second') instanceof Date);
  assert.equal(saved.map.get('second').getTime(), WHEN.getTime());
  assert.deepEqual([...saved.bytes], [4, 0, 0]);
  assert.equal(saved.loop, saved);
});

test('a cyclic cloneable output succeeds and records exactly one execution and one successful attempt', async () => {
  const workflow = {
    id: 'cyclic',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'produce' },
      { id: 'produce', type: 'action', operation: 'produce', next: 'next-node' },
      { id: 'next-node', type: 'action', operation: 'follow', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const a = { name: 'a' };
      const b = { name: 'b', back: a };
      a.forward = b;
      a.self = a;
      const map = new Map();
      map.set(a, b);
      a.byMap = map;
      return a;
    },
    follow: () => 'followed',
  });

  assert.equal(execution.status, 'completed');
  // Each successful node appears in the trace exactly once and keeps going in
  // declaration order — a cycle in the data never cycles the execution.
  assert.deepEqual(execution.trace.map(node => node.nodeId), ['start', 'produce', 'next-node', 'finish']);
  assert.deepEqual(execution.actionAttempts.map(record => [record.nodeId, record.attempt, record.ok, record.nextDelayMs]), [
    ['produce', 1, true, 0],
    ['next-node', 1, true, 0],
  ]);

  const saved = execution.context.output.produce;
  assert.equal(saved.self, saved);
  assert.equal(saved.forward.back, saved);
  assert.ok(saved.byMap instanceof Map);
  assert.equal(saved.byMap.get(saved), saved.forward);
});

test('an output containing a function fails under the uncloneable-return rule and leaves no output', async () => {
  const workflow = {
    id: 'uncloneable',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'produce' },
      { id: 'produce', type: 'action', operation: 'produce', next: 'after' },
      { id: 'after', type: 'action', operation: 'after', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };

  // A cyclic object is cloneable; slipping a function into it must still fail.
  const cyclicButWithFunction = () => {
    const value = { when: new Date(), index: new Map(), payload: new Uint8Array([1]) };
    value.index.set('self', value);
    value.self = value;
    value.save = () => 'nope';
    return value;
  };

  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: cyclicButWithFunction,
    after: () => 'never reached',
  });

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'produce');
  assert.equal(execution.attempts, 1);
  assert.match(execution.error, /structured-cloned/);
  assert.equal(Object.hasOwn(execution.context.output, 'produce'), false);
  assert.equal(execution.context.output.after, undefined);
  assert.deepEqual(execution.actionAttempts, [
    { nodeId: 'produce', attempt: 1, ok: false, error: execution.error, nextDelayMs: 0 },
  ]);
  // The failed node traces once; no successor ever runs.
  assert.deepEqual(execution.trace.map(node => node.nodeId), ['start', 'produce']);
});

test('a function nested inside a Map or typed payload also fails with no saved output', async () => {
  const variants = [
    () => ({ index: new Map([['fn', () => 'nope']]) }),
    () => ({ items: [{ run: () => 'nope' }] }),
    () => ({ nested: { deep: { run: () => 'nope' } } }),
  ];
  for (const produce of variants) {
    const workflow = {
      id: 'nested-uncloneable',
      entry: 'start',
      nodes: [
        { id: 'start', type: 'trigger', next: 'produce' },
        { id: 'produce', type: 'action', operation: 'produce', next: 'finish' },
        { id: 'finish', type: 'end', result: 'finished' },
      ],
    };
    const execution = await executeWorkflowAsync(workflow, {}, { produce });
    assert.equal(execution.status, 'action_failed');
    assert.equal(execution.nodeId, 'produce');
    assert.match(execution.error, /structured-cloned/);
    assert.equal(Object.hasOwn(execution.context.output, 'produce'), false);
    assert.equal(execution.actionAttempts.length, 1);
    assert.equal(execution.actionAttempts[0].ok, false);
  }
});

test('a structured success followed by an uncloneable failure preserves the structured output exactly', async () => {
  const workflow = {
    id: 'success-then-fail',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'produce' },
      { id: 'produce', type: 'action', operation: 'produce', next: 'broken' },
      { id: 'broken', type: 'action', operation: 'broken', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };

  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => buildStructuredResult(),
    broken: () => ({ callback: () => 'nope' }),
  });

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.nodeId, 'broken');
  const saved = execution.context.output.produce;
  assert.ok(saved.when instanceof Date);
  assert.ok(saved.index instanceof Map);
  assert.ok(saved.payload instanceof Uint8Array);
  assert.equal(saved.self, saved);
  assert.equal(saved.primary, saved.index.get('detail'));
  assert.deepEqual([...saved.payload], [9, 8, 7, 6]);
  assert.equal(Object.hasOwn(execution.context.output, 'broken'), false);
});

test('the structured success output reaches compensation with its types and identities, still isolated', async () => {
  const workflow = {
    id: 'compensate-structured',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'produce' },
      {
        id: 'produce', type: 'action', operation: 'produce',
        compensation: { operation: 'undo' }, next: 'broken',
      },
      { id: 'broken', type: 'action', operation: 'broken', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
    ],
  };

  let retainedOriginal = null;
  const compensationSaw = [];
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const detail = { id: 'detail-1' };
      const root = {
        when: new Date(WHEN.getTime()),
        primary: detail,
        index: new Map([['detail', detail]]),
        payload: new Uint8Array([9, 8, 7, 6]),
      };
      root.self = root;
      retainedOriginal = root;
      return root;
    },
    broken: () => { throw new Error('downstream failure'); },
    undo: (input, output, result) => {
      compensationSaw.push(result);
      // The compensation works on its own private copy.
      result.when.setUTCFullYear(1970);
      result.index.set('local', 'comp-only');
      result.primary.id = 'comp-changed';
      result.payload.fill(0);
      return 'undone';
    },
  });

  assert.equal(execution.status, 'action_failed');
  assert.equal(execution.compensationStatus, 'completed');

  // The snapshot handed to compensation is the success-moment value, with
  // every structured type and internal identity intact.
  const seen = compensationSaw[0];
  assert.ok(seen.when instanceof Date);
  assert.ok(seen.index instanceof Map);
  assert.ok(seen.payload instanceof Uint8Array);
  assert.equal(seen.self, seen);
  assert.equal(seen.primary, seen.index.get('detail'));

  // Neither the compensation's edits nor a late edit of the implementation's
  // own object can touch the output saved for the successful node.
  const saved = execution.context.output.produce;
  assert.equal(saved.when.getTime(), WHEN.getTime());
  assert.equal(saved.primary.id, 'detail-1');
  assert.equal(saved.index.has('local'), false);
  assert.deepEqual([...saved.payload], [9, 8, 7, 6]);
  assert.equal(saved.self, saved);

  retainedOriginal.primary.id = 'late-change';
  assert.equal(saved.primary.id, 'detail-1');
});

test('structured outputs are saved and read back under the full node id', async () => {
  const workflow = {
    id: 'full-id',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'step.one' },
      { id: 'step.one', type: 'action', operation: 'produce', next: 'check' },
      {
        id: 'check', type: 'condition',
        condition: { outputField: { nodeId: 'step.one', path: 'meta.count' }, operator: 'gte', value: 2 },
        then: 'reader', else: 'failed-end',
      },
      { id: 'reader', type: 'action', operation: 'reader', next: 'finish' },
      { id: 'finish', type: 'end', result: 'finished' },
      { id: 'failed-end', type: 'end', result: 'failed' },
    ],
  };
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      const value = buildStructuredResult();
      value.meta.count = 3;
      return value;
    },
    reader: () => 'read',
  });

  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'finished');
  assert.ok(Object.hasOwn(execution.context.output, 'step.one'));
  const saved = execution.context.output['step.one'];
  assert.ok(saved.index instanceof Map);
  assert.equal(saved.meta.count, 3);
});

test('structured business outputs never mutate the caller input or the workflow definition', async () => {
  const workflow = twoActionWorkflow();
  const definitionSnapshot = structuredClone(workflow);
  const caller = { request: { amount: 5 } };
  const inputSnapshot = structuredClone(caller);

  const execution = await executeWorkflowAsync(workflow, caller, {
    produce: input => {
      input.request.amount = 999;
      input.added = true;
      return buildStructuredResult();
    },
    consume: input => {
      input.request.amount = 1234;
      return 'consumed';
    },
  });

  assert.equal(execution.status, 'completed');
  assert.deepEqual(caller, inputSnapshot);
  assert.deepEqual(structuredClone(workflow), definitionSnapshot);
  // The run context input is its own copy, also untouched by the operations.
  assert.deepEqual(execution.context.input, { request: { amount: 5 } });
});

test('mutating the returned structured result after the completed run cannot reach the saved output', async () => {
  const workflow = twoActionWorkflow();
  let retained = null;
  const execution = await executeWorkflowAsync(workflow, {}, {
    produce: () => {
      retained = buildStructuredResult();
      return retained;
    },
    consume: () => 'consumed',
  });

  const saved = execution.context.output.produce;
  // Rewrite the implementation object after the whole run has finished.
  retained.when.setUTCFullYear(1980);
  retained.payload[1] = 200;
  retained.index.clear();
  retained.primary.id = 'changed';
  retained.newField = 'late';

  assert.equal(saved.when.getUTCFullYear(), 2026);
  assert.deepEqual([...saved.payload], [9, 8, 7, 6]);
  assert.equal(saved.index.size, 3);
  assert.equal(saved.primary.id, 'detail-1');
  assert.equal(Object.hasOwn(saved, 'newField'), false);
  assert.equal(saved.self, saved);
});
