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

function conditionWorkflow(condition, { before = 'check' } = {}) {
  const nodes = [
    { id: 'start', type: 'trigger', next: before },
    { id: 'check', type: 'condition', condition, then: 'pass', else: 'fail' },
    { id: 'pass', type: 'end', result: 'passed' },
    { id: 'fail', type: 'end', result: 'failed' },
  ];
  if (before === 'prep') {
    nodes.splice(1, 0, { id: 'prep', type: 'action', message: 'prepared', next: 'check' });
    nodes[0].next = 'prep';
  }
  return { id: 'conditions', entry: 'start', nodes };
}

const branchOf = (condition, input) => executeWorkflow(conditionWorkflow(condition), input).result;

test('all, any and not combine conditions and can be nested', () => {
  assert.equal(branchOf({ all: [{ field: 'a', operator: 'gte', value: 1 }, { field: 'b', operator: 'eq', value: 'x' }] }, { a: 2, b: 'x' }), 'passed');
  assert.equal(branchOf({ all: [{ field: 'a', operator: 'gte', value: 1 }, { field: 'b', operator: 'eq', value: 'x' }] }, { a: 2, b: 'y' }), 'failed');
  assert.equal(branchOf({ any: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 'x' }] }, { a: 2, b: 'x' }), 'passed');
  assert.equal(branchOf({ any: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 'x' }] }, { a: 2, b: 'y' }), 'failed');
  assert.equal(branchOf({ not: { field: 'a', operator: 'gte', value: 5 } }, { a: 1 }), 'passed');
  assert.equal(branchOf({ not: { field: 'a', operator: 'gte', value: 5 } }, { a: 10 }), 'failed');

  const nested = {
    any: [
      { all: [{ field: 'a', operator: 'exists' }, { field: 'b', operator: 'gte', valueField: 'a' }] },
      { not: { field: 'c', operator: 'eq', value: false } },
    ],
  };
  assert.equal(branchOf(nested, { a: '3', b: '4' }), 'passed');
  assert.equal(branchOf(nested, { a: 4, b: 3, c: false }), 'failed');
  assert.equal(branchOf(nested, { c: false }), 'failed');
  assert.equal(branchOf(nested, { c: true }), 'passed');
});

test('exists treats null, empty string, 0 and false as present', () => {
  for (const present of [null, '', 0, false]) {
    assert.equal(branchOf({ field: 'x', operator: 'exists' }, { x: present }), 'passed');
  }
  assert.equal(branchOf({ field: 'x', operator: 'exists' }, {}), 'failed');
  assert.equal(branchOf({ field: 'x.y', operator: 'exists' }, { x: 'y' }), 'failed');
  assert.equal(branchOf({ field: 'x.y', operator: 'exists' }, { x: { y: null } }), 'passed');
  assert.equal(branchOf({ not: { field: 'x', operator: 'exists' } }, {}), 'passed');
});

test('eq stays strictly equal and never coerces', () => {
  assert.equal(branchOf({ field: 'x', operator: 'eq', value: 1 }, { x: 1 }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'eq', value: 1 }, { x: '1' }), 'failed');
  assert.equal(branchOf({ field: 'x', operator: 'eq', value: null }, { x: null }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'eq', value: false }, { x: 0 }), 'failed');
  assert.equal(branchOf({ field: 'x', operator: 'eq', value: 'yes' }, { x: 'yes' }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'eq', value: '' }, { x: 0 }), 'failed');
});

test('gte and lte convert numeric strings, booleans and null but require finite results', () => {
  assert.equal(branchOf({ field: 'x', operator: 'gte', value: 0 }, { x: '10' }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'lte', value: 0 }, { x: '-5' }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'gte', value: 1 }, { x: true }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'lte', value: 0 }, { x: false }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'gte', value: null }, { x: null }), 'passed');
  assert.equal(branchOf({ field: 'x', operator: 'gte', value: 0 }, { x: '' }), 'passed');
});

