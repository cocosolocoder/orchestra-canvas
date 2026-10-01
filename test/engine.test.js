import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, validateWorkflow } from '../src/engine.js';

const workflow = {
  id: 'routing',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'trigger', next: 'check' },
    { id: 'check', type: 'condition', condition: { field: 'score', operator: 'gte', value: 80 }, then: 'pass', else: 'fail' },
    { id: 'pass', type: 'end', result: 'passed' },
    { id: 'fail', type: 'end', result: 'failed' }
  ]
};

test('routes a workflow through the matching branch', () => {
  assert.equal(executeWorkflow(workflow, { score: 90 }).result, 'passed');
  assert.equal(executeWorkflow(workflow, { score: 60 }).result, 'failed');
});

test('rejects unknown destinations', () => {
  const broken = structuredClone(workflow);
  broken.nodes[0].next = 'missing';
  assert.throws(() => validateWorkflow(broken), /unknown destination/);
});

function formWorkflow(fields, { formProps = {} } = {}) {
  return {
    id: 'forms',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', ...(fields ? { schema: { fields } } : {}), ...formProps, next: 'done' },
      { id: 'done', type: 'end', result: 'collected' }
    ]
  };
}

test('forms without a schema keep the legacy passthrough behavior', () => {
  const execution = executeWorkflow(formWorkflow(null), { anything: 1 });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.input, { anything: 1 });
});

test('applies defaults, preserves undeclared fields, and never mutates the caller input', () => {
  const caller = { name: 'Ada', count: 2, untouched: true };
  const execution = executeWorkflow(formWorkflow([
    { path: 'name', type: 'string' },
    { path: 'address.city', type: 'string', default: 'Berlin' },
    { path: 'active', type: 'boolean', default: false },
    { path: 'count', type: 'integer', default: 0 },
  ]), caller);
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.input, {
    name: 'Ada', count: 2, untouched: true,
    address: { city: 'Berlin' }, active: false
  });
  assert.deepEqual(caller, { name: 'Ada', count: 2, untouched: true });
});

test('present values of null, empty string, 0 and false are not replaced by defaults', () => {
  const cases = [
    [{ path: 'a', type: 'string', default: 'x' }, ''],
    [{ path: 'a', type: 'number', default: 1 }, 0],
    [{ path: 'a', type: 'integer', default: 1 }, 0],
    [{ path: 'a', type: 'boolean', default: true }, false],
  ];
  for (const [field, present] of cases) {
    const execution = executeWorkflow(formWorkflow([field]), { a: present });
    assert.equal(execution.status, 'completed');
    assert.deepEqual(execution.context.input, { a: present });
  }
  // The same present-but-wrong-typed values are reported as type errors, never as missing.
  assert.deepEqual(
    executeWorkflow(formWorkflow([{ path: 'a', type: 'string', default: 'x' }]), { a: null }).errors,
    [{ nodeId: 'collect', path: 'a', code: 'type' }]
  );
});

test('missing optional fields without defaults are allowed', () => {
  const execution = executeWorkflow(formWorkflow([
    { path: 'note', type: 'string' },
    { path: 'meta.flag', type: 'boolean' },
  ]), {});
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.context.input, {});
});

test('defaults can create missing parent objects but cannot overwrite unusable parents', () => {
  const ok = executeWorkflow(formWorkflow([{ path: 'a.b.c', type: 'string', default: 'v' }]), {});
  assert.deepEqual(ok.context.input, { a: { b: { c: 'v' } } });

  for (const parent of [null, [], 42]) {
    const failed = executeWorkflow(
      formWorkflow([{ path: 'a.b', type: 'string', default: 'v' }]),
      { a: parent }
    );
    assert.equal(failed.status, 'invalid_input');
    assert.deepEqual(failed.errors, [{ nodeId: 'collect', path: 'a.b', code: 'type' }]);
    assert.deepEqual(failed.context.input, { a: parent });
  }
});

test('checks types and bounds without coercing values', () => {
  const execution = executeWorkflow(formWorkflow([
    { path: 'name', type: 'string', minLength: 2, maxLength: 4 },
    { path: 'amount', type: 'number', min: 0, max: 10 },
    { path: 'whole', type: 'integer' },
    { path: 'flag', type: 'boolean' },
  ]), { name: 123, amount: '5', whole: 1.5, flag: 'true' });
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.errors.map(e => e.code), ['type', 'type', 'type', 'type']);
});

test('string length counts Unicode code points and numeric bounds include boundaries', () => {
  const within = executeWorkflow(formWorkflow([
    { path: 'emoji', type: 'string', minLength: 1, maxLength: 2 },
    { path: 'n', type: 'integer', min: 0, max: 3 },
  ]), { emoji: '😀', n: 3 });
  assert.equal(within.status, 'completed');

  const outside = executeWorkflow(formWorkflow([
    { path: 'emoji', type: 'string', maxLength: 1 },
    { path: 'n', type: 'number', min: 0 },
  ]), { emoji: '😀😀', n: -1 });
  assert.deepEqual(outside.errors.map(e => e.code), ['length', 'range']);
});

test('non-finite numbers and non-integer integers are type errors', () => {
  const execution = executeWorkflow(formWorkflow([
    { path: 'n', type: 'number' },
    { path: 'i', type: 'integer' },
  ]), { n: NaN, i: Infinity });
  assert.deepEqual(execution.errors.map(e => e.code), ['type', 'type']);
});

