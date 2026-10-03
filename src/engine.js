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

// Validates an output reference of the shape
// `{ "nodeId": "risk-check", "path": "risk.score" }` (path optional). The
// reference itself must be a non-array object, nodeId must name an action
// node in this definition (matched as a whole string — dots are literal),
// and path, when present, follows the same segment rules as input paths.
function compileOutputReference(ref, nodes, label) {
  if (!isUsableObject(ref)) {
    throw new Error(`${label}: output reference must be a non-array object`);
  }
  if (typeof ref.nodeId !== 'string' || ref.nodeId.length === 0) {
    throw new Error(`${label}: nodeId must be a non-empty string naming an action node`);
  }
  const target = nodes.get(ref.nodeId);
  if (!target) {
    throw new Error(`${label}: nodeId "${ref.nodeId}" does not name a node in this workflow`);
  }
  if (target.type !== 'action') {
    throw new Error(`${label}: nodeId "${ref.nodeId}" must name an action node`);
  }
  let segments = [];
  if (Object.hasOwn(ref, 'path')) {
    segments = parsePathSegments(ref.path, `${label} path`);
  }
  return { nodeId: ref.nodeId, segments };
}

// Walks every condition node (including untaken branches) and turns it into a
// pre-validated, pre-resolved structure. Any malformed condition throws with a
// node id and a `$`-style child position, before the workflow can execute.
function compileCondition(condition, nodes, nodeId, position = '$', depth = 1) {
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

  const comparisonKeys = ['field', 'outputField', 'operator', 'value', 'valueField', 'valueOutputField'];
  const presentComparisonKeys = comparisonKeys.filter(key => Object.hasOwn(condition, key));

  if (comboKeys.length === 1) {
    if (presentComparisonKeys.length > 0) {
      throw new Error(`condition node ${nodeId} at ${position}: ${comboKeys[0]} condition must not mix in field, outputField, operator, value, valueField or valueOutputField`);
    }
    const key = comboKeys[0];
    if (key === 'not') {
      return { kind: 'not', child: compileCondition(condition.not, nodes, nodeId, `${position}.not`, depth + 1) };
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
        compileCondition(child, nodes, nodeId, `${position}.${key}[${index}]`, depth + 1)),
    };
  }

  const where = `condition node ${nodeId} at ${position}`;
  const hasField = Object.hasOwn(condition, 'field');
  const hasOutputField = Object.hasOwn(condition, 'outputField');
  if ((!hasField && !hasOutputField) || !Object.hasOwn(condition, 'operator')) {
    throw new Error(`${where}: condition must be a comparison (field and operator) or a compound (all, any or not)`);
  }
  if (hasField && hasOutputField) {
    throw new Error(`${where}: condition must specify exactly one of field or outputField`);
  }

  if (!['eq', 'gte', 'lte', 'exists'].includes(condition.operator)) {
    throw new Error(`${where}: unknown condition operator: ${condition.operator}`);
  }

  let left;
  if (hasField) {
    left = { kind: 'input', label: 'field', segments: parsePathSegments(condition.field, `${where} field`) };
  } else {
    left = {
      kind: 'output', label: 'outputField',
      ref: compileOutputReference(condition.outputField, nodes, `${where} outputField`),
    };
  }

  if (condition.operator === 'exists') {
    const unexpected = presentComparisonKeys.filter(key =>
      key === 'value' || key === 'valueField' || key === 'valueOutputField');
    if (unexpected.length > 0) {
      throw new Error(`${where}: exists only takes field and operator (outputField may name the left side)`);
    }
    return { kind: 'comparison', operator: 'exists', left };
  }

  const hasValue = Object.hasOwn(condition, 'value');
  const hasValueField = Object.hasOwn(condition, 'valueField');
  const hasValueOutput = Object.hasOwn(condition, 'valueOutputField');
  const rightCount = [hasValue, hasValueField, hasValueOutput].filter(Boolean).length;
  if (rightCount !== 1) {
    throw new Error(`${where}: condition must specify exactly one of value or valueField (or valueOutputField)`);
  }

  let right;
  if (hasValue) {
    if (!isComparableConstant(condition.value)) {
      throw new Error(`${where}: value must be a string, finite number, boolean or null`);
    }
    right = { kind: 'constant', label: 'value', value: condition.value };
    if (condition.operator !== 'eq') {
      const numericValue = toComparableNumber(condition.value);
      if (numericValue === null) {
        throw new Error(`${where}: value for ${condition.operator} must convert to a finite number`);
      }
      right.numericValue = numericValue;
    }
  } else if (hasValueField) {
    if (typeof condition.valueField !== 'string') {
      throw new Error(`${where} valueField: path must be a non-empty string`);
    }
    right = {
      kind: 'input', label: 'valueField',
      segments: parsePathSegments(condition.valueField, `${where} valueField`),
    };
  } else {
    right = {
      kind: 'output', label: 'valueOutputField',
      ref: compileOutputReference(condition.valueOutputField, nodes, `${where} valueOutputField`),
    };
  }

  return { kind: 'comparison', operator: condition.operator, left, right };
}

