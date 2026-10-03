import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, executeWorkflowAsync, validateWorkflow } from '../src/engine.js';

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

function branchingWorkflow() {
  return {
    id: 'branching',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'collect' },
      { id: 'collect', type: 'form', next: ['notify', 'audit'], schema: { fields: [
        { path: 'score', type: 'number', default: 90 },
      ] } },
      { id: 'notify', type: 'action', message: 'notified', next: 'wrap' },
      { id: 'audit', type: 'action', message: 'audited', next: 'wrap' },
      { id: 'wrap', type: 'action', dependsOn: ['notify', 'audit'], next: 'done' },
      { id: 'done', type: 'end', result: 'finished' },
    ],
  };
}

test('array successors activate every branch and a shared join waits for all of them', () => {
  const execution = executeWorkflow(branchingWorkflow(), {});
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'finished');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'collect', 'notify', 'audit', 'wrap', 'done']);
  assert.deepEqual(execution.context.output, { notify: 'notified', audit: 'audited', wrap: 'action:wrap' });
  assert.deepEqual(execution.context.input, { score: 90 });
});

test('scheduling follows declaration order and dependencies only gate timing', () => {
  const workflow = {
    id: 'ordering', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['join', 'slow', 'fast'] },
      { id: 'join', type: 'action', dependsOn: ['slow', 'fast'], next: 'done' },
      { id: 'slow', type: 'action', next: 'done' },
      { id: 'fast', type: 'action', next: 'done' },
      { id: 'done', type: 'end', result: 'ordered' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  // join is declared first but waits for its dependencies; slow and fast run
  // in declaration order before join becomes eligible.
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'slow', 'fast', 'join', 'done']);
});

test('an unchosen condition exit does not activate its target but a shared successor still activates', () => {
  const workflow = {
    id: 'shared', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'vip', operator: 'eq', value: true }, then: 'priority', else: 'standard' },
      { id: 'priority', type: 'action', next: 'merge' },
      { id: 'standard', type: 'action', next: 'merge' },
      { id: 'merge', type: 'action', next: 'done' },
      { id: 'done', type: 'end', result: 'merged' },
    ],
  };
  const execution = executeWorkflow(workflow, { vip: false });
  assert.equal(execution.status, 'completed');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'check', 'standard', 'merge', 'done']);
  assert.deepEqual(Object.keys(execution.context.output), ['standard', 'merge']);
});

test('activated nodes waiting on never-completing dependencies report blocked with ordered details', () => {
  const workflow = {
    id: 'blocked', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'check' },
      { id: 'check', type: 'condition', condition: { field: 'vip', operator: 'eq', value: true }, then: 'priority', else: 'standard' },
      { id: 'priority', type: 'action', next: 'wrap' },
      { id: 'standard', type: 'action', next: 'wrap' },
      { id: 'wrap', type: 'action', dependsOn: ['standard', 'priority'], next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, { vip: true });
  assert.equal(execution.status, 'blocked');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'check', 'priority']);
  assert.deepEqual(Object.keys(execution.context.output), ['priority']);
  // missingDependencies follow nodes declaration order, not dependsOn order.
  assert.deepEqual(execution.blockedNodes, [{ nodeId: 'wrap', missingDependencies: ['standard'] }]);
});

test('other branches keep running while a node waits, and end does not finish the run early', () => {
  const workflow = {
    id: 'late-end', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['finish', 'work'] },
      { id: 'finish', type: 'end', result: 'early' },
      { id: 'work', type: 'action', next: 'more' },
      { id: 'more', type: 'action', next: 'finish' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'early');
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'finish', 'work', 'more']);
  assert.deepEqual(execution.context.output, { work: 'action:work', more: 'action:more' });
});

test('a failing form on one branch stops the run, rolls back its defaults and keeps prior output', () => {
  const workflow = {
    id: 'branch-failure', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['prep', 'collect'] },
      { id: 'prep', type: 'action', message: 'prepared', next: 'done' },
      { id: 'collect', type: 'form', next: 'done', schema: { fields: [
        { path: 'a.b', type: 'string', default: 'B' },
        { path: 'a.c', type: 'string', required: true },
      ] } },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  const execution = executeWorkflow(workflow, {});
  assert.equal(execution.status, 'invalid_input');
  assert.deepEqual(execution.context.input, {});
  assert.deepEqual(execution.context.output, { prep: 'prepared' });
  assert.deepEqual(execution.trace.map(n => n.nodeId), ['start', 'prep', 'collect']);
});

test('branching runs never mutate the definition or caller input and stay independent', () => {
  const workflow = branchingWorkflow();
  const definitionSnapshot = JSON.stringify(workflow);
  const caller = { note: 'hi' };
  const first = executeWorkflow(workflow, caller);
  const second = executeWorkflow(workflow, {});
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.deepEqual(caller, { note: 'hi' });
  assert.deepEqual(first.context.input, { note: 'hi', score: 90 });
  assert.deepEqual(second.context.input, { score: 90 });
  assert.equal(JSON.stringify(workflow), definitionSnapshot);
});

