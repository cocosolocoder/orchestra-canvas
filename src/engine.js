const NODE_TYPES = new Set(['trigger', 'form', 'condition', 'action', 'end']);
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function splitFieldPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  const segments = path.split('.');
  if (segments.some(segment => segment.length === 0)) return null;
  return segments;
}

function isPrefix(a, b) {
  if (a.length >= b.length) return false;
  return a.every((segment, index) => segment === b[index]);
}

function assertNonNegativeIntegerBound(value, name, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}: ${name} must be a non-negative integer`);
  }
}

function assertFiniteBound(value, name, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: ${name} must be a finite number`);
  }
}

function validateFieldDefault(field, label) {
  const defaultValue = field.default;
  if (field.type === 'string') {
    if (typeof defaultValue !== 'string') throw new Error(`${label}: default must be a string`);
    const length = [...defaultValue].length;
    if ('minLength' in field && length < field.minLength) {
      throw new Error(`${label}: default is shorter than minLength`);
    }
    if ('maxLength' in field && length > field.maxLength) {
      throw new Error(`${label}: default is longer than maxLength`);
    }
  } else if (field.type === 'number') {
    if (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue)) {
      throw new Error(`${label}: default must be a finite number`);
    }
    if ('min' in field && defaultValue < field.min) throw new Error(`${label}: default is less than min`);
    if ('max' in field && defaultValue > field.max) throw new Error(`${label}: default is greater than max`);
  } else if (field.type === 'integer') {
    if (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue) || !Number.isInteger(defaultValue)) {
      throw new Error(`${label}: default must be an integer`);
    }
    if ('min' in field && defaultValue < field.min) throw new Error(`${label}: default is less than min`);
    if ('max' in field && defaultValue > field.max) throw new Error(`${label}: default is greater than max`);
  } else if (field.type === 'boolean') {
    if (typeof defaultValue !== 'boolean') throw new Error(`${label}: default must be a boolean`);
  }
}