const formSchemas = new WeakMap();
const compiledConditions = new WeakMap();
const successorTargets = new WeakMap();
const nodeDependencies = new WeakMap();
const actionBindings = new WeakMap();

const RETRY_FIELDS = ['attempts', 'initialDelayMs', 'backoffFactor', 'maxDelayMs'];
const DEFAULT_RETRY = { attempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 };

function isIntegerIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// A retry block is either absent (one attempt, no waiting) or present with all
// four parameters together, each within the same ranges the engine enforces
// for business action retries and compensation retries alike.
function compileRetry(config, label) {
  if (!isUsableObject(config)) {
    throw new Error(`${label}: retry must be an object`);
  }
  const missing = RETRY_FIELDS.filter(field => !Object.hasOwn(config, field) || config[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`${label}: retry config must define all of ${RETRY_FIELDS.join(', ')} together (missing: ${missing.join(', ')})`);
  }
  if (!isIntegerIn(config.attempts, 1, 10)) {
    throw new Error(`${label}: retry.attempts must be an integer between 1 and 10`);
  }
  if (!isIntegerIn(config.initialDelayMs, 0, 60000)) {
    throw new Error(`${label}: retry.initialDelayMs must be an integer between 0 and 60000 milliseconds`);
  }
  if (!isIntegerIn(config.maxDelayMs, 0, 60000)) {
    throw new Error(`${label}: retry.maxDelayMs must be an integer between 0 and 60000 milliseconds`);
  }
  if (typeof config.backoffFactor !== 'number' || !Number.isFinite(config.backoffFactor)
    || config.backoffFactor < 1 || config.backoffFactor > 4) {
    throw new Error(`${label}: retry.backoffFactor must be a finite number between 1 and 4`);
  }
  if (config.maxDelayMs < config.initialDelayMs) {
    throw new Error(`${label}: retry.maxDelayMs must not be less than retry.initialDelayMs`);
  }
  return {
    attempts: config.attempts,
    initialDelayMs: config.initialDelayMs,
    backoffFactor: config.backoffFactor,
    maxDelayMs: config.maxDelayMs,
  };
}

// An action node either keeps the legacy `message` behavior, names a business
// operation the caller supplies at run time, and/or declares a compensation
// operation that undoes its business effect. Both retry blocks are optional
// and, absent, mean exactly one attempt with no waiting.
function compileAction(node) {
  let name = null;
  if (Object.hasOwn(node, 'operation') && node.operation !== undefined) {
    if (typeof node.operation !== 'string' || node.operation.trim().length === 0) {
      throw new Error(`action node ${node.id}: operation must be a non-empty string name`);
    }
    name = node.operation;
  }

  let retry = { ...DEFAULT_RETRY };
  if (Object.hasOwn(node, 'retry') && node.retry !== undefined) {
    if (!name) {
      throw new Error(`action node ${node.id}: retry config is only allowed on an action that names an operation`);
    }
    retry = compileRetry(node.retry, `action node ${node.id}`);
  }

  let compensation = null;
  if (Object.hasOwn(node, 'compensation') && node.compensation !== undefined) {
    if (!isUsableObject(node.compensation)) {
      throw new Error(`action node ${node.id}: compensation must be an object`);
    }
    if (!name) {
      throw new Error(`action node ${node.id}: compensation is only allowed on an action that names an operation`);
    }
    const config = node.compensation;
    if (typeof config.operation !== 'string' || config.operation.trim().length === 0) {
      throw new Error(`action node ${node.id}: compensation.operation must be a non-empty string name`);
    }
    let compRetry = { ...DEFAULT_RETRY };
    if (Object.hasOwn(config, 'retry') && config.retry !== undefined) {
      compRetry = compileRetry(config.retry, `action node ${node.id} compensation`);
    }
    compensation = { name: config.operation, retry: compRetry };
  }

  return { name, retry, compensation };
}