test('rejects malformed successor arrays and dependency declarations', () => {
  const base = () => ({
    id: 'invalid', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  });
  const withNodes = mutate => {
    const workflow = base();
    mutate(workflow);
    return workflow;
  };
  const cases = [
    [w => { w.nodes[0].next = []; }, /next array must not be empty/],
    [w => { w.nodes[0].next = ['done', 'done']; }, /duplicate destination/],
    [w => { w.nodes[0].next = [5]; }, /must be node id strings/],
    [w => { w.nodes[0].next = ['ghost']; }, /unknown destination/],
    [w => { w.nodes[0].dependsOn = 'done'; }, /dependsOn must be an array/],
    [w => { w.nodes[0].dependsOn = [null]; }, /must be node id strings/],
    [w => { w.nodes[1].dependsOn = ['start', 'start']; }, /duplicate dependency/],
    [w => { w.nodes[1].dependsOn = ['ghost']; }, /unknown node/],
    [w => { w.nodes[1].dependsOn = ['done']; }, /depend on itself/],
    [w => { w.nodes[0].dependsOn = ['done']; }, /entry node start must not declare dependencies/],
  ];
  for (const [mutate, matcher] of cases) {
    assert.throws(() => validateWorkflow(withNodes(mutate)), matcher);
  }
});

test('workflows using array successors or dependsOn must declare exactly one end node', () => {
  const twoEnds = {
    id: 'ends', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'end', result: 'a' },
      { id: 'b', type: 'end', result: 'b' },
    ],
  };
  assert.throws(() => validateWorkflow(twoEnds), /exactly one end node/);

  const noEnd = {
    id: 'ends', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'b' },
      { id: 'b', type: 'action', next: 'a' },
    ],
  };
  assert.throws(() => validateWorkflow(noEnd), /exactly one end node|cycle is present/);

  // Legacy single-successor workflows keep allowing multiple end nodes.
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

test('rejects cycles formed by edges, dependencies or both, including unreachable nodes', () => {
  const edgeCycle = {
    id: 'c1', entry: 'a',
    nodes: [
      { id: 'a', type: 'trigger', next: 'b' },
      { id: 'b', type: 'action', next: 'a' },
    ],
  };
  assert.throws(() => validateWorkflow(edgeCycle), /cycle is present: a -> b -> a/);

  const dependencyCycle = {
    id: 'c2', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'x', type: 'action', dependsOn: ['y'], next: 'done' },
      { id: 'y', type: 'action', dependsOn: ['x'], next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(dependencyCycle), /cycle is present: x -> y -> x/);

  const mixedCycle = {
    id: 'c3', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'a' },
      { id: 'a', type: 'action', dependsOn: ['b'], next: 'b' },
      { id: 'b', type: 'action', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  assert.throws(() => validateWorkflow(mixedCycle), /cycle is present: a -> b -> a/);

  const unreachableCycle = {
    id: 'c4', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
      { id: 'lost1', type: 'action', next: 'lost2' },
      { id: 'lost2', type: 'action', next: 'lost1' },
    ],
  };
  assert.throws(() => executeWorkflow(unreachableCycle, {}), /cycle is present: lost1 -> lost2 -> lost1/);
});

const LONG_CHAIN_SIZE = 20000;

// trigger n0 -> action n1 -> ... -> action n19998 -> end n19999
function successorChainWorkflow(size = LONG_CHAIN_SIZE) {
  const nodes = [{ id: 'n0', type: 'trigger', next: 'n1' }];
  for (let i = 1; i < size - 1; i += 1) {
    nodes.push({ id: `n${i}`, type: 'action', next: `n${i + 1}` });
  }
  nodes.push({ id: `n${size - 1}`, type: 'end', result: 'done' });
  return { id: 'long-edge-chain', entry: 'n0', nodes };
}

// The ordering chain is carried by explicit dependencies: d1 may run only
// after d0, d2 only after d1, and so on; successor edges just converge on
// the single end node.
function dependencyChainWorkflow(size = LONG_CHAIN_SIZE) {
  const nodes = [{ id: 'd0', type: 'trigger', next: 'done' }];
  for (let i = 1; i < size; i += 1) {
    nodes.push({ id: `d${i}`, type: 'action', dependsOn: [`d${i - 1}`], next: 'done' });
  }
  nodes.push({ id: 'done', type: 'end', result: 'done' });
  return { id: 'long-dependency-chain', entry: 'd0', nodes };
}

function cycleChainFrom(error) {
  return error.message.slice('cycle is present: '.length).split(' -> ');
}

function expectCycleError(validate) {
  try {
    validate();
  } catch (error) {
    assert.match(error.message, /cycle is present: /);
    return error;
  }
  assert.fail('expected a cycle error');
}

test('accepts a legal twenty-thousand-node chain joined by successors', () => {
  assert.doesNotThrow(() => validateWorkflow(successorChainWorkflow()));
});

test('accepts a legal twenty-thousand-node chain joined by explicit dependencies', () => {
  assert.doesNotThrow(() => validateWorkflow(dependencyChainWorkflow()));
});

