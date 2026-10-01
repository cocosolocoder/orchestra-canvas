const NODE_TYPES = new Set(['trigger', 'form', 'condition', 'action', 'end']);
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const STRING_BOUNDS = new Set(['minLength', 'maxLength']);
const NUMBER_BOUNDS = new Set(['min', 'max']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function isUsableObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueMatchesType(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'number') return false;
  if (type === 'number') return Number.isFinite(value);
  return Number.isInteger(value);
}

function valueSatisfiesBounds(value, spec) {
  if (spec.type === 'string') {
    const length = [...value].length;
    if (spec.minLength !== undefined && length < spec.minLength) return false;
    if (spec.maxLength !== undefined && length > spec.maxLength) return false;
  } else if (spec.type === 'number' || spec.type === 'integer') {
    if (spec.min !== undefined && value < spec.min) return false;
    if (spec.max !== undefined && value > spec.max) return false;
  }
  return true;
}

function compileFormSchema(node) {
  if (!Object.hasOwn(node, 'schema') || node.schema === undefined) return null;
  if (!isUsableObject(node.schema)) {
    throw new Error(`form node ${node.id}: schema must be an object`);
  }
  if (!Array.isArray(node.schema.fields)) {
    throw new Error(`form node ${node.id}: schema.fields must be an array`);
  }

  const seenSegments = [];
  const compiled = [];
  node.schema.fields.forEach((field, index) => {
    const label = `form node ${node.id} field ${field && isUsableObject(field) && typeof field.path === 'string' && field.path ? field.path : `#${index}`}`;
    if (!isUsableObject(field)) {
      throw new Error(`${label}: field must be an object`);
    }
    if (typeof field.path !== 'string' || field.path.length === 0) {
      throw new Error(`form node ${node.id} field #${index}: path must be a non-empty string`);
    }
    const segments = field.path.split('.');
    if (segments.some(part => part.length === 0)) {
      throw new Error(`${label}: path must not contain empty segments`);
    }
    if (segments.some(part => FORBIDDEN_SEGMENTS.has(part))) {
      throw new Error(`${label}: path must not contain __proto__, prototype or constructor segments`);
    }
    for (const previous of seenSegments) {
      const shared = Math.min(previous.length, segments.length);
      let prefix = true;
      for (let i = 0; i < shared; i += 1) {
        if (previous[i] !== segments[i]) { prefix = false; break; }
      }
      if (prefix && previous.length === segments.length) {
        throw new Error(`${label}: duplicate field path`);
      }
      if (prefix) {
        throw new Error(`${label}: field paths must not be parent and child of each other`);
      }
    }
    seenSegments.push(segments);

    if (!FIELD_TYPES.has(field.type)) {
      throw new Error(`${label}: unknown field type ${field.type}`);
    }
    const spec = { path: field.path, segments, type: field.type, required: false, hasDefault: false };

    if (Object.hasOwn(field, 'required')) {
      if (typeof field.required !== 'boolean') {
        throw new Error(`${label}: required must be a boolean`);
      }
      spec.required = field.required;
    }

    const applicableBounds = field.type === 'string' ? STRING_BOUNDS
      : (field.type === 'number' || field.type === 'integer') ? NUMBER_BOUNDS
      : new Set();
    for (const bound of ['minLength', 'maxLength', 'min', 'max']) {
      if (!Object.hasOwn(field, bound) || field[bound] === undefined) continue;
      if (!applicableBounds.has(bound)) {
        throw new Error(`${label}: ${bound} does not apply to ${field.type} fields`);
      }
      const value = field[bound];
      if (field.type === 'string') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new Error(`${label}: ${bound} must be a non-negative integer`);
        }
      } else if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label}: ${bound} must be a finite number`);
      }
      spec[bound] = value;
    }
    if (spec.minLength !== undefined && spec.maxLength !== undefined && spec.minLength > spec.maxLength) {
      throw new Error(`${label}: minLength must not be greater than maxLength`);
    }
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
      throw new Error(`${label}: min must not be greater than max`);
    }

    if (Object.hasOwn(field, 'default') && field.default !== undefined) {
      const fallback = field.default;
      if (!valueMatchesType(fallback, spec.type)) {
        throw new Error(`${label}: default value does not match field type ${spec.type}`);
      }
      if (!valueSatisfiesBounds(fallback, spec)) {
        throw new Error(`${label}: default value violates field constraints`);
      }
      spec.hasDefault = true;
      spec.default = fallback;
    }

    compiled.push(spec);
  });

  return compiled;
}

const MAX_CONDITION_DEPTH = 32;

function parsePathSegments(path, label) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`${label}: path must be a non-empty string`);
  }
  const segments = path.split('.');
  if (segments.some(part => part.length === 0)) {
    throw new Error(`${label}: path must not contain empty segments`);
  }
  if (segments.some(part => FORBIDDEN_SEGMENTS.has(part))) {
    throw new Error(`${label}: path must not contain __proto__, prototype or constructor segments`);
  }
  return segments;
}

function isComparableConstant(value) {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function toComparableNumber(value) {
  // Objects and arrays never participate in numeric comparison, even though
  // Number([]) === 0; everything else uses JS numeric conversion.
  if (value !== null && typeof value === 'object') return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

// Walks every condition node (including untaken branches) and turns it into a
// pre-validated, pre-resolved structure. Any malformed condition throws with a
// node id and a `$`-style child position, before the workflow can execute.
function compileCondition(condition, nodeId, position = '$', depth = 1) {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new Error(`condition node ${nodeId} at ${position}: conditions must not be nested deeper than ${MAX_CONDITION_DEPTH} levels`);
  }
  if (!isUsableObject(condition)) {
    throw new Error(`condition node ${nodeId} at ${position}: condition must be an object`);
  }

  const comboKeys = [];
  if (Object.hasOwn(condition, 'all')) comboKeys.push('all');
  if (Object.hasOwn(condition, 'any')) comboKeys.push('any');
  if (Object.hasOwn(condition, 'not')) comboKeys.push('not');
  if (comboKeys.length > 1) {
    throw new Error(`condition node ${nodeId} at ${position}: condition must use only one of all, any or not`);
  }

  const comparisonKeys = ['field', 'operator', 'value', 'valueField'];
  const presentComparisonKeys = comparisonKeys.filter(key => Object.hasOwn(condition, key));

  if (comboKeys.length === 1) {
    if (presentComparisonKeys.length > 0) {
      throw new Error(`condition node ${nodeId} at ${position}: ${comboKeys[0]} condition must not mix in field, operator, value or valueField`);
    }
    const key = comboKeys[0];
    if (key === 'not') {
      return { kind: 'not', child: compileCondition(condition.not, nodeId, `${position}.not`, depth + 1) };
    }
    if (!Array.isArray(condition[key])) {
      throw new Error(`condition node ${nodeId} at ${position}: ${key} must be an array of conditions`);
    }
    if (condition[key].length === 0) {
      throw new Error(`condition node ${nodeId} at ${position}: ${key} must not be empty`);
    }
    return {
      kind: key,
      children: condition[key].map((child, index) =>
        compileCondition(child, nodeId, `${position}.${key}[${index}]`, depth + 1)),
    };
  }

  const where = `condition node ${nodeId} at ${position}`;
  if (!Object.hasOwn(condition, 'field') || !Object.hasOwn(condition, 'operator')) {
    throw new Error(`${where}: condition must be a comparison (field and operator) or a compound (all, any or not)`);
  }
  const segments = parsePathSegments(condition.field, `${where} field`);

  if (!['eq', 'gte', 'lte', 'exists'].includes(condition.operator)) {
    throw new Error(`${where}: unknown condition operator: ${condition.operator}`);
  }

  const unexpected = presentComparisonKeys.filter(key => key !== 'field' && key !== 'operator');
  if (condition.operator === 'exists') {
    if (unexpected.length > 0) {
      throw new Error(`${where}: exists only takes field and operator`);
    }
    return { kind: 'comparison', operator: 'exists', segments };
  }

  const hasValue = Object.hasOwn(condition, 'value');
  const hasValueField = Object.hasOwn(condition, 'valueField');
  if (hasValue === hasValueField) {
    throw new Error(`${where}: condition must specify exactly one of value or valueField`);
  }
  if (hasValueField) {
    if (typeof condition.valueField !== 'string') {
      throw new Error(`${where} valueField: path must be a non-empty string`);
    }
    return {
      kind: 'comparison', operator: condition.operator, segments,
      valueSegments: parsePathSegments(condition.valueField, `${where} valueField`),
    };
  }
  if (!isComparableConstant(condition.value)) {
    throw new Error(`${where}: value must be a string, finite number, boolean or null`);
  }
  const compiled = { kind: 'comparison', operator: condition.operator, segments, value: condition.value };
  if (condition.operator !== 'eq') {
    compiled.numericValue = toComparableNumber(condition.value);
    if (compiled.numericValue === null) {
      throw new Error(`${where}: value for ${condition.operator} must convert to a finite number`);
    }
  }
  return compiled;
}

const formSchemas = new WeakMap();
const compiledConditions = new WeakMap();

// Resolves a single outlet (next / then / else) to a list of successor ids.
// A plain string is a single successor; a non-empty string array activates
// every successor; anything else is a malformed definition.
function parseOutlet(node, key, nodes) {
  const value = node[key];
  if (typeof value === 'string') {
    if (!nodes.has(value)) throw new Error(`node ${node.id} points to an unknown destination`);
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`node ${node.id}: ${key} must not be an empty array`);
    const ids = [];
    const seen = new Set();
    for (const id of value) {
      if (typeof id !== 'string') throw new Error(`node ${node.id}: ${key} must contain only node ids`);
      if (!nodes.has(id)) throw new Error(`node ${node.id} points to an unknown destination`);
      if (seen.has(id)) throw new Error(`node ${node.id}: ${key} must not contain duplicate ids`);
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }
  throw new Error(`node ${node.id} points to an unknown destination`);
}

// Resolves a node's explicit dependencies. Dependencies only decide when a
// node may run; they never activate it. An empty array is the default.
function parseDependencies(node, nodes, isEntry) {
  if (!Object.hasOwn(node, 'dependsOn') || node.dependsOn === undefined) return [];
  if (!Array.isArray(node.dependsOn)) throw new Error(`node ${node.id}: dependsOn must be an array`);
  if (node.dependsOn.length === 0) return [];
  if (isEntry) throw new Error(`entry node ${node.id} must not declare dependencies`);
  const ids = [];
  const seen = new Set();
  for (const id of node.dependsOn) {
    if (typeof id !== 'string') throw new Error(`node ${node.id}: dependsOn must contain only node ids`);
    if (!nodes.has(id)) throw new Error(`node ${node.id} depends on an unknown node: ${id}`);
    if (id === node.id) throw new Error(`node ${node.id}: dependsOn must not reference itself`);
    if (seen.has(id)) throw new Error(`node ${node.id}: dependsOn must not contain duplicate ids`);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// Detects cycles over the union of flow edges (outlets) and dependency
// precedence edges. "b dependsOn a" means a must precede b, so the precedence
// edge is a -> b (dependency -> dependent). Includes nodes no branch ever
// reaches. The reported chain starts and ends with the same id, and every
// step is a real outlet or dependency precedence relation.
function detectCycle(workflow, successors, dependencies) {
  const precedence = new Map();
  for (const node of workflow.nodes) precedence.set(node.id, []);
  for (const node of workflow.nodes) {
    for (const succ of successors.get(node.id)) {
      precedence.get(node.id).push(succ);
    }
    for (const dep of dependencies.get(node.id)) {
      precedence.get(dep).push(node.id);
    }
  }

  const color = new Map();
  for (const node of workflow.nodes) color.set(node.id, 0);
  for (const startNode of workflow.nodes) {
    if (color.get(startNode.id) !== 0) continue;
    const path = [startNode.id];
    const stack = [{ id: startNode.id, edgeIndex: 0 }];
    color.set(startNode.id, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = precedence.get(frame.id);
      if (frame.edgeIndex < edges.length) {
        const next = edges[frame.edgeIndex];
        frame.edgeIndex += 1;
        const state = color.get(next);
        if (state === 1) {
          const start = path.indexOf(next);
          const cycle = [...path.slice(start), next];
          throw new Error(`workflow cycle is present: ${cycle.join(' -> ')}`);
        }
        if (state === 0) {
          color.set(next, 1);
          path.push(next);
          stack.push({ id: next, edgeIndex: 0 });
        }
      } else {
        color.set(frame.id, 2);
        path.pop();
        stack.pop();
      }
    }
  }
}

export function validateWorkflow(workflow) {
  assertPlainObject(workflow, 'workflow');
  if (typeof workflow.id !== 'string' || !workflow.id.trim()) throw new Error('workflow.id is required');
  if (typeof workflow.entry !== 'string' || !workflow.entry.trim()) throw new Error('workflow.entry is required');
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) throw new Error('workflow.nodes must not be empty');

  const nodes = new Map();
  for (const node of workflow.nodes) {
    assertPlainObject(node, 'node');
    if (typeof node.id !== 'string' || !node.id.trim()) throw new Error('every node requires an id');
    if (nodes.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    if (!NODE_TYPES.has(node.type)) throw new Error(`unsupported node type: ${node.type}`);
    nodes.set(node.id, node);
  }
  if (!nodes.has(workflow.entry)) throw new Error(`entry node does not exist: ${workflow.entry}`);

  const successors = new Map();
  const dependencies = new Map();
  let usesBranching = false;

  for (const node of workflow.nodes) {
    let nodeSuccessors;
    if (node.type === 'condition') {
      const thenIds = parseOutlet(node, 'then', nodes);
      const elseIds = parseOutlet(node, 'else', nodes);
      nodeSuccessors = [...thenIds, ...elseIds];
      if (Array.isArray(node.then) || Array.isArray(node.else)) usesBranching = true;
    } else if (node.type === 'end') {
      nodeSuccessors = [];
    } else {
      nodeSuccessors = parseOutlet(node, 'next', nodes);
      if (Array.isArray(node.next)) usesBranching = true;
    }
    successors.set(node.id, nodeSuccessors);

    const nodeDependencies = parseDependencies(node, nodes, node.id === workflow.entry);
    dependencies.set(node.id, nodeDependencies);
    if (nodeDependencies.length > 0) usesBranching = true;

    if (node.type === 'form') {
      formSchemas.set(node, compileFormSchema(node));
    }
    if (node.type === 'condition') {
      compiledConditions.set(node, compileCondition(node.condition, node.id));
    }
  }

  if (usesBranching) {
    const endCount = workflow.nodes.filter(node => node.type === 'end').length;
    if (endCount !== 1) {
      throw new Error('workflow with array successors or dependencies must have exactly one end node');
    }
  }

  detectCycle(workflow, successors, dependencies);

  return nodes;
}

function lookupOwn(root, segments) {
  let current = root;
  for (const part of segments) {
    if (!isUsableObject(current) || !Object.hasOwn(current, part)) {
      return { exists: false };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

// Evaluates a compiled condition against the cloned execution input. Compounds
// short-circuit in declaration order, so a bad value inside a skipped child is
// never observed. A non-skipped numeric comparison whose inputs cannot convert
// to finite numbers is reported as an invalid_condition error instead.
function runCondition(compiled, input, nodeId, position = '$') {
  if (compiled.kind === 'not') {
    const child = runCondition(compiled.child, input, nodeId, `${position}.not`);
    if (!child.ok) return child;
    return { ok: true, value: !child.value };
  }
  if (compiled.kind === 'all' || compiled.kind === 'any') {
    for (let i = 0; i < compiled.children.length; i += 1) {
      const child = runCondition(compiled.children[i], input, nodeId, `${position}.${compiled.kind}[${i}]`);
      if (!child.ok) return child;
      if (compiled.kind === 'all' && !child.value) return { ok: true, value: false };
      if (compiled.kind === 'any' && child.value) return { ok: true, value: true };
    }
    return { ok: true, value: compiled.kind === 'all' };
  }

  const where = `condition node ${nodeId} at ${position}`;
  const left = lookupOwn(input, compiled.segments);
  if (!left.exists) return { ok: true, value: false };

  if (compiled.operator === 'exists') return { ok: true, value: true };

  let right;
  if (compiled.valueSegments) {
    const lookedUp = lookupOwn(input, compiled.valueSegments);
    if (!lookedUp.exists) return { ok: true, value: false };
    right = lookedUp.value;
  } else {
    right = compiled.value;
  }

  if (compiled.operator === 'eq') {
    return { ok: true, value: left.value === right };
  }

  const leftNumber = toComparableNumber(left.value);
  if (leftNumber === null) {
    return { ok: false, error: `${where}: value at field cannot convert to a finite number` };
  }
  let rightNumber;
  if (compiled.valueSegments) {
    rightNumber = toComparableNumber(right);
    if (rightNumber === null) {
      return { ok: false, error: `${where}: value at valueField cannot convert to a finite number` };
    }
  } else {
    rightNumber = compiled.numericValue;
  }
  if (compiled.operator === 'gte') return { ok: true, value: leftNumber >= rightNumber };
  return { ok: true, value: leftNumber <= rightNumber };
}

function applyDefault(root, segments, value) {
  let current = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const part = segments[i];
    if (Object.hasOwn(current, part)) {
      const next = current[part];
      if (!isUsableObject(next)) return false;
      current = next;
    } else {
      const created = {};
      current[part] = created;
      current = created;
    }
  }
  current[segments[segments.length - 1]] = value;
  return true;
}

function processFormField(spec, input, nodeId) {
  const error = code => ({ nodeId, path: spec.path, code });
  const { exists, value } = lookupOwn(input, spec.segments);

  if (!exists) {
    if (spec.hasDefault) {
      if (!isUsableObject(input) || !applyDefault(input, spec.segments, spec.default)) {
        return error('type');
      }
      return null;
    }
    return spec.required ? error('required') : null;
  }

  if (!valueMatchesType(value, spec.type)) return error('type');
  if (!valueSatisfiesBounds(value, spec)) {
    return error(spec.type === 'string' ? 'length' : 'range');
  }
  return null;
}

function processForm(node, input, compiled) {
  const snapshot = structuredClone(input);
  const errors = [];
  for (const spec of compiled) {
    const fieldError = processFormField(spec, input, node.id);
    if (fieldError) errors.push(fieldError);
  }
  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors, rollback: snapshot };
}

function normalizeOutlet(value) {
  return Array.isArray(value) ? value : [value];
}

// Runs the workflow as a deterministic scheduler. The entry node starts
// activated; other nodes activate only when a traversed outlet reaches them
// (dependencies never activate). Each turn picks the first activated node
// whose explicit dependencies have all completed, in nodes declaration order.
// A node runs at most once. When nothing can run, either all activated nodes
// completed (completed) or some wait on dependencies that may never arrive
// (blocked).
export function executeWorkflow(workflow, input = {}) {
  const nodes = validateWorkflow(workflow);
  const nodeIndex = new Map();
  workflow.nodes.forEach((node, index) => nodeIndex.set(node.id, index));
  const trace = [];
  const context = { input: structuredClone(input), output: {} };

  const activated = new Set([workflow.entry]);
  const completed = new Set();

  const dependenciesOf = node => node.dependsOn ?? [];

  while (true) {
    let current = null;
    for (const node of workflow.nodes) {
      if (!activated.has(node.id) || completed.has(node.id)) continue;
      if (dependenciesOf(node).every(id => completed.has(id))) {
        current = node;
        break;
      }
    }

    if (current === null) {
      const waiting = workflow.nodes.filter(node => activated.has(node.id) && !completed.has(node.id));
      if (waiting.length === 0) {
        const endNode = workflow.nodes.find(node => node.type === 'end' && completed.has(node.id));
        return { status: 'completed', result: endNode ? (endNode.result ?? null) : null, context, trace };
      }
      const blockedNodes = waiting.map(node => ({
        nodeId: node.id,
        missingDependencies: dependenciesOf(node)
          .filter(id => !completed.has(id))
          .sort((a, b) => nodeIndex.get(a) - nodeIndex.get(b)),
      }));
      return { status: 'blocked', context, trace, blockedNodes };
    }

    trace.push({ nodeId: current.id, type: current.type });

    if (current.type === 'end') {
      completed.add(current.id);
      continue;
    }
    if (current.type === 'action') {
      context.output[current.id] = current.message ?? `action:${current.id}`;
      for (const id of normalizeOutlet(current.next)) activated.add(id);
      completed.add(current.id);
      continue;
    }
    if (current.type === 'form') {
      const compiled = formSchemas.get(current);
      if (compiled) {
        const formResult = processForm(current, context.input, compiled);
        if (!formResult.ok) {
          context.input = formResult.rollback;
          return { status: 'invalid_input', context, trace, errors: formResult.errors };
        }
      }
      for (const id of normalizeOutlet(current.next)) activated.add(id);
      completed.add(current.id);
      continue;
    }
    if (current.type === 'condition') {
      const outcome = runCondition(compiledConditions.get(current), context.input, current.id);
      if (!outcome.ok) {
        return { status: 'invalid_condition', context, trace, error: outcome.error };
      }
      for (const id of normalizeOutlet(outcome.value ? current.then : current.else)) {
        activated.add(id);
      }
      completed.add(current.id);
      continue;
    }
    // trigger
    for (const id of normalizeOutlet(current.next)) {
      activated.add(id);
    }
    completed.add(current.id);
  }
}