// Resolves the outgoing edges of a node. Trigger, form and action nodes may
// name a single successor or a non-empty, duplicate-free array of successors;
// conditions keep their then/else pair and end nodes have none.
function normalizeSuccessors(node, nodes) {
  if (node.type === 'end') return [];
  if (node.type === 'condition') {
    for (const destination of [node.then, node.else]) {
      if (typeof destination !== 'string' || !nodes.has(destination)) {
        throw new Error(`node ${node.id} points to an unknown destination`);
      }
    }
    return [node.then, node.else];
  }
  const next = node.next;
  if (Array.isArray(next)) {
    if (next.length === 0) {
      throw new Error(`node ${node.id}: next array must not be empty`);
    }
    const seen = new Set();
    for (const destination of next) {
      if (typeof destination !== 'string') {
        throw new Error(`node ${node.id}: next array entries must be node id strings`);
      }
      if (seen.has(destination)) {
        throw new Error(`node ${node.id}: duplicate destination ${destination}`);
      }
      seen.add(destination);
      if (!nodes.has(destination)) {
        throw new Error(`node ${node.id} points to an unknown destination`);
      }
    }
    return [...seen];
  }
  if (typeof next !== 'string' || !nodes.has(next)) {
    throw new Error(`node ${node.id} points to an unknown destination`);
  }
  return [next];
}

// Resolves the explicit dependencies of a node. Dependencies only gate when a
// node may run; they never activate it. A missing dependsOn means no
// dependencies, and the entry node must not declare any.
function normalizeDependencies(node, nodes, entryId) {
  if (!Object.hasOwn(node, 'dependsOn') || node.dependsOn === undefined) return [];
  if (!Array.isArray(node.dependsOn)) {
    throw new Error(`node ${node.id}: dependsOn must be an array`);
  }
  const seen = new Set();
  for (const dependency of node.dependsOn) {
    if (typeof dependency !== 'string') {
      throw new Error(`node ${node.id}: dependsOn entries must be node id strings`);
    }
    if (seen.has(dependency)) {
      throw new Error(`node ${node.id}: duplicate dependency ${dependency}`);
    }
    seen.add(dependency);
    if (!nodes.has(dependency)) {
      throw new Error(`node ${node.id} depends on an unknown node`);
    }
    if (dependency === node.id) {
      throw new Error(`node ${node.id} must not depend on itself`);
    }
  }
  const dependencies = [...seen];
  if (node.id === entryId && dependencies.length > 0) {
    throw new Error(`entry node ${node.id} must not declare dependencies`);
  }
  return dependencies;
}