test('valueField compares two input fields and is exclusive with value', () => {
  assert.equal(branchOf({ field: 'b', operator: 'gte', valueField: 'a' }, { a: '5', b: '6' }), 'passed');
  assert.equal(branchOf({ field: 'b', operator: 'gte', valueField: 'a' }, { a: 6, b: 5 }), 'failed');
  assert.equal(branchOf({ field: 'b', operator: 'gte', valueField: 'a' }, { b: 5 }), 'failed');
  assert.equal(branchOf({ field: 'b', operator: 'gte', valueField: 'a' }, { a: 5 }), 'failed');
  assert.equal(branchOf({ field: 'b', operator: 'eq', valueField: 'a' }, { a: null, b: null }), 'passed');
});

test('ordinary comparisons are false when any compared field is missing', () => {
  assert.equal(branchOf({ field: 'x', operator: 'gte', value: 0 }, {}), 'failed');
  assert.equal(branchOf({ field: 'a.b', operator: 'eq', value: 1 }, { a: null }), 'failed');
});

test('evaluated numeric comparisons on bad inputs stop execution as invalid_condition', () => {
  const badInputs = [{ x: 'abc' }, { x: undefined }, { x: NaN }, { x: {} }, { x: [] }];
  for (const input of badInputs) {
    const execution = executeWorkflow(conditionWorkflow({ field: 'x', operator: 'gte', value: 0 }, { before: 'prep' }), input);
    assert.equal(execution.status, 'invalid_condition');
    assert.deepEqual(execution.context.input, input);
    assert.equal(execution.context.output.prep, 'prepared');
    assert.deepEqual(execution.trace, [
      { nodeId: 'start', type: 'trigger' },
      { nodeId: 'prep', type: 'action' },
      { nodeId: 'check', type: 'condition' },
    ]);
    assert.match(execution.error, /condition node check at \$/);
  }

  const valueFieldSide = executeWorkflow(
    conditionWorkflow({ field: 'x', operator: 'lte', valueField: 'y' }),
    { x: 1, y: [] }
  );
  assert.equal(valueFieldSide.status, 'invalid_condition');
  assert.match(valueFieldSide.error, /valueField/);

  const nested = executeWorkflow(
    conditionWorkflow({ all: [{ field: 'a', operator: 'gte', value: 0 }, { not: { field: 'b', operator: 'gte', value: 0 } }] }),
    { a: 1, b: { nested: true } }
  );
  assert.equal(nested.status, 'invalid_condition');
  assert.match(nested.error, /\$\.all\[1\]\.not/);
});

test('short-circuits in declaration order so skipped children never error', () => {
  const input = { a: 1, bad: {} };
  assert.equal(branchOf({ all: [{ field: 'a', operator: 'gte', value: 5 }, { field: 'bad', operator: 'gte', value: 0 }] }, input), 'failed');
  assert.equal(branchOf({ any: [{ field: 'a', operator: 'gte', value: 0 }, { field: 'bad', operator: 'gte', value: 0 }] }, input), 'passed');
  assert.equal(branchOf({ not: { all: [{ field: 'a', operator: 'gte', value: 5 }, { field: 'bad', operator: 'gte', value: 0 }] } }, input), 'passed');

  // Once short-circuiting ends, later bad children are still evaluated.
  assert.equal(executeWorkflow(conditionWorkflow({ all: [{ field: 'a', operator: 'gte', value: 0 }, { field: 'bad', operator: 'gte', value: 0 }] }), input).status, 'invalid_condition');
  assert.equal(executeWorkflow(conditionWorkflow({ any: [{ field: 'a', operator: 'gte', value: 5 }, { field: 'bad', operator: 'gte', value: 0 }] }), input).status, 'invalid_condition');
});

test('eq never raises invalid_condition even for object inputs', () => {
  assert.equal(branchOf({ field: 'x', operator: 'eq', value: 1 }, { x: {} }), 'failed');
});