function validateFormSchema(node) {
  if (!('schema' in node) || node.schema === undefined || node.schema === null) return;
  const schema = node.schema;
  assertPlainObject(schema, `node ${node.id}: schema`);
  if (!Array.isArray(schema.fields)) throw new Error(`node ${node.id}: schema.fields must be an array`);

  const seen = [];
  for (let index = 0; index < schema.fields.length; index += 1) {
    const field = schema.fields[index];
    assertPlainObject(field, `node ${node.id}: schema.fields[${index}]`);
    const label = `node ${node.id}: field ${JSON.stringify(field.path ?? index)}`;

    const segments = splitFieldPath(field.path);
    if (!segments) throw new Error(`${label}: path must be a non-empty dot-separated string without empty segments`);
    if (segments.some(segment => FORBIDDEN_SEGMENTS.has(segment))) {
      throw new Error(`${label}: path must not contain __proto__, prototype, or constructor segments`);
    }
    for (const previous of seen) {
      if (previous.path === field.path) throw new Error(`${label}: duplicate path ${field.path}`);
      if (isPrefix(previous.segments, segments) || isPrefix(segments, previous.segments)) {
        throw new Error(`${label}: path ${field.path} conflicts with ${previous.path}`);
      }
    }
    seen.push({ path: field.path, segments });

    if (!FIELD_TYPES.has(field.type)) throw new Error(`${label}: unknown type ${String(field.type)}`);
    if ('required' in field && typeof field.required !== 'boolean') {
      throw new Error(`${label}: required must be a boolean`);
    }

    const isString = field.type === 'string';
    const isNumeric = field.type === 'number' || field.type === 'integer';

    if (isString) {
      if ('min' in field || 'max' in field) {
        throw new Error(`${label}: min and max do not apply to string fields`);
      }
      if ('minLength' in field) assertNonNegativeIntegerBound(field.minLength, 'minLength', label);
      if ('maxLength' in field) assertNonNegativeIntegerBound(field.maxLength, 'maxLength', label);
      if ('minLength' in field && 'maxLength' in field && field.minLength > field.maxLength) {
        throw new Error(`${label}: minLength must not exceed maxLength`);
      }
    } else if (isNumeric) {
      if ('minLength' in field || 'maxLength' in field) {
        throw new Error(`${label}: minLength and maxLength do not apply to ${field.type} fields`);
      }
      if ('min' in field) assertFiniteBound(field.min, 'min', label);
      if ('max' in field) assertFiniteBound(field.max, 'max', label);
      if ('min' in field && 'max' in field && field.min > field.max) {
        throw new Error(`${label}: min must not exceed max`);
      }
    } else {
      if ('minLength' in field || 'maxLength' in field || 'min' in field || 'max' in field) {
        throw new Error(`${label}: constraints do not apply to boolean fields`);
      }
    }

    if ('default' in field) validateFieldDefault(field, label);
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

  for (const node of nodes.values()) {
    const destinations = node.type === 'condition' ? [node.then, node.else] : node.type === 'end' ? [] : [node.next];
    for (const destination of destinations) {
      if (typeof destination !== 'string' || !nodes.has(destination)) {
        throw new Error(`node ${node.id} points to an unknown destination`);
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.type === 'form') validateFormSchema(node);
  }

  return nodes;
}

function readPath(input, path) {
  return String(path).split('.').reduce((value, part) => value?.[part], input);
}

function evaluateCondition(condition, input) {
  assertPlainObject(condition, 'condition');
  const actual = readPath(input, condition.field);
  switch (condition.operator) {
    case 'eq': return actual === condition.value;
    case 'gte': return Number(actual) >= Number(condition.value);
    case 'lte': return Number(actual) <= Number(condition.value);
    default: throw new Error(`unsupported condition operator: ${condition.operator}`);
  }
}

function resolveOwnPath(input, segments) {
  let current = input;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function applyDefault(input, segments, defaultValue) {
  let current = input;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (!Object.prototype.hasOwnProperty.call(current, segment) || current[segment] === undefined) {
      current[segment] = {};
    }
    const parent = current[segment];
    if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) {
      return false;
    }
    current = parent;
  }
  current[segments[segments.length - 1]] = defaultValue;
  return true;
}

function typeMatches(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

function constraintViolation(value, field) {
  if (field.type === 'string') {
    const length = [...value].length;
    if ('minLength' in field && length < field.minLength) return 'length';
    if ('maxLength' in field && length > field.maxLength) return 'length';
  } else {
    if ('min' in field && value < field.min) return 'range';
    if ('max' in field && value > field.max) return 'range';
  }
  return null;
}

function executeForm(node, context) {
  const errors = [];
  for (const field of node.schema.fields) {
    const segments = field.path.split('.');
    const resolved = resolveOwnPath(context.input, segments);

    if (!resolved.found) {
      if ('default' in field) {
        if (!applyDefault(context.input, segments, field.default)) {
          errors.push({ nodeId: node.id, path: field.path, code: 'type' });
        }
        continue;
      }
      if (field.required) {
        errors.push({ nodeId: node.id, path: field.path, code: 'required' });
      }
      continue;
    }

    if (!typeMatches(resolved.value, field.type)) {
      errors.push({ nodeId: node.id, path: field.path, code: 'type' });
      continue;
    }

    const code = constraintViolation(resolved.value, field);
    if (code) errors.push({ nodeId: node.id, path: field.path, code });
  }
  return errors;
}

export function executeWorkflow(workflow, input = {}) {
  const nodes = validateWorkflow(workflow);
  const trace = [];
  const context = { input: structuredClone(input), output: {} };
  let currentId = workflow.entry;

  for (let step = 0; step <= nodes.size; step += 1) {
    const node = nodes.get(currentId);
    trace.push({ nodeId: node.id, type: node.type });
    if (node.type === 'end') return { status: 'completed', result: node.result ?? null, context, trace };
    if (node.type === 'action') context.output[node.id] = node.message ?? `action:${node.id}`;

    if (node.type === 'form' && node.schema) {
      const snapshot = structuredClone(context.input);
      const errors = executeForm(node, context);
      if (errors.length > 0) {
        context.input = snapshot;
        return { status: 'invalid_input', nodeId: node.id, errors, context, trace };
      }
    }

    currentId = node.type === 'condition'
      ? (evaluateCondition(node.condition, context.input) ? node.then : node.else)
      : node.next;
  }
  throw new Error('workflow did not terminate; a cycle is present');
}