// Successor edges and dependency ordering constraints together must stay
// acyclic across the whole definition — including branches a run would never
// take and nodes the entry cannot reach. The error names a node id chain
// whose first and last entries match and whose steps are real edges or
// dependency relations.
function detectCycles(nodes) {
  const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
  for (const [id, node] of nodes) {
    adjacency.get(id).push(...successorTargets.get(node));
    for (const dependency of nodeDependencies.get(node)) {
      adjacency.get(dependency).push(id);
    }
  }
  const color = new Map([...nodes.keys()].map(id => [id, 'white']));
  const stack = [];
  const visit = id => {
    color.set(id, 'gray');
    stack.push(id);
    for (const target of adjacency.get(id)) {
      if (color.get(target) === 'gray') {
        const chain = [...stack.slice(stack.indexOf(target)), target];
        throw new Error(`cycle is present: ${chain.join(' -> ')}`);
      }
      if (color.get(target) === 'white') visit(target);
    }
    stack.pop();
    color.set(id, 'black');
  };
  for (const id of nodes.keys()) {
    if (color.get(id) === 'white') visit(id);
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

  let requiresSingleEnd = false;
  for (const node of nodes.values()) {
    successorTargets.set(node, normalizeSuccessors(node, nodes));
    const dependencies = normalizeDependencies(node, nodes, workflow.entry);
    nodeDependencies.set(node, dependencies);
    const usesArraySuccessors = node.type !== 'end' && node.type !== 'condition' && Array.isArray(node.next);
    if (usesArraySuccessors || dependencies.length > 0) requiresSingleEnd = true;
    if (Object.hasOwn(node, 'compensation') && node.compensation !== undefined && node.type !== 'action') {
      throw new Error(`node ${node.id}: compensation is only allowed on a business action node`);
    }
    if (node.type === 'form') {
      formSchemas.set(node, compileFormSchema(node));
    }
    if (node.type === 'condition') {
      compiledConditions.set(node, compileCondition(node.condition, nodes, node.id));
    }
    if (node.type === 'action') {
      actionBindings.set(node, compileAction(node));
    }
  }

  if (requiresSingleEnd) {
    const endCount = [...nodes.values()].filter(node => node.type === 'end').length;
    if (endCount !== 1) {
      throw new Error('workflows using array successors or dependsOn must declare exactly one end node');
    }
  }

  detectCycles(nodes);
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

// Stores a successful action's result under its full node id. The id itself is
// only matched as a whole string, so "__proto__" is a legal node identifier;
// but a plain `output[id] = value` assignment invokes the inherited
// Object.prototype.__proto__ setter and re-points the store's prototype
// instead of creating an own property — the result then vanishes from hasOwn
// checks, enumeration and JSON output. Define an own enumerable data property
// for that key; reads and clones treat it like every other key.
function setNodeOutput(output, nodeId, value) {
  if (nodeId === '__proto__') {
    Object.defineProperty(output, nodeId, {
      value, writable: true, enumerable: true, configurable: true,
    });
  } else {
    output[nodeId] = value;
  }
}

// Resolves an output reference against the run's saved outputs. Only outputs
// of actions that succeeded in this run are present here — failed attempts
// and compensation returns are recorded elsewhere. A referenced action that
// has not run (or was never activated) is simply missing; references never
// activate or wait for anything. An own property set to null, "", 0, false or
// undefined still counts as present; walking into an array or a non-object
// parent value counts as missing.
function resolveOutputReference(ref, output) {
  if (!Object.hasOwn(output, ref.nodeId)) return { exists: false };
  const stored = output[ref.nodeId];
  if (ref.segments.length === 0) return { exists: true, value: stored };
  if (!isUsableObject(stored)) return { exists: false };
  const looked = lookupOwn(stored, ref.segments);
  return looked.exists ? { exists: true, value: looked.value } : { exists: false };
}

function resolveComparisonSide(side, input, output) {
  if (side.kind === 'constant') return { exists: true, value: side.value };
  if (side.kind === 'input') {
    const looked = lookupOwn(input, side.segments);
    return looked.exists ? { exists: true, value: looked.value } : { exists: false };
  }
  return resolveOutputReference(side.ref, output);
}

// Evaluates a compiled condition against the cloned execution input and the
// saved action outputs. Compounds short-circuit in declaration order, so a bad
// value inside a skipped child is never observed. A non-skipped numeric
// comparison whose inputs cannot convert to finite numbers is reported as an
// invalid_condition error instead.
function runCondition(compiled, input, output, nodeId, position = '$') {
  if (compiled.kind === 'not') {
    const child = runCondition(compiled.child, input, output, nodeId, `${position}.not`);
    if (!child.ok) return child;
    return { ok: true, value: !child.value };
  }
  if (compiled.kind === 'all' || compiled.kind === 'any') {
    for (let i = 0; i < compiled.children.length; i += 1) {
      const child = runCondition(compiled.children[i], input, output, nodeId, `${position}.${compiled.kind}[${i}]`);
      if (!child.ok) return child;
      if (compiled.kind === 'all' && !child.value) return { ok: true, value: false };
      if (compiled.kind === 'any' && child.value) return { ok: true, value: true };
    }
    return { ok: true, value: compiled.kind === 'all' };
  }

  const where = `condition node ${nodeId} at ${position}`;
  const left = resolveComparisonSide(compiled.left, input, output);
  if (!left.exists) return { ok: true, value: false };

  if (compiled.operator === 'exists') return { ok: true, value: true };

  const right = resolveComparisonSide(compiled.right, input, output);
  if (!right.exists) return { ok: true, value: false };

  if (compiled.operator === 'eq') {
    return { ok: true, value: left.value === right.value };
  }

  const leftNumber = toComparableNumber(left.value);
  if (leftNumber === null) {
    return { ok: false, error: `${where}: value at ${compiled.left.label} cannot convert to a finite number` };
  }
  if (compiled.right.kind === 'constant') {
    return {
      ok: true,
      value: compiled.operator === 'gte' ? leftNumber >= compiled.right.numericValue : leftNumber <= compiled.right.numericValue,
    };
  }
  const rightNumber = toComparableNumber(right.value);
  if (rightNumber === null) {
    return { ok: false, error: `${where}: value at ${compiled.right.label} cannot convert to a finite number` };
  }
  return {
    ok: true,
    value: compiled.operator === 'gte' ? leftNumber >= rightNumber : leftNumber <= rightNumber,
  };
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

// Wait before a retry. Timers are the only suspension point: no other node is
// ever scheduled while an action waits. When a cancellation signal is given,
// an abort ends the wait immediately and the promise resolves to true; a
// wait that runs its full course resolves to false.
function sleep(ms, signal) {
  return new Promise(resolve => {
    const finish = cancelled => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(cancelled);
    };
    const onAbort = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    if (signal) {
      if (signal.aborted) finish(true);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const UNREADABLE_ERROR_MESSAGE = '无法读取异常信息';

// Turns a thrown or rejected value into the string recorded on a failed
// attempt. An Error whose message is a readable string keeps it verbatim —
// an empty string is still a failure — and thrown strings, numbers,
// booleans, null and undefined keep their usual String() representation.
// When the text cannot be read (a non-string message, a message getter that
// throws, or a value String() cannot convert), a fixed placeholder is
// recorded so the run result is never rejected; the original value is left
// untouched. Both synchronous throws and rejected Promises reach this via
// the same try/await.
function describeError(error) {
  if (error instanceof Error) {
    let message;
    try {
      message = error.message;
    } catch {
      return UNREADABLE_ERROR_MESSAGE;
    }
    return typeof message === 'string' ? message : UNREADABLE_ERROR_MESSAGE;
  }
  if (error === null || typeof error === 'string'
    || typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }
  try {
    return String(error);
  } catch {
    return UNREADABLE_ERROR_MESSAGE;
  }
}

// Delay before the attempt following the given (failed) attempt number: the
// initial wait grows by the backoff factor each time and is capped by the
// configured maximum. A zero initial delay always stays zero.
function retryDelay(retry, failedAttempt) {
  const grown = retry.initialDelayMs * (retry.backoffFactor ** (failedAttempt - 1));
  return Math.min(grown, retry.maxDelayMs);
}

// Runs an operation under a retry policy — the one attempt loop shared by
// business actions and compensations. Every invocation works on fresh
// structured-clone argument copies produced by prepareArgs, so mutations by
// a failed attempt are discarded before the next try; a thrown exception, a
// rejected Promise, or a return value that cannot be structured-cloned all
// count as a failed attempt, and the recorded success value is a clone
// independent of any object the implementation keeps holding. Attempts are
// numbered from 1, the wait after a failure follows the configured backoff
// (zero stays zero, nothing is awaited after the last attempt), and each
// actual invocation appends exactly one record, in order, via collect.
//
// The two callers differ only through the hooks:
// - prepareArgs(attempt) builds this attempt's fresh argument copies;
// - invoke is the registered implementation, called as invoke(...args);
// - createRecord(attempt) shapes the record (business attempts carry no
//   operation/result fields, compensation attempts do);
// - cloneFailureMessage names the operation kind for uncloneable returns;
// - collect appends to the caller's own attempt list;
// - onSuccess stores caller-specific success data on the record.
// When a cancellation signal is given, no new attempt starts once it has
// fired — even with a zero retry delay — and a wait in progress ends early;
// an attempt already running is always awaited and its outcome recorded.
// Compensation passes no signal and is therefore never interrupted.
async function runWithRetries({ retry, signal = null, prepareArgs, invoke, createRecord, cloneFailureMessage, collect, onSuccess }) {
  let lastReason = null;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    if (signal && signal.aborted) {
      return { ok: false, cancelled: true, error: lastReason };
    }
    const args = prepareArgs(attempt);
    const record = createRecord(attempt);
    let returned;
    try {
      returned = await invoke(...args);
    } catch (error) {
      lastReason = describeError(error);
      record.error = lastReason;
    }

    if (record.error === null) {
      try {
        returned = structuredClone(returned);
      } catch (error) {
        lastReason = cloneFailureMessage;
        record.error = lastReason;
      }
    }

    if (record.error === null) {
      record.ok = true;
      onSuccess(record, returned);
      collect(record);
      return { ok: true, value: returned };
    }

    // A cancellation observed while the attempt was in flight keeps the
    // failure record but stops the retry loop: no wait, no next attempt —
    // even when this was the last attempt the run could have made.
    if (signal && signal.aborted) {
      collect(record);
      return { ok: false, cancelled: true, error: lastReason };
    }

    record.nextDelayMs = attempt < retry.attempts ? retryDelay(retry, attempt) : 0;
    collect(record);
    if (record.nextDelayMs > 0) {
      // A cancellation during the wait ends it immediately; the failed
      // attempt's record keeps its error but no longer promises a delay.
      const interrupted = await sleep(record.nextDelayMs, signal);
      if (interrupted) {
        record.nextDelayMs = 0;
        return { ok: false, cancelled: true, error: lastReason };
      }
    }
  }

  return { ok: false, error: lastReason };
}

// Runs one business action with retries. Every invocation receives fresh
// structured clones of the current input and the successful outputs so far;
// the stored success value is a clone independent of any object the
// implementation keeps holding. The cancellation signal applies to this
// loop only — compensation runs without one.
async function runBusinessAction(node, binding, implementation, context, actionAttempts, signal) {
  return runWithRetries({
    retry: binding.retry,
    signal,
    prepareArgs: attempt => [structuredClone(context.input), structuredClone(context.output), node.id, attempt],
    invoke: implementation,
    createRecord: attempt => ({ nodeId: node.id, attempt, ok: false, error: null, nextDelayMs: 0 }),
    cloneFailureMessage: `operation "${binding.name}" returned a value that cannot be structured-cloned`,
    collect: record => actionAttempts.push(record),
    onSuccess: () => {},
  });
}

// Runs compensation for one already-succeeded business action. The call gets
// independent structured clones of the input and earlier outputs captured at
// the original action's success moment, the stored return value, the node id
// and a 1-based compensation attempt number. Nothing here can touch the run
// context, a later attempt, another run, or the stored success output.
async function runCompensation(entry, implementation, records) {
  const { nodeId, binding, snapshot } = entry;
  return runWithRetries({
    retry: binding.compensation.retry,
    prepareArgs: attempt => [
      structuredClone(snapshot.input), structuredClone(snapshot.output),
      structuredClone(snapshot.result), nodeId, attempt,
    ],
    invoke: implementation,
    createRecord: attempt => ({
      nodeId, operation: binding.compensation.name, attempt,
      ok: false, error: null, nextDelayMs: 0, result: null,
    }),
    cloneFailureMessage: `compensation "${binding.compensation.name}" returned a value that cannot be structured-cloned`,
    collect: record => records.push(record),
    onSuccess: (record, returned) => { record.result = returned; },
  });
}

// Undoes successful compensable business actions, most recent first, waiting
// for each compensation to finish before starting the next. A compensation
// that exhausts its retries is recorded as failed but earlier (still-pending)
// actions are compensated regardless; neither the failed compensation nor the
// original business operation is re-run. Compensating a node removes it from
// the pending list exactly once — retried-then-succeeded actions and shared
// join nodes were only recorded once to begin with.
async function compensateRun(state, operations) {
  const records = [];
  let failed = false;
  while (state.compensable.length > 0) {
    const entry = state.compensable.pop();
    const outcome = await runCompensation(entry, operations[entry.binding.compensation.name], records);
    if (!outcome.ok) failed = true;
  }
  return { status: failed ? 'failed' : 'completed', attempts: records };
}

// Scheduling state shared by the synchronous and asynchronous execution
// loops: activation, completion, dependency gating and the recorded end
// result all behave identically; only business-action handling differs.
function createRunState(nodes, workflow, input) {
  const declarationOrder = [...nodes.values()];
  const declarationIndex = new Map(declarationOrder.map((node, index) => [node.id, index]));
  return {
    trace: [],
    actionAttempts: [],
    context: { input: structuredClone(input), output: {} },
    declarationOrder,
    declarationIndex,
    activated: new Set([workflow.entry]),
    completed: new Set(),
    endReached: false,
    endResult: null,
    // Successful business actions that declared a compensation, in the order
    // they succeeded. Each entry keeps independent snapshots captured at the
    // action's own success moment.
    compensable: [],
  };
}

function pickReadyNode(state) {
  return state.declarationOrder.find(node =>
    state.activated.has(node.id) && !state.completed.has(node.id)
    && nodeDependencies.get(node).every(dependency => state.completed.has(dependency)));
}

function blockedResult(state) {
  const waiting = state.declarationOrder.filter(node =>
    state.activated.has(node.id) && !state.completed.has(node.id));
  if (waiting.length === 0) return null;
  return waiting.map(node => ({
    nodeId: node.id,
    missingDependencies: nodeDependencies.get(node)
      .filter(dependency => !state.completed.has(dependency))
      .sort((a, b) => state.declarationIndex.get(a) - state.declarationIndex.get(b)),
  }));
}

// Applies a ready non-action node, mutating activation/completion state.
// Returns an early-termination result (invalid_input / invalid_condition)
// or null when execution should continue.
function applyRegularNode(node, state) {
  if (node.type === 'action') {
    setNodeOutput(state.context.output, node.id, node.message ?? `action:${node.id}`);
  }
  if (node.type === 'form') {
    const compiled = formSchemas.get(node);
    if (compiled) {
      const formResult = processForm(node, state.context.input, compiled);
      if (!formResult.ok) {
        state.context.input = formResult.rollback;
        return { status: 'invalid_input', context: state.context, trace: state.trace, errors: formResult.errors };
      }
    }
  }
  if (node.type === 'condition') {
    const outcome = runCondition(compiledConditions.get(node), state.context.input, state.context.output, node.id);
    if (!outcome.ok) {
      return { status: 'invalid_condition', context: state.context, trace: state.trace, error: outcome.error };
    }
    state.activated.add(outcome.value ? node.then : node.else);
  } else {
    for (const target of successorTargets.get(node)) state.activated.add(target);
  }
  state.completed.add(node.id);
  return null;
}

// Verifies, before a single node can run, that every business operation and
// every compensation operation in the definition has a function registered —
// including actions on untaken branches and entry-unreachable nodes.
function resolveImplementation(operations, name, nodeId, kind) {
  if (!isUsableObject(operations)
    || !Object.hasOwn(operations, name)
    || typeof operations[name] !== 'function') {
    throw new Error(`action node ${nodeId}: ${kind} operation "${name}" has no function implementation; pass it to executeWorkflowAsync`);
  }
  return operations[name];
}

function verifyOperations(nodes, operations) {
  for (const node of nodes.values()) {
    const binding = actionBindings.get(node);
    if (binding && binding.name !== null) {
      resolveImplementation(operations, binding.name, node.id, 'business');
    }
    if (binding && binding.compensation !== null) {
      resolveImplementation(operations, binding.compensation.name, node.id, 'compensation');
    }
  }
}

// The optional fourth argument of executeWorkflowAsync carries an
// AbortSignal as `{ signal }`. Omitting it — or passing undefined, or an
// options object without a signal — keeps the previous behavior; anything
// else is a caller error reported before a single node executes.
function resolveRunSignal(options) {
  if (options === undefined) return null;
  if (!isUsableObject(options)) {
    throw new TypeError('executeWorkflowAsync options must be an object with an optional "signal" AbortSignal');
  }
  if (!Object.hasOwn(options, 'signal') || options.signal === undefined) return null;
  const { signal } = options;
  if (signal instanceof AbortSignal) return signal;
  throw new TypeError('executeWorkflowAsync options.signal must be an AbortSignal');
}

export function executeWorkflow(workflow, input = {}) {
  const nodes = validateWorkflow(workflow);
  // Business operations are asynchronous: the synchronous entry must refuse
  // a workflow that names any before a single node executes.
  for (const node of nodes.values()) {
    const binding = actionBindings.get(node);
    if (binding && binding.name !== null) {
      throw new Error(`action node ${node.id} names business operation "${binding.name}", which must run asynchronously; use executeWorkflowAsync instead of executeWorkflow`);
    }
  }

  const state = createRunState(nodes, workflow, input);

  for (;;) {
    const ready = pickReadyNode(state);

    if (!ready) {
      const blockedNodes = blockedResult(state);
      if (blockedNodes) {
        return { status: 'blocked', context: state.context, trace: state.trace, blockedNodes };
      }
      if (state.endReached) {
        return { status: 'completed', result: state.endResult, context: state.context, trace: state.trace };
      }
      throw new Error('workflow did not terminate; a cycle is present');
    }

    state.trace.push({ nodeId: ready.id, type: ready.type });
    if (ready.type === 'end') {
      // Reaching an end node records the result but never stops other
      // activated branches; the run completes once nothing can still run.
      state.endReached = true;
      state.endResult = ready.result ?? null;
      state.completed.add(ready.id);
      continue;
    }

    const early = applyRegularNode(ready, state);
    if (early) return early;
  }
}

// Attaches compensation results to a failed run. Successful outputs and the
// original terminal status stay untouched; compensation records live on
// their own fields, never in the regular node trace.
async function withCompensation(result, state, operations) {
  const outcome = await compensateRun(state, operations);
  result.compensationStatus = outcome.attempts.length === 0 ? 'not_needed' : outcome.status;
  result.compensationAttempts = outcome.attempts;
  return result;
}

// The cancelled terminal shape: the run stops where it is, keeps the
// context, trace and attempt records produced so far, and never carries a
// success result. Compensation for already-succeeded actions is attached by
// withCompensation under the usual rules.
function cancelledResult(state) {
  return {
    status: 'cancelled',
    context: state.context,
    trace: state.trace,
    actionAttempts: state.actionAttempts,
  };
}

export async function executeWorkflowAsync(workflow, input = {}, operations = {}, options = undefined) {
  const signal = resolveRunSignal(options);
  const nodes = validateWorkflow(workflow);
  verifyOperations(nodes, operations);

  const state = createRunState(nodes, workflow, input);

  // A signal that is already aborted stops the run before the first node —
  // but only after the definition and the operation registrations above have
  // been checked. Nothing executes and nothing is compensated.
  if (signal && signal.aborted) {
    return withCompensation(cancelledResult(state), state, operations);
  }

  for (;;) {
    // Once the signal fires, no new regular node runs and no new business
    // action attempt starts; the run ends cancelled with whatever state it
    // reached, even if an end node was already visited on another branch.
    if (signal && signal.aborted) {
      return withCompensation(cancelledResult(state), state, operations);
    }

    const ready = pickReadyNode(state);

    if (!ready) {
      const blockedNodes = blockedResult(state);
      if (blockedNodes) {
        // Unmet dependencies end the run; successful compensable actions are
        // rolled back even though an end node may already have been reached.
        return withCompensation({
          status: 'blocked', context: state.context, trace: state.trace,
          blockedNodes, actionAttempts: state.actionAttempts,
        }, state, operations);
      }
      if (state.endReached) {
        // A completed run never invokes compensation.
        return {
          status: 'completed', result: state.endResult, context: state.context,
          trace: state.trace, actionAttempts: state.actionAttempts,
          compensationStatus: 'not_needed', compensationAttempts: [],
        };
      }
      throw new Error('workflow did not terminate; a cycle is present');
    }

    state.trace.push({ nodeId: ready.id, type: ready.type });
    if (ready.type === 'end') {
      state.endReached = true;
      state.endResult = ready.result ?? null;
      state.completed.add(ready.id);
      continue;
    }

    if (ready.type === 'action') {
      const binding = actionBindings.get(ready);
      if (binding.name !== null) {
        // Nodes execute one at a time in declaration order; awaiting here
        // never lets another node jump ahead.
        const actionResult = await runBusinessAction(
          ready, binding, operations[binding.name], state.context, state.actionAttempts, signal);
        if (!actionResult.ok) {
          if (actionResult.cancelled) {
            // Cancelled while the action was in flight or waiting to retry:
            // the attempt records produced so far stay as they are.
            return withCompensation(cancelledResult(state), state, operations);
          }
          // Retries are exhausted: stop immediately with prior input/output
          // preserved, no output for this node and no successors activated —
          // even if an end node was already reached — then compensate every
          // earlier successful action that asked for it.
          return withCompensation({
            status: 'action_failed', nodeId: ready.id, attempts: binding.retry.attempts,
            error: actionResult.error, context: state.context, trace: state.trace,
            actionAttempts: state.actionAttempts,
          }, state, operations);
        }
        // Capture the compensation snapshots from the state before the new
        // output key lands: the action's own return value is handed to the
        // compensation separately as its third argument.
        const compensationSnapshot = binding.compensation === null ? null : {
          input: structuredClone(state.context.input),
          output: structuredClone(state.context.output),
          result: structuredClone(actionResult.value),
        };
        setNodeOutput(state.context.output, ready.id, actionResult.value);
        if (compensationSnapshot) {
          // Each node completes at most once, so retried-then-successful
          // actions and shared join nodes are scheduled for compensation
          // exactly once.
          state.compensable.push({ nodeId: ready.id, binding, snapshot: compensationSnapshot });
        }
        for (const target of successorTargets.get(ready)) state.activated.add(target);
        state.completed.add(ready.id);
        continue;
      }
    }

    const early = applyRegularNode(ready, state);
    if (early) {
      early.actionAttempts = state.actionAttempts;
      // A failed form (invalid_input) or failed condition evaluation
      // (invalid_condition) ends normal execution and triggers compensation
      // of the successful business actions that ran earlier.
      return withCompensation(early, state, operations);
    }
  }
}