test('rejects malformed condition definitions before execution, including untaken branches', () => {
  const invalid = [
    [{ field: 'x', operator: 'wat', value: 1 }, /unknown condition operator/],
    [{ all: [] }, /all must not be empty/],
    [{ any: [] }, /any must not be empty/],
    [{ all: {} }, /all must be an array/],
    [{ all: [null] }, /condition must be an object/],
    [{ all: [{ field: 'x', operator: 'gte', value: 1 }, 5] }, /\$\.all\[1\].*condition must be an object/],
    [{ not: [] }, /condition must be an object/],
    [{ not: null }, /condition must be an object/],
    [{ all: [{ field: 'x', operator: 'gte', value: 1 }], any: [{ field: 'y', operator: 'exists' }] }, /only one of all, any or not/],
    [{ all: [{ field: 'x', operator: 'exists' }], field: 'x' }, /must not mix in/],
    [{ field: 'x', operator: 'gte' }, /exactly one of value or valueField/],
    [{ field: 'x', operator: 'gte', value: 1, valueField: 'y' }, /exactly one of value or valueField/],
    [{ field: 'x', operator: 'gte', value: {} }, /value must be a string, finite number, boolean or null/],
    [{ field: 'x', operator: 'gte', value: NaN }, /value must be/],
    [{ field: 'x', operator: 'gte', value: ['x'] }, /value must be/],
    [{ field: 'x', operator: 'gte', value: 'abc' }, /must convert to a finite number/],
    [{ field: 'x', operator: 'exists', value: 1 }, /exists only takes field and operator/],
    [{ field: 'x', operator: 'exists', valueField: 'y' }, /exists only takes field and operator/],
    [{ field: '', operator: 'exists' }, /non-empty string/],
    [{ field: 'a..b', operator: 'exists' }, /empty segments/],
    [{ field: '__proto__', operator: 'exists' }, /__proto__/],
    [{ field: 'x', operator: 'gte', value: 1, valueField: 5 }, /exactly one of/],
    [{ field: 'x', operator: 'gte', valueField: 'constructor.x' }, /constructor/],
    [{ operator: 'gte', value: 1 }, /comparison \(field and operator\)/],
  ];
  for (const [condition, matcher] of invalid) {
    assert.throws(() => validateWorkflow(conditionWorkflow(condition)), matcher);
  }

  // A malformed condition sitting on an unreachable branch is still rejected.
  const branched = {
    id: 'untaken', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'route', operator: 'eq', value: 'a' }, then: 'a', else: 'b' },
      { id: 'a', type: 'condition', condition: { field: 'x', operator: 'nope', value: 1 }, then: 'end', else: 'end' },
      { id: 'b', type: 'end', result: 'b' },
      { id: 'end', type: 'end', result: 'end' },
    ],
  };
  assert.throws(() => executeWorkflow(branched, { route: 'b' }), /unknown condition operator/);
});

test('nests up to 32 levels and rejects the 33rd, reporting the position', () => {
  const nested = depth => {
    let condition = { field: 'x', operator: 'exists' };
    for (let i = 1; i < depth; i += 1) condition = { not: condition };
    return condition;
  };
  assert.doesNotThrow(() => validateWorkflow(conditionWorkflow(nested(32))));
  assert.throws(() => validateWorkflow(conditionWorkflow(nested(33))), /nested deeper than 32 levels/);
  try {
    validateWorkflow(conditionWorkflow(nested(33)));
  } catch (error) {
    assert.match(error.message, /condition node check at \$\.not\.not/);
  }
});

test('compound conditions see form defaults, failed forms still stop and roll back', () => {
  const workflow = {
    id: 'defaulted', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: 'check', schema: { fields: [
        { path: 'score', type: 'number', default: 90 },
        { path: 'flag', type: 'boolean', default: true },
      ] } },
      { id: 'check', type: 'condition', condition: { all: [{ field: 'score', operator: 'gte', value: 80 }, { field: 'flag', operator: 'eq', value: true }] }, then: 'pass', else: 'fail' },
      { id: 'pass', type: 'end', result: 'passed' },
      { id: 'fail', type: 'end', result: 'failed' },
    ],
  };
  assert.equal(executeWorkflow(workflow, {}).result, 'passed');

  const failing = structuredClone(workflow);
  failing.nodes[1].schema.fields.push({ path: 'required', type: 'string', required: true });
  const execution = executeWorkflow(failing, {});
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.context.input, {});
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'collect']);
});