test('validation of a long chain does not mutate the user definition', () => {
  const workflow = successorChainWorkflow();
  const snapshot = structuredClone(workflow);
  validateWorkflow(workflow);
  assert.deepEqual(workflow, snapshot);
});

test('a legal twenty-thousand-node chain executes to the end, synchronously and async', async () => {
  const syncResult = executeWorkflow(successorChainWorkflow(), {});
  assert.equal(syncResult.status, 'completed');
  assert.equal(syncResult.result, 'done');
  assert.equal(syncResult.trace.length, LONG_CHAIN_SIZE);

  const asyncResult = await executeWorkflowAsync(successorChainWorkflow(), {});
  assert.equal(asyncResult.status, 'completed');
  assert.equal(asyncResult.result, 'done');
  assert.equal(asyncResult.trace.length, LONG_CHAIN_SIZE);
});

test('a back edge at the end of a long chain reports only the cycle segment', () => {
  const workflow = successorChainWorkflow();
  // Turn the end node into an action whose successor jumps back up the chain.
  workflow.nodes[LONG_CHAIN_SIZE - 1] = { id: `n${LONG_CHAIN_SIZE - 1}`, type: 'action', next: 'n5000' };

  const error = expectCycleError(() => validateWorkflow(workflow));
  const chain = cycleChainFrom(error);
  assert.equal(chain[0], 'n5000');
  assert.equal(chain[chain.length - 1], 'n5000');
  assert.equal(chain.length, LONG_CHAIN_SIZE - 5000 + 1);
  for (let i = 0; i < chain.length - 2; i += 1) {
    assert.equal(chain[i], `n${5000 + i}`);
  }
  assert.equal(chain[chain.length - 2], `n${LONG_CHAIN_SIZE - 1}`);
});

test('a cycle mixing successors and dependencies deep in a chain names only real relations', () => {
  const workflow = successorChainWorkflow();
  // n19900 may run only after n19998, while successors already order
  // n19900 -> ... -> n19998: the two relation kinds together close a cycle.
  workflow.nodes[19900] = {
    id: 'n19900', type: 'action', next: 'n19901', dependsOn: ['n19998'],
  };

  const error = expectCycleError(() => validateWorkflow(workflow));
  const chain = cycleChainFrom(error);
  assert.equal(chain[0], 'n19900');
  assert.equal(chain[chain.length - 1], 'n19900');
  assert.equal(chain[chain.length - 2], 'n19998');

  // Every step of the reported chain must be a real successor edge or a
  // real "runs after" dependency relation in the definition.
  const successorEdges = new Set();
  const dependencyEdges = new Set();
  for (const node of workflow.nodes) {
    const targets = node.type === 'condition' ? [node.then, node.else]
      : node.type === 'end' ? []
      : Array.isArray(node.next) ? node.next : [node.next];
    for (const target of targets) successorEdges.add(`${node.id}->${target}`);
    for (const dependency of node.dependsOn ?? []) dependencyEdges.add(`${dependency}->${node.id}`);
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    const step = `${chain[i]}->${chain[i + 1]}`;
    assert.ok(successorEdges.has(step) || dependencyEdges.has(step), `unrelated step in cycle chain: ${step}`);
  }
  assert.ok(dependencyEdges.has('n19998->n19900'));
});

test('multiple branches converging on one node is not a cycle', () => {
  const converging = {
    id: 'join', entry: 'start',
    nodes: [
      { id: 'start', type: 'trigger', next: ['a', 'b'] },
      { id: 'a', type: 'action', next: 'join' },
      { id: 'b', type: 'action', next: 'join' },
      { id: 'join', type: 'action', next: 'done' },
      { id: 'done', type: 'end', result: 'done' },
    ],
  };
  assert.doesNotThrow(() => validateWorkflow(converging));
});

test('a healthy entry section does not rescue a definition cycled elsewhere', () => {
  const size = 1000;
  const workflow = successorChainWorkflow(size);
  workflow.id = 'partial-cycle';
  // A disconnected component with its own two-node edge cycle.
  workflow.nodes.push(
    { id: 'lost1', type: 'action', next: 'lost2' },
    { id: 'lost2', type: 'action', next: 'lost1' },
  );
  assert.throws(() => validateWorkflow(workflow), /cycle is present: lost1 -> lost2 -> lost1/);
});

test('sync and async runs reject a definition cycle before any node can run', async () => {
  // The action names an operation that has no implementation; the cycle
  // must still win over operation checks, business failures or dependency
  // blocking, before a single node executes.
  const cyclic = {
    id: 'op-cycle', entry: 'a',
    nodes: [
      { id: 'a', type: 'trigger', next: 'b' },
      { id: 'b', type: 'action', operation: 'charge', next: 'a' },
    ],
  };
  assert.throws(() => executeWorkflow(cyclic), /cycle is present: a -> b -> a/);
  await assert.rejects(executeWorkflowAsync(cyclic, {}, {}), /cycle is present: a -> b -> a/);
});