test('collects one error per field in declaration order with required before type before constraints', () => {
  const fields = [
    { path: 'gone', type: 'string', required: true },
    { path: 'name', type: 'string', minLength: 3 },
    { path: 'age', type: 'integer', min: 0, max: 120 },
    { path: 'ok', type: 'boolean' },
  ];
  const execution = executeWorkflow(formWorkflow(fields), { name: 'ab', age: 200, ok: null });
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.errors, [
    { nodeId: 'collect', path: 'gone', code: 'required' },
    { nodeId: 'collect', path: 'name', code: 'length' },
    { nodeId: 'collect', path: 'age', code: 'range' },
    { nodeId: 'collect', path: 'ok', code: 'type' },
  ]);
  assert.deepEqual(execution.trace, [
    { nodeId: 'start', type: 'trigger' },
    { nodeId: 'collect', type: 'form' },
  ]);
  assert.deepEqual(execution.context.input, { name: 'ab', age: 200, ok: null });
});

test('rolls back every default applied by a failed form, keeping prior output', () => {
  const workflow = {
    id: 'rollback',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'prep' },
      { id: 'prep', type: 'action', next: 'collect' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'a.b', type: 'string', default: 'B' },
        { path: 'a.c', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'collected' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.context.input, {});
  assert.equal(execution.context.output.prep, 'action:prep');
});

test('defaults applied by a form are visible to later conditions', () => {
  const workflow = {
    id: 'conditional',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'check', schema: { fields: [
        { path: 'score', type: 'number', default: 90 },
      ] } },
      { id: 'check', type: 'condition', condition: { field: 'score', operator: 'gte', value: 80 }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  assert.equal(executeWorkflow(workflow, {}).result, 'passed');
  assert.equal(executeWorkflow(workflow, { score: 10 }).result, 'failed');
});

test('only validates forms that are actually traversed', () => {
  const workflow = {
    id: 'branches',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'use', operator: 'eq', value: true }, then: 'collect', else: 'skip' },
      { id: 'collect', type: 'form', next: 'end', schema: { fields: [{ path: 'detail', type: 'string', required: true }] } },
      { id: 'skip', type: 'end', result: 'skipped' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  assert.equal(executeWorkflow(workflow, { use: false }).status, 'completed');
  assert.equal(executeWorkflow(workflow, { use: true }).status, 'invalid_input');
});

test('rejects malformed form schema definitions before execution', () => {
  const invalidDefinitions = [
    [null, /schema must be an object/, { schema: null }],
    [null, /schema\.fields must be an array/, { schema: {} }],
    [{ path: '', type: 'string' }, /non-empty/],
    [{ path: 'a..b', type: 'string' }, /empty segments/],
    [{ path: 'a', type: 'string' }, /duplicate/, { extraField: { path: 'a', type: 'number' } }],
    [{ path: 'a', type: 'string' }, /parent and child/, { extraField: { path: 'a.b', type: 'string' } }],
    [{ path: 'a.b', type: 'string' }, /parent and child/, { extraField: { path: 'a', type: 'string' } }],
    [{ path: '__proto__.x', type: 'string' }, /__proto__/],
    [{ path: 'a.prototype', type: 'string' }, /prototype/],
    [{ path: 'constructor', type: 'string' }, /constructor/],
    [{ path: 'a', type: 'date' }, /unknown field type/],
    [{ path: 'a', type: 'string', required: 'yes' }, /required must be a boolean/],
    [{ path: 'a', type: 'number', minLength: 1 }, /does not apply/],
    [{ path: 'a', type: 'string', min: 1 }, /does not apply/],
    [{ path: 'a', type: 'boolean', max: 1 }, /does not apply/],
    [{ path: 'a', type: 'string', minLength: -1 }, /non-negative integer/],
    [{ path: 'a', type: 'string', minLength: 1.5 }, /non-negative integer/],
    [{ path: 'a', type: 'number', min: Infinity }, /finite number/],
    [{ path: 'a', type: 'string', minLength: 5, maxLength: 2 }, /minLength must not be greater/],
    [{ path: 'a', type: 'integer', min: 5, max: 2 }, /min must not be greater/],
    [{ path: 'a', type: 'integer', default: '1' }, /match field type/],
    [{ path: 'a', type: 'integer', default: 1.5 }, /match field type/],
    [{ path: 'a', type: 'number', default: NaN }, /match field type/],
    [{ path: 'a', type: 'integer', min: 0, default: -1 }, /violates field constraints/],
  ];
  for (const [field, matcher, options] of invalidDefinitions) {
    const fields = options?.extraField ? [field, options.extraField] : [field];
    const workflow = formWorkflow(fields, { formProps: options?.schema !== undefined ? { schema: options.schema } : {} });
    assert.throws(() => validateWorkflow(workflow), matcher);
  }
});

test('detects a reachable cycle', () => {
  const cyclic = {
    id: 'cycle', entry: 'a', nodes: [
      { id: 'a', type: 'trigger', next: 'b' },
      { id: 'b', type: 'action', next: 'a' }
    ]
  };
  assert.throws(() => executeWorkflow(cyclic), /cycle is present/);
});