test('never mutates the definition or caller input and keeps runs independent', () => {
  const workflow = conditionWorkflow({ all: [{ field: 'a', operator: 'gte', value: 1 }, { not: { field: 'b', operator: 'eq', value: null } }] });
  const definitionSnapshot = JSON.stringify(workflow);
  const caller = { a: '2', b: 'x' };
  const inputSnapshot = JSON.stringify(caller);

  assert.equal(executeWorkflow(workflow, caller).result, 'passed');
  assert.equal(executeWorkflow(workflow, { a: 0, b: null }).result, 'failed');
  assert.equal(executeWorkflow(workflow, caller).result, 'passed');

  assert.equal(JSON.stringify(workflow), definitionSnapshot);
  assert.equal(JSON.stringify(caller), inputSnapshot);
});

// --- multi-branch successors -------------------------------------------------

test('array successors activate every branch and run a shared end once', () => {
  const workflow = {
    id: 'fanout', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'b', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'done');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b', 'end']);
  assert.deepEqual(execution.context.output, { a: 'action:a', b: 'action:b' });
});

test('a shared successor reached by several edges runs exactly once', () => {
  const workflow = {
    id: 'merge', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'c' },
      { id: 'b', type: 'action', next: 'c' },
      { id: 'c', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b', 'c', 'end']);
  assert.deepEqual(execution.context.output, { a: 'action:a', b: 'action:b', c: 'action:c' });
});

test('condition outlets may be arrays; the unselected outlet never activates', () => {
  const workflow = {
    id: 'cond-fanout', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'use', operator: 'eq', value: true }, then: ['a', 'b'], else: ['skip'] },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'b', type: 'action', next: 'end' },
      { id: 'skip', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const taken = executeWorkflow(workflow, { use: true });
  assert.deepEqual(taken.trace.map(n => n.nodeId), ['start', 'check', 'a', 'b', 'end']);
  assert.deepEqual(taken.context.output, { a: 'action:a', b: 'action:b' });

  const notTaken = executeWorkflow(workflow, { use: false });
  assert.deepEqual(notTaken.trace.map(n => n.nodeId), ['start', 'check', 'skip', 'end']);
  assert.deepEqual(notTaken.context.output, { skip: 'action:skip' });
});

test('a shared successor is still activated by another traversed edge', () => {
  const workflow = {
    id: 'shared', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['check', 'b'] },
      { id: 'check', type: 'condition', condition: { field: 'use', operator: 'eq', value: true }, then: ['c'], else: ['c'] },
      { id: 'b', type: 'action', next: 'c' },
      { id: 'c', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  for (const use of [true, false]) {
    const execution = executeWorkflow(workflow, { use });
    assert.equal(execution.status, 'completed');
    assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'check', 'b', 'c', 'end']);
  }
});

test('reaching an end does not terminate other activated branches early', () => {
  const workflow = {
    id: 'no-early', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'end'] },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'end']);
  assert.deepEqual(execution.context.output, { a: 'action:a' });
});

test('a failed form stops the whole run, leaving other branches unexecuted', () => {
  const workflow = {
    id: 'fail-fast', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'form', next: 'end', schema: { fields: [{ path: 'x', type: 'string', required: true }] } },
      { id: 'b', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a']);
  assert.deepEqual(execution.context.output, {});
});

// --- dependsOn ----------------------------------------------------------------

test('dependsOn delays a node until its dependencies complete, but never activates it', () => {
  const workflow = {
    id: 'join', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'c' },
      { id: 'b', type: 'action', dependsOn: ['c'], next: 'end' },
      { id: 'c', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'c', 'b', 'end']);
  assert.deepEqual(execution.context.output, { a: 'action:a', c: 'action:c', b: 'action:b' });
});

test('a node that is never activated is not executed and produces no output', () => {
  const workflow = {
    id: 'dormant', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'b', type: 'action', next: 'end' },
      { id: 'c', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b', 'end']);
  assert.deepEqual(execution.context.output, { a: 'action:a', b: 'action:b' });
  assert.equal(execution.context.output.c, undefined);
});

test('returns blocked with waiting nodes and their missing dependencies in declaration order', () => {
  const workflow = {
    id: 'blocked', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'b', type: 'action', dependsOn: ['d', 'c'], next: 'end' },
      { id: 'c', type: 'action', next: 'end' },
      { id: 'd', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'blocked');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'end']);
  assert.deepEqual(execution.blockedNodes, [
    { nodeId: 'b', missingDependencies: ['c', 'd'] },
  ]);
  assert.deepEqual(execution.context.output, { a: 'action:a' });
});

test('blocked lists every waiting node in declaration order', () => {
  const workflow = {
    id: 'blocked-many', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', dependsOn: ['c'], next: 'end' },
      { id: 'b', type: 'action', dependsOn: ['c'], next: 'end' },
      { id: 'c', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'blocked');
  assert.deepEqual(execution.blockedNodes, [
    { nodeId: 'a', missingDependencies: ['c'] },
    { nodeId: 'b', missingDependencies: ['c'] },
  ]);
});

test('an end node can wait on dependencies before producing its result', () => {
  const workflow = {
    id: 'end-join', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'b', type: 'action', next: 'end' },
      { id: 'end', type: 'end', dependsOn: ['a', 'b'], result: 'joined' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'joined');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'b', 'end']);
});

test('dependencies are satisfied only by completed nodes, not merely activated ones', () => {
  const workflow = {
    id: 'timing', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'c' },
      { id: 'b', type: 'action', dependsOn: ['c'], next: 'end' },
      { id: 'c', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  // b is declared before c, but must wait until c completes.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'a', 'c', 'b', 'end']);
});

// --- single end rule ----------------------------------------------------------

test('workflows using array successors or dependsOn must have exactly one end', () => {
  const twoEnds = {
    id: 'two', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'end', result: 'a' },
      { id: 'b', type: 'end', result: 'b' },
    ],
  };
  assert.throws(() => validateWorkflow(twoEnds), /exactly one end node/);

  const dependsTwoEnds = {
    id: 'two-dep', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', dependsOn: ['b'], next: 'end1' },
      { id: 'b', type: 'end', result: 'b' },
      { id: 'end1', type: 'end', result: 'e1' },
    ],
  };
  assert.throws(() => validateWorkflow(dependsTwoEnds), /exactly one end node/);

  // Legacy workflows with plain string outlets keep allowing multiple ends.
  const legacy = {
    id: 'legacy', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'x', operator: 'exists' }, then: 'a', else: 'b' },
      { id: 'a', type: 'end', result: 'a' },
      { id: 'b', type: 'end', result: 'b' },
    ],
  };
  assert.doesNotThrow(() => validateWorkflow(legacy));
});

// --- definition validation ----------------------------------------------------

test('rejects malformed successor arrays', () => {
  const base = {
    id: 'bad', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const cases = [
    [w => { w.nodes[0].next = []; }, /empty array/],
    [w => { w.nodes[0].next = ['a', 'a']; }, /duplicate ids/],
    [w => { w.nodes[0].next = ['a', 1]; }, /only node ids/],
    [w => { w.nodes[0].next = ['missing']; }, /unknown destination/],
    [w => { w.nodes[0].next = 'missing'; }, /unknown destination/],
    [w => { w.nodes[0].next = null; }, /unknown destination/],
  ];
  for (const [mutate, matcher] of cases) {
    const workflow = structuredClone(base);
    mutate(workflow);
    assert.throws(() => validateWorkflow(workflow), matcher);
  }
});

test('rejects malformed dependsOn declarations', () => {
  const base = {
    id: 'bad-dep', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const cases = [
    [w => { w.nodes[1].dependsOn = 'a'; }, /dependsOn must be an array/],
    [w => { w.nodes[1].dependsOn = [1]; }, /only node ids/],
    [w => { w.nodes[1].dependsOn = ['missing']; }, /unknown node/],
    [w => { w.nodes[1].dependsOn = ['a']; }, /must not reference itself/],
    [w => { w.nodes[1].dependsOn = ['end', 'end']; }, /duplicate ids/],
    [w => { w.nodes[0].dependsOn = ['a']; }, /entry node .* must not declare dependencies/],
  ];
  for (const [mutate, matcher] of cases) {
    const workflow = structuredClone(base);
    mutate(workflow);
    assert.throws(() => validateWorkflow(workflow), matcher);
  }
});

test('accepts an empty dependsOn array as the default', () => {
  const workflow = {
    id: 'empty-dep', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'a', dependsOn: [] },
      { id: 'a', type: 'action', next: 'end', dependsOn: [] },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

// --- cycle detection ----------------------------------------------------------

test('rejects cycles over flow edges, dependency edges, or both', () => {
  const flowCycle = {
    id: 'flow', entry: 'a', nodes: [
      { id: 'a', type: 'trigger', next: 'b' },
      { id: 'b', type: 'action', next: 'a' },
    ],
  };
  assert.throws(() => validateWorkflow(flowCycle), /cycle is present: a -> b -> a/);

  const dependencyCycle = {
    id: 'dep', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', dependsOn: ['b'], next: 'end' },
      { id: 'b', type: 'action', dependsOn: ['a'], next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(dependencyCycle), /cycle is present: a -> b -> a/);

  const mixedCycle = {
    id: 'mixed', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', next: 'b', dependsOn: ['b'] },
      { id: 'b', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(mixedCycle), /cycle is present: a -> b -> a/);
});

test('cycle detection includes unreachable nodes and unselected branches', () => {
  const workflow = {
    id: 'unreachable-cycle', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
      { id: 'a', type: 'action', next: 'b' },
      { id: 'b', type: 'action', next: 'a' },
    ],
  };
  assert.throws(() => validateWorkflow(workflow), /cycle is present: a -> b -> a/);
});

test('cycle chains start and end with the same id and each step is a real relation', () => {
  const workflow = {
    id: 'chain', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', next: 'b' },
      { id: 'b', type: 'action', next: 'c' },
      { id: 'c', type: 'action', next: 'a', dependsOn: ['b'] },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  try {
    validateWorkflow(workflow);
    assert.fail('expected a cycle error');
  } catch (error) {
    assert.match(error.message, /cycle is present: a -> b -> c -> a/);
  }
});

// --- immutability across runs -------------------------------------------------

test('array successors and dependencies never mutate the definition or caller input', () => {
  const workflow = {
    id: 'immutable', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'form', next: 'end', schema: { fields: [{ path: 'x', type: 'number', default: 1 }] } },
      { id: 'b', type: 'action', dependsOn: ['a'], next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const definitionSnapshot = JSON.stringify(workflow);
  const caller = { y: 2 };
  const inputSnapshot = JSON.stringify(caller);

  const first = executeWorkflow(workflow, caller);
  const second = executeWorkflow(workflow, caller);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.deepEqual(first.context.output, second.context.output);
  assert.deepEqual(first.context.input, second.context.input);

  assert.equal(JSON.stringify(workflow), definitionSnapshot);
  assert.equal(JSON.stringify(caller), inputSnapshot);
});

test('multiple runs have independent state and outputs', () => {
  const workflow = {
    id: 'independent', entry: 'start', nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'end' },
      { id: 'b', type: 'action', next: 'end' },
      { id: 'end', type: 'end', result: 'done' },
    ],
  };
  const first = executeWorkflow(workflow, {});
  const second = executeWorkflow(workflow, {});
  assert.notEqual(first.context, second.context);
  assert.notEqual(first.trace, second.trace);
  assert.deepEqual(first.context.output, second.context.output);
});


