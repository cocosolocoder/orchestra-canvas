import { types as nodeTypes } from 'node:util';

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
    const childList = condition[key];
    if (!Array.isArray(childList)) {
      throw new Error(`condition node ${nodeId} at ${position}: ${key} must be an array of conditions`);
    }
    if (childList.length === 0) {
      throw new Error(`condition node ${nodeId} at ${position}: ${key} must not be empty`);
    }
    // A non-empty array may still carry length without a condition at every
    // slot: a child deleted through the JavaScript API can leave a hole, or
    // the array may have been allocated with gaps only. A missing slot is a
    // definition error at its own original index — it is never treated as
    // false, skipped over or filled in — so it is reported even when an
    // earlier sibling would already short-circuit the compound. Explicit
    // undefined/null entries are not holes: they remain present and fall
    // through to the ordinary "condition must be an object" rejection.
    const children = [];
    for (let index = 0; index < childList.length; index += 1) {
      if (!Object.hasOwn(childList, index)) {
        throw new Error(`condition node ${nodeId} at ${position}.${key}[${index}]: ${key}[${index}] is a missing child condition`);
      }
      children.push(
        compileCondition(childList[index], nodes, nodeId, `${position}.${key}[${index}]`, depth + 1));
    }
    return { kind: key, children };
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

// Per-validation compiled storage lives on the maps compileWorkflow returns
// (see its comment): successor/dependency metadata and action bindings are
// definition facts an entry only reads after its own fresh compile, so their
// module-level, node-keyed maps are safe to overwrite. Conditions instead must
// stay frozen for the life of a run that parks on an asynchronous business
// action, so their compiled trees travel in the run state and are never shared
// in module-level storage.
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

  // A legacy message action (no operation) is validated through the single
  // configured-value gate (assertConfiguredCopy below) — the same rule, with
  // action-specific wording, that end-node results use — covering every
  // message action including ones on untaken branches and entry-unreachable
  // ones. An action that names an operation ignores its message entirely, so
  // an unused uncloneable or shared-memory message is never rejected for it.
  // The gate only proves the message was safe as it was then; the same rule
  // is re-enforced at the action's own execution moment by readConfiguredCopy.
  if (name === null) {
    assertConfiguredCopy(node, 'message', ACTION_MESSAGE_COPY_ERRORS);
  }

  return { name, retry, compensation };
}

// The two failure kinds a node-configured value can produce, shared by
// definition validation (assertConfiguredCopy below) and the execution-time
// capture (readConfiguredCopy below): the value cannot be structured-cloned at
// all, or it clones but the clone retains shared memory. Uncloneability takes
// precedence when a value carries both, at both moments. Each node kind keeps
// its own wording — an action's message and an end node's result fail with the
// node-specific text the entries already exposed — and its own default for a
// value that is absent, undefined or null (action:<node id> for a legacy
// message; null for an end result), while "", 0 and false pass through
// untouched for both.
const ACTION_MESSAGE_COPY_ERRORS = {
  uncloneable: nodeId =>
    `action node ${nodeId}: message must be a structured-cloneable value (objects and arrays must not contain functions)`,
  sharedMemory: nodeId =>
    `action node ${nodeId}: message contains shared memory (SharedArrayBuffer or a typed array/DataView backed by one); independent copies cannot be guaranteed, so shared bytes must not enter the action output`,
};
const END_RESULT_COPY_ERRORS = {
  uncloneable: nodeId =>
    `end node ${nodeId}: result must be a structured-cloneable value (objects and arrays must not contain functions)`,
  sharedMemory: nodeId =>
    `end node ${nodeId}: result contains shared memory (SharedArrayBuffer or a typed array/DataView backed by one); independent copies cannot be guaranteed, so this end result is not supported`,
};

// The single independent-copy rule for a value a node configures — a legacy
// action's `message` and an end node's `result` both go through here, so the
// cloneability and retained-shared-memory rules are maintained in exactly one
// place and the two node kinds can never drift apart. It is invoked at two
// moments, and each moment keeps its original root-read protocol:
//
//  1. At validation time (assertConfiguredCopy), for every such node in the
//     definition — including nodes on untaken branches and nodes the entry
//     cannot reach — so a statically invalid value is rejected before any
//     node, business operation or compensation can run. An absent own
//     property is not read at all; the gate performs the first root read and
//     only an own, defined value reaches the clone, which performs the root's
//     second read itself (a throwing root accessor propagates from the gate
//     exactly as before).
//  2. At the node's own execution moment (readConfiguredCopy), against the
//     value actually about to be saved: the root is read exactly once and the
//     value that read produced is cloned, so validation cannot pin the result
//     — an enumerable getter's later answer and a preceding business
//     operation's or another activated branch's mutation are both captured.
//
// At either moment every nested enumerable accessor is read only by
// structuredClone's own read — there is no separate inspection pass over the
// original, so a getter's return order is never disturbed and the value the
// clone's read produced is both what is judged and what is saved (a legal
// value whose getter answers with a different ordinary value at execution
// time records that fresh value rather than the stale validation-time one). A
// root getter that throws on execution's single read, a nested getter that
// throws while the clone reads it, and a value that cannot be cloned at all
// (a bare function) all surface as the same uncloneable error.
//
// The copy itself is produced by independentCopy — the one clone-then-judge
// rule every saved value in this engine goes through (see its comment for why
// cloning must precede the shared-memory traversal and why uncloneability
// takes precedence). Only the wording of the failure is node-specific here.
//
// Any failure is thrown as an ordinary Error naming the node (errors[kind])
// rather than recorded as a run status: the synchronous entry propagates it
// and the asynchronous entry's rejected Promise carries it. It is never an
// action_failed — neither node kind has a retry budget — it neither consumes
// business-action retries nor triggers compensation, and no output/result is
// recorded for the node. At execution, an absent, undefined or null value
// becomes `absentValue` (action:<node id> for messages, null for results),
// while "", 0 and false pass through untouched.
function configuredCopy(node, property, errors, options) {
  const validation = options !== undefined && options.validation === true;

  if (validation) {
    // Preserve the validation gate exactly: no read at all for a missing own
    // property, one unguarded gate read (a throwing root accessor propagates
    // raw, as the former per-node gates did), and an undefined value is left
    // to execution. The structuredClone argument evaluation is the root's
    // second — and final — read this moment; the clone itself traverses that
    // captured value (firing nested getters once), so no read the original
    // gate made is added or removed.
    if (!Object.hasOwn(node, property)) return;
    const gated = node[property];
    if (gated === undefined) return;
    const copy = independentCopy(node[property]);
    if (!copy.ok) throw new Error(errors[copy.reason](node.id));
    return;
  }

  // Execution: the root value's single read. An absent, undefined or null
  // value takes the node kind's default (action:<node id> for messages, null
  // for results) without reaching structuredClone; a root getter that throws
  // on this read is the uncloneable error.
  const { absentValue } = options;
  let value;
  try {
    value = node[property];
  } catch {
    throw new Error(errors.uncloneable(node.id));
  }
  if (value === undefined || value === null) return absentValue;

  // Clone the value the single read captured — the root is not read again —
  // so every nested enumerable accessor is read only by the clone's own read
  // and this, the execution-moment value, is both judged and saved.
  const copy = independentCopy(value);
  if (!copy.ok) throw new Error(errors[copy.reason](node.id));
  return copy.copy;
}

// Validation gate: reject a statically uncopyable configured value. Nothing
// is returned — validation saves no value; the execution-time capture reads
// the value afresh when the node actually runs.
function assertConfiguredCopy(node, property, errors) {
  configuredCopy(node, property, errors, { validation: true });
}

// Execution-time capture: the independent copy this run actually saves, taken
// from the value read at this node's own execution moment. `absentValue` is
// the node's default for an unset/undefined/null value.
function readConfiguredCopy(node, property, errors, absentValue) {
  return configuredCopy(node, property, errors, { validation: false, absentValue });
}

// End-node results use the same single configured-value rule as legacy
// messages, with end-node wording and a null default:
//
//  1. compileEndResult is the validation gate for every end node in the
//     definition — including nodes on untaken branches and nodes the entry
//     cannot reach — so a statically invalid result is rejected before any
//     node can run.
//  2. captureEndResult produces, at the end node's own execution moment, the
//     independent copy that is recorded and returned: an unset, undefined or
//     null result becomes null, while 0, false and "" pass through, and a
//     legal ordinary change made before the end executes is recorded from the
//     fresh value rather than the validation-time one.
function compileEndResult(node) {
  assertConfiguredCopy(node, 'result', END_RESULT_COPY_ERRORS);
}

function captureEndResult(node) {
  return readConfiguredCopy(node, 'result', END_RESULT_COPY_ERRORS, null);
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
//
// The search is an iterative three-color DFS with an explicit frame stack:
// a recursive walk over a legal definition tens of thousands of chained
// nodes deep would overflow the call stack before producing a result. `path`
// holds the gray nodes in DFS order (what a recursive stack would hold) and
// `depthById` locates a gray node in it, so a back edge still reports
// exactly the cycle segment — never the entry path leading into it.
function detectCycles(nodes) {
  const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
  for (const [id, node] of nodes) {
    adjacency.get(id).push(...successorTargets.get(node));
    for (const dependency of nodeDependencies.get(node)) {
      adjacency.get(dependency).push(id);
    }
  }
  const color = new Map([...nodes.keys()].map(id => [id, 'white']));

  for (const root of nodes.keys()) {
    if (color.get(root) !== 'white') continue;
    color.set(root, 'gray');
    const path = [root];
    const depthById = new Map([[root, 0]]);
    // Each frame is [node id, index of the next outgoing edge to examine].
    const frames = [[root, 0]];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const id = frame[0];
      const edges = adjacency.get(id);
      if (frame[1] < edges.length) {
        const target = edges[frame[1]];
        frame[1] += 1;
        const targetColor = color.get(target);
        if (targetColor === 'gray') {
          const start = depthById.get(target);
          const chain = [...path.slice(start), target];
          throw new Error(`cycle is present: ${chain.join(' -> ')}`);
        }
        if (targetColor === 'white') {
          color.set(target, 'gray');
          depthById.set(target, path.length);
          path.push(target);
          frames.push([target, 0]);
        }
      } else {
        frames.pop();
        path.pop();
        depthById.delete(id);
        color.set(id, 'black');
      }
    }
  }
}

// Internal compile pass: validates the whole definition and returns the node
// table together with the per-form rules and per-condition trees compiled by
// THIS pass. Both maps are fresh per validation and keyed by the node objects
// of this definition — they deliberately are not shared in module-level,
// node-keyed storage, so a later validateWorkflow (or execution entry) against
// the same node objects can never overwrite the rules an earlier,
// still-running run accepted. Each execution captures both maps at its own
// start, before the first suspension, and every form and condition in that
// run keeps using exactly what this pass produced. A condition node with no
// compiled entry never exists (conditions are mandatory on the node), but the
// map still answers only for the definition this pass saw.
function compileWorkflow(workflow) {
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

  // Owned by this validation only; a form with no schema maps to null so the
  // execution loop can distinguish "compiled, no schema" without re-reading
  // the live node. The condition map holds the complete frozen expression
  // tree each run captures at its start — compounds, child order, operators
  // and both comparison-side data sources included.
  const formRules = new Map();
  const conditionRules = new Map();

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
      formRules.set(node, compileFormSchema(node));
    }
    if (node.type === 'condition') {
      conditionRules.set(node, compileCondition(node.condition, nodes, node.id));
    }
    if (node.type === 'action') {
      actionBindings.set(node, compileAction(node));
    }
    if (node.type === 'end') {
      compileEndResult(node);
    }
  }

  if (requiresSingleEnd) {
    const endCount = [...nodes.values()].filter(node => node.type === 'end').length;
    if (endCount !== 1) {
      throw new Error('workflows using array successors or dependsOn must declare exactly one end node');
    }
  }

  detectCycles(nodes);
  return { nodes, formRules, conditionRules };
}

export function validateWorkflow(workflow) {
  return compileWorkflow(workflow).nodes;
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

// Applies one field default, recording every write in `undo` as [object, key]
// pairs — one per parent object created along the path, then the leaf itself —
// so a failed form can remove exactly its own additions afterwards. A default
// only ever adds own properties (the field was missing, and missing parents
// are created as fresh objects), so deleting those keys in reverse order
// restores the input to precisely its pre-form state: values and objects that
// predate the form — including own properties an earlier successful form
// added, on plain objects and on host objects such as a Date — are never
// touched, and the existing reference graph (shared or circular references)
// is kept as-is rather than replaced by a clone.
function applyDefault(root, segments, value, undo) {
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
      undo.push([current, part]);
      current = created;
    }
  }
  const leaf = segments[segments.length - 1];
  current[leaf] = value;
  undo.push([current, leaf]);
  return true;
}

function processFormField(spec, input, nodeId, undo) {
  const error = code => ({ nodeId, path: spec.path, code });
  const { exists, value } = lookupOwn(input, spec.segments);

  if (!exists) {
    if (spec.hasDefault) {
      if (!isUsableObject(input) || !applyDefault(input, spec.segments, spec.default, undo)) {
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
  const undo = [];
  const errors = [];
  for (const spec of compiled) {
    const fieldError = processFormField(spec, input, node.id, undo);
    if (fieldError) errors.push(fieldError);
  }
  if (errors.length === 0) return { ok: true };
  // Roll back only this form's own writes, newest first: each added leaf is
  // deleted, and each parent object created solely for those leaves is
  // removed with it. Everything that was already there — caller data,
  // earlier successful forms' defaults (including own properties they added
  // to a Date or any other host object, which a structuredClone snapshot
  // would silently drop), and the input's shared/circular reference
  // topology — stays exactly as it was.
  for (let i = undo.length - 1; i >= 0; i -= 1) {
    const [object, key] = undo[i];
    delete object[key];
  }
  return { ok: false, errors };
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
// When the text cannot be read — because identifying the value itself
// throws (a revoked Proxy, or a proxy whose getPrototypeOf trap throws, both
// of which make `instanceof` throw), because the message is not a string or
// its getter throws, or because String() cannot convert the value — a fixed
// placeholder is recorded so the run result is never rejected; the original
// value is left untouched. Both synchronous throws and rejected Promises
// reach this via the same try/await.
function describeError(error) {
  let isError;
  try {
    isError = error instanceof Error;
  } catch {
    return UNREADABLE_ERROR_MESSAGE;
  }
  if (isError) {
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

// Canonical "buffer" getters bound to the real internal slot. An own
// "buffer" property can be defined on a typed array / DataView to shadow the
// prototype accessor with a plain ArrayBuffer while the object still keeps
// shared bytes in its slot — so the backing buffer must always be read through
// these getters, never through a plain `view.buffer` property access.
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'buffer').get;
const DATAVIEW_BUFFER_GETTER = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;

// A structured clone of a SharedArrayBuffer — or of a typed array / DataView
// backed by one — succeeds, but the clone keeps sharing the underlying bytes
// with the object the operation implementation holds: mutating those bytes
// later would mutate the value the engine saved, breaking the promise that
// every saved output is an independent copy. Such a return value is therefore
// explicitly unsupported and fails the attempt.
//
// This runs on the value AFTER structuredClone has produced it, so it judges
// exactly the content that will be saved — never the original return value.
// That ordering matters:
// - an enumerable getter is invoked only by the clone's own read; the check
//   sees the value that was actually saved (a getter returning 7 first and
//   shared bytes later saves — and is judged on — 7);
// - a Map/Set with a custom Symbol.iterator (empty, throwing, or fabricating
//   entries) cannot hide its real members or invent shared memory, because
//   the clone already captured the true internal entries;
// - properties the clone discards (own properties of Date/RegExp/byte views,
//   symbol-keyed or non-enumerable properties, Error own properties other
//   than "cause") are simply absent here and can never fail the attempt.
// The clone graph contains only genuine clone-produced objects — no getters,
// proxies or custom iterators — so the traversal below can never observe
// user code; the remaining guards only keep it total for host objects the
// clone may carry (DOMException, Blob/File, CryptoKey) and cross-realm
// values. Classification uses Node's internal-slot brand checks
// (util.types), which recognize buffers, views, containers, errors,
// Date/RegExp and boxed primitives from another realm and reject objects
// merely faking the right @@toStringTag. DOMException is checked before the
// native-error branch: util.types brands it as an Error, but unlike a real
// Error its "cause" is not cloned. A plain ArrayBuffer and its views are
// accepted; circular and repeated references are visited once via an
// identity set, so legal graphs' reference relationships are unaffected.
const HOST_LEAF_CONSTRUCTORS = [
  // DOMException must precede the native-error branch (see above).
  typeof DOMException === 'function' ? DOMException : null,
  // instanceof Blob also matches File.
  typeof Blob === 'function' ? Blob : null,
  typeof CryptoKey === 'function' ? CryptoKey : null,
].filter(constructor => constructor !== null);

function isInstanceOfGuarded(value, constructor) {
  try {
    return value instanceof constructor;
  } catch {
    // A revoked proxy (or a throwing Symbol.hasInstance/prototype trap)
    // cannot be classified this way; fall through to ordinary traversal.
    return false;
  }
}

// Array.isArray performs a proxy-revocation check (IsArray) and throws on a
// revoked proxy, unlike the internal-slot brand checks. A throw means the
// value cannot be classified as an array here; the Object.keys step below is
// guarded too and structuredClone reports the unreadable value itself.
function isArrayGuarded(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function containsSharedMemory(value) {
  let rootIsObject;
  try {
    rootIsObject = value !== null && typeof value === 'object';
  } catch {
    // Even `typeof` can throw for a revoked proxy; structuredClone will reject
    // it on its own in the caller.
    return false;
  }
  if (!rootIsObject) return false;

  const seen = new Set();
  const stack = [];

  const pushIfObject = child => {
    let isObject;
    try {
      isObject = child !== null && typeof child === 'object';
    } catch {
      return;
    }
    if (isObject && !seen.has(child)) {
      seen.add(child);
      stack.push(child);
    }
  };
  const read = (object, property) => {
    try {
      return [true, object[property]];
    } catch {
      return [false];
    }
  };

  seen.add(value);
  stack.push(value);

  while (stack.length > 0) {
    const current = stack.pop();

    if (nodeTypes.isSharedArrayBuffer(current)) return true;
    if (nodeTypes.isArrayBuffer(current)) {
      // A plain ArrayBuffer is copied byte-for-byte. Own properties attached
      // to it are dropped by the clone anyway, so nothing needs traversal.
      continue;
    }
    if (nodeTypes.isTypedArray(current)) {
      // A typed array (Int8Array … BigUint64Array): the clone copies only the
      // bytes of the view's backing buffer — custom own properties on the
      // view are dropped. Read the true internal slot, since an own "buffer"
      // property could otherwise shadow it with a plain ArrayBuffer.
      let buffer = null;
      try {
        buffer = TYPED_ARRAY_BUFFER_GETTER.call(current);
      } catch {
        buffer = null;
      }
      if (buffer !== null && nodeTypes.isSharedArrayBuffer(buffer)) return true;
      continue;
    }
    if (nodeTypes.isDataView(current)) {
      let buffer = null;
      try {
        buffer = DATAVIEW_BUFFER_GETTER.call(current);
      } catch {
        buffer = null;
      }
      if (buffer !== null && nodeTypes.isSharedArrayBuffer(buffer)) return true;
      continue;
    }

    // Host clone leaves whose internal slots alone are copied: any own
    // property attached to them is discarded by structuredClone, so shared
    // memory carried there never reaches the saved value. This must precede
    // the native-error branch — DOMException brands as a native error but,
    // unlike a real Error, has no cloned "cause".
    let isHostLeaf = false;
    for (const constructor of HOST_LEAF_CONSTRUCTORS) {
      if (isInstanceOfGuarded(current, constructor)) {
        isHostLeaf = true;
        break;
      }
    }
    if (isHostLeaf) continue;

    if (isArrayGuarded(current)) {
      // Enumerable indices plus enumerable own string-keyed non-index
      // properties, exactly as structuredClone treats arrays: a
      // non-enumerable property — including a non-enumerable index, which
      // clones as a hole — is dropped and therefore never inspected.
      let keys;
      try {
        keys = Object.keys(current);
      } catch {
        keys = [];
      }
      for (const key of keys) {
        const [exists, child] = read(current, key);
        if (exists) pushIfObject(child);
      }
      continue;
    }

    if (nodeTypes.isMap(current)) {
      try {
        for (const [key, child] of current) {
          pushIfObject(key);
          pushIfObject(child);
        }
      } catch {
        // An unreadable iterator exposes nothing else to inspect.
      }
      continue;
    }
    if (nodeTypes.isSet(current)) {
      try {
        for (const member of current) pushIfObject(member);
      } catch {
        // Ignore an unreadable iterator.
      }
      continue;
    }
    if (nodeTypes.isNativeError(current)) {
      // Only "cause" survives an Error clone (message/name/stack are copied
      // as primitives; other own properties are dropped), so it alone needs
      // traversal — including when it is non-enumerable.
      let present;
      try {
        present = Object.hasOwn(current, 'cause');
      } catch {
        present = false;
      }
      if (present) {
        const [, child] = read(current, 'cause');
        pushIfObject(child);
      }
      continue;
    }

    if (nodeTypes.isDate(current) || nodeTypes.isRegExp(current)
      || nodeTypes.isBoxedPrimitive(current)) {
      // Date and RegExp clone only their internal value/pattern; boxed
      // primitives (Number/String/Boolean/BigInt/Symbol) only their wrapped
      // primitive. Every attached own property — enumerable or not — is
      // dropped, so it can never carry shared memory into the saved value.
      continue;
    }

    // Plain objects and arbitrary class instances (any prototype): only own
    // enumerable string-keyed properties participate in the clone.
    // Symbol-keyed and non-enumerable properties are skipped exactly as
    // structuredClone skips them.
    let keys;
    try {
      keys = Object.keys(current);
    } catch {
      continue;
    }
    for (const key of keys) {
      const [exists, child] = read(current, key);
      if (exists) pushIfObject(child);
    }
  }
  return false;
}

// The single independent-copy rule every value the engine saves goes through,
// regardless of where the value comes from — a legacy action's `message`, an
// end node's `result`, a business or compensation return value, or the run
// input itself: clone first, then judge the clone with containsSharedMemory.
//
// Cloning must come first so the judgment targets exactly the content that
// will be saved, never the original value:
// - an enumerable getter is invoked only by the clone's own read; the check
//   sees the value that was actually saved (a getter returning ordinary
//   content first and shared bytes later saves — and is judged on — the
//   ordinary content), and no caller adds a second read of the original;
// - a Map/Set with a custom Symbol.iterator (empty, throwing, or fabricating
//   entries) can neither hide its real members nor invent shared ones,
//   because the clone already captured the true internal entries;
// - properties the clone discards (own properties of Date/RegExp/byte views,
//   symbol-keyed or non-enumerable properties, Error own properties other
//   than "cause") are simply absent from the clone and can never fail it.
// Uncloneability takes precedence over retained shared memory because the
// clone attempt short-circuits before the traversal.
//
// The outcome is reported rather than thrown, so each source keeps its own
// public failure behavior on top of the shared rule: { ok: true, copy } on
// success; otherwise { ok: false, reason } with reason 'uncloneable' (the
// value cannot be structured-cloned at all — `error` carries the raw clone
// failure for callers that propagate it) or 'sharedMemory' (the clone
// succeeded but retains shared bytes).
function independentCopy(value) {
  let cloned;
  try {
    cloned = structuredClone(value);
  } catch (error) {
    return { ok: false, reason: 'uncloneable', error };
  }
  if (containsSharedMemory(cloned)) {
    return { ok: false, reason: 'sharedMemory' };
  }
  return { ok: true, copy: cloned };
}

// Receives the caller's run input: put it through independentCopy, the same
// clone-then-judge rule every other saved value (configured message/result,
// business or compensation return) already follows. The run input is promised
// to every node — and to every business attempt and compensation snapshot —
// as an independent copy, and a SharedArrayBuffer cannot satisfy that
// promise: cloning it (or a typed array / DataView backed by one) "succeeds"
// while the clone keeps sharing the underlying bytes with the object the
// caller holds, so a business action that rewrites its input copy could
// mutate the caller's data, and a failed attempt's rewrite would leak into
// the next attempt and later retries. An input whose clone actually retains
// shared memory is therefore rejected before any node can run — a TypeError
// (the synchronous entry throws it; the asynchronous entry rejects with the
// same error) explaining that the run input contains shared memory and
// independent copies cannot be guaranteed. An input that cannot be cloned at
// all keeps the raw structuredClone failure, as before.
const RUN_INPUT_SHARED_MEMORY_MESSAGE = 'run input contains shared memory (SharedArrayBuffer or a typed array/DataView backed by one); independent copies cannot be guaranteed, so this run cannot be started';

function cloneRunInput(input) {
  const copy = independentCopy(input);
  if (!copy.ok) {
    if (copy.reason === 'uncloneable') throw copy.error;
    throw new TypeError(RUN_INPUT_SHARED_MEMORY_MESSAGE);
  }
  return copy.copy;
}

// Builds the independent input copy handed to a single business attempt or
// stored (and later handed, again copied, to compensation) at an action's
// success moment.
//
// A plain structuredClone is almost that copy, but it cannot carry a default
// a successful form adds onto a host object during the run: forms apply
// defaults as ordinary own properties on the live run input, so the input
// itself and the following conditions see them at once, but structuredClone
// reproduces a Date (and every other clone-special node — RegExp, Map/Set own
// properties, byte views, Errors apart from "cause", boxed primitives) from
// its internal value alone and silently drops every attached own property.
// The business action's argument copy, the compensation snapshot and each
// compensation attempt's copy therefore lost exactly the run-time form
// defaults, while plain-object defaults kept working.
//
// Receiver-time handling is unchanged: cloneRunInput already discarded the
// own properties the CALLER attached to such an object before the run, and
// forms only ever add properties (never remove another form's survivors), so
// within a run every own property of a live node that is missing from its
// structured-clone counterpart is precisely a subtree a successful form
// created there — primitive defaults at the leaves and fresh plain-object
// parents along the path. This walks the live graph and its clone in
// lockstep, reattaches an independent copy of each such dropped subtree, and
// otherwise leaves the clone exactly as structuredClone produced it:
//  - the Date keeps its original type and time value, the default merely
//    joins it as an own property;
//  - the whole multi-level path a default created is reattached together;
//  - identity the clone preserved is kept — when two input fields point at
//    one Date, both still point at the single reattached clone node inside
//    this copy (each invocation gets its own copy, so retries and the live
//    run input stay independent of one another);
//  - a reattached subtree is itself structured-cloned, so an action or
//    compensation editing a default, a created parent or the Date itself
//    cannot reach the run input, the caller's input or any other copy.
function copyInputWithFormDefaults(input) {
  const clone = structuredClone(input);
  const processed = new Set();
  // Pairs of [live node, its clone counterpart]. The lockstep walk follows
  // enumerable own properties — the same protocol forms and lookupOwn
  // navigate by — on plain objects, host objects and arrays alike, mirroring
  // the clone graph node for node. (Form paths may not cross an array
  // intermediate — such a default is a type error — but descending into
  // arrays anyway keeps the pairing total and harmless.) The internal entries
  // of Map/Set and the slots of byte views are unreachable by own-property
  // paths and need no pairing.
  const stack = [[input, clone]];
  const isTraversable = value => value !== null && typeof value === 'object';
  while (stack.length > 0) {
    const [source, target] = stack.pop();
    if (processed.has(source)) continue;
    processed.add(source);

    let keys;
    try {
      keys = Object.keys(source);
    } catch {
      continue;
    }
    for (const key of keys) {
      let sourceValue;
      try {
        sourceValue = source[key];
      } catch {
        continue;
      }
      let targetHasProperty;
      try {
        targetHasProperty = Object.hasOwn(target, key);
      } catch {
        targetHasProperty = false;
      }
      if (!targetHasProperty) {
        // The clone dropped this own property: a run-time form default riding
        // on a clone-special node (an own property of a Date, of a Map/Set,
        // and so on). Form-created subtrees hold only primitives and fresh
        // plain objects, so this clone always succeeds; cloning here detaches
        // the reattached subtree from the live run input. Define an own data
        // property rather than assigning, so no inherited setter (e.g. an
        // object's __proto__) can intercept the reattachment.
        if (sourceValue !== undefined) {
          Object.defineProperty(target, key, {
            value: structuredClone(sourceValue),
            writable: true, enumerable: true, configurable: true,
          });
        }
        continue;
      }
      let targetValue;
      try {
        targetValue = target[key];
      } catch {
        continue;
      }
      if (isTraversable(sourceValue) && isTraversable(targetValue)) {
        stack.push([sourceValue, targetValue]);
      }
    }
  }
  return clone;
}

// Runs an operation under a retry policy — the one attempt loop shared by
// business actions and compensations. Every invocation works on fresh
// structured-clone argument copies produced by prepareArgs, so mutations by
// a failed attempt are discarded before the next try; a thrown exception, a
// rejected Promise, a return value carrying shared memory (a
// SharedArrayBuffer or a byte view over one, anywhere in the saved graph),
// or a return value that cannot be structured-cloned all count as a failed
// attempt. Shared memory is rejected explicitly: cloning it "succeeds" but
// keeps sharing the underlying bytes with an object the implementation can
// still mutate, so no independent saved copy is possible. On success the
// recorded value is a clone independent of any object the implementation
// keeps holding. Attempts are numbered from 1, the wait after a failure
// follows the configured backoff (zero stays zero, nothing is awaited after
// the last attempt), and each actual invocation appends exactly one record,
// in order, via collect.
//
// The two callers differ only through the hooks:
// - prepareArgs(attempt) builds this attempt's fresh argument copies;
// - invoke is the registered implementation, called as invoke(...args);
// - createRecord(attempt) shapes the record (business attempts carry no
//   operation/result fields, compensation attempts do);
// - copyFailureMessages names the operation kind for the two ways a return
//   value can fail the shared independent-copy rule: `uncloneable` for a
//   value that cannot be structured-cloned, `sharedMemory` for one whose
//   clone retains shared memory it cannot be isolated from;
// - collect appends to the caller's own attempt list;
// - onSuccess stores caller-specific success data on the record.
// When a cancellation signal is given, no new attempt starts once it has
// fired — even with a zero retry delay — and a wait in progress ends early;
// an attempt already running is always awaited and its outcome recorded.
// Compensation passes no signal and is therefore never interrupted.
async function runWithRetries({
  retry, signal = null, prepareArgs, invoke, createRecord,
  copyFailureMessages, collect, onSuccess,
}) {
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

    // The shared independent-copy rule (independentCopy): clone first, then
    // judge the clone, so the check reflects exactly the content that will be
    // saved — never the original return value, whose enumerable getters must
    // not be read an extra time and whose Map/Set members must be read from
    // the real internal entries, not a possibly-overridden Symbol.iterator.
    // A return value whose normal reads throw, or that cannot be cloned at
    // all, is the ordinary uncloneable failure — never an exception escaping
    // the run.
    if (record.error === null) {
      const copy = independentCopy(returned);
      if (copy.ok) {
        returned = copy.copy;
      } else {
        lastReason = copyFailureMessages[copy.reason];
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
// independent copies of the current input and the successful outputs so far;
// the input copy goes through copyInputWithFormDefaults rather than a bare
// structured clone, so defaults a successful form added onto a Date (or any
// clone-special object) during this run stay readable while the Date keeps
// its type and time. The stored success value is a clone independent of any
// object the implementation keeps holding. The cancellation signal applies
// to this loop only — compensation runs without one.
async function runBusinessAction(node, binding, implementation, context, actionAttempts, signal) {
  return runWithRetries({
    retry: binding.retry,
    signal,
    prepareArgs: attempt => [copyInputWithFormDefaults(context.input), structuredClone(context.output), node.id, attempt],
    invoke: implementation,
    createRecord: attempt => ({ nodeId: node.id, attempt, ok: false, error: null, nextDelayMs: 0 }),
    copyFailureMessages: {
      uncloneable: `operation "${binding.name}" returned a value that cannot be structured-cloned`,
      sharedMemory: `operation "${binding.name}" returned a value that contains shared memory (SharedArrayBuffer or a typed array/DataView backed by one); independent copies cannot be guaranteed, so this return value is not supported`,
    },
    collect: record => actionAttempts.push(record),
    onSuccess: () => {},
  });
}

// Runs compensation for one already-succeeded business action. The call gets
// independent copies of the input and earlier outputs captured at the
// original action's success moment, the stored return value, the node id and
// a 1-based compensation attempt number. The input snapshot was captured via
// copyInputWithFormDefaults and is copied again through it per attempt, so
// the success-moment form defaults — including ones attached to a Date —
// reach every attempt while remaining detached from it: mutating them, the
// Date or a created parent on one failed attempt cannot touch the snapshot,
// the run context, a later attempt, another run, or the stored success
// output.
async function runCompensation(entry, implementation, records) {
  const { nodeId, binding, snapshot } = entry;
  return runWithRetries({
    retry: binding.compensation.retry,
    prepareArgs: attempt => [
      copyInputWithFormDefaults(snapshot.input), structuredClone(snapshot.output),
      structuredClone(snapshot.result), nodeId, attempt,
    ],
    invoke: implementation,
    createRecord: attempt => ({
      nodeId, operation: binding.compensation.name, attempt,
      ok: false, error: null, nextDelayMs: 0, result: null,
    }),
    copyFailureMessages: {
      uncloneable: `compensation "${binding.compensation.name}" returned a value that cannot be structured-cloned`,
      sharedMemory: `compensation "${binding.compensation.name}" returned a value that contains shared memory (SharedArrayBuffer or a typed array/DataView backed by one); independent copies cannot be guaranteed, so this return value is not supported`,
    },
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
//
// The caller input is received — cloned and checked for retained shared
// memory — here, the single point every entry passes through before any node
// can run. Both entries call this after the definition, cancellation-option
// and operation-registration checks but (for the asynchronous entry) before
// the already-aborted-at-start short-circuit, so a shared-memory input is
// rejected with a TypeError even when the signal has already fired.
// `formRules` and `conditionRules` are the per-node compiled maps produced by
// the validation pass THIS run started through. They are captured here —
// before the first suspension point — as part of the run state, so forms and
// conditions that execute only after a business-operation wait keep using the
// rules and expression trees that start-time validation accepted. A later
// validateWorkflow or a new run over the same node objects builds its own maps
// and cannot reach these. The compiled entries hold only primitives (field
// types restrict defaults to primitives; comparison constants must themselves
// be cloneable primitives) and freshly built segment arrays, so each snapshot
// is already independent of the caller's definition.
function createRunState(nodes, workflow, input, formRules, conditionRules) {
  const declarationOrder = [...nodes.values()];
  const declarationIndex = new Map(declarationOrder.map((node, index) => [node.id, index]));
  return {
    trace: [],
    actionAttempts: [],
    context: { input: cloneRunInput(input), output: {} },
    formRules,
    conditionRules,
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

// One shared scheduling step for the synchronous and asynchronous entries.
// pickReadyNode already encodes activation plus dependency gating; this adds
// the rules the two entries used to duplicate:
// - a ready node is recorded in the trace the moment it enters execution, so
//   waiting and never-activated nodes never appear in trace or output;
// - an end node records its result and completes, but never stops the other
//   activated branches — the caller simply loops again;
// - with no ready node left, activated-but-waiting nodes classify the run as
//   "blocked", a visited end node as "completed", and anything else is a
//   structural cycle (validation rejects those before execution).
// The terminal kinds are classifications only: each entry keeps building its
// own result shape (the asynchronous one adds attempt and compensation
// fields) so the public return values are unchanged.
function advanceSchedule(state) {
  const ready = pickReadyNode(state);
  if (!ready) {
    const waiting = blockedResult(state);
    if (waiting) return { kind: 'blocked', waiting };
    if (state.endReached) return { kind: 'completed' };
    throw new Error('workflow did not terminate; a cycle is present');
  }
  state.trace.push({ nodeId: ready.id, type: ready.type });
  if (ready.type === 'end') {
    // Reaching an end node records the result but never stops other
    // activated branches; the run completes once nothing can still run.
    // Produce the independent snapshot at THIS end node's own execution
    // moment from the value actually read now: later mutation of the
    // definition's result (during a wait on another activated branch), of
    // another run's result, or of the returned value cannot reach back
    // here. Validation only proves the result was cloneable — and free of
    // retained shared memory — as it was then; an enumerable getter may
    // answer differently on this, its only execution-time read, and a
    // preceding business operation may have replaced ordinary buffers with
    // shared ones (or vice versa). The success is therefore recorded only
    // if this read's clone is independently copyable. captureEndResult
    // throws the end-result error (uncloneable, or retained shared memory)
    // here: the synchronous entry propagates it and the asynchronous
    // entry's Promise rejects with it — never a "completed" result, never
    // an action_failed (no retry budget is spent) and no compensation runs.
    // An unset or null result stays null; 0, false and "" pass through.
    // Capture first: if the value read now cannot be independently copied,
    // the throw leaves no partially-recorded end behind (the whole run is
    // rejected, sync throw / async rejection, before endReached is set).
    const result = captureEndResult(ready);
    state.endReached = true;
    state.endResult = result;
    state.completed.add(ready.id);
    return { kind: 'end' };
  }
  return { kind: 'run', node: ready };
}

// Applies a ready non-action node, mutating activation/completion state.
// Returns an early-termination result (invalid_input / invalid_condition)
// or null when execution should continue.
function applyRegularNode(node, state) {
  if (node.type === 'action') {
    // Snapshot the legacy message at this action's own execution moment via
    // the shared configured-value rule (readConfiguredCopy): the saved output
    // is this run's independent deep copy, so editing nested fields, adding or
    // deleting properties, or changing array members of the returned output
    // never reaches the definition, another run, or an output this action
    // recorded while another activated branch is still waiting.
    // Validation only proved the message was safe as it was then — an
    // enumerable getter may answer differently on this, its only
    // execution-time read, and a preceding business operation may have
    // replaced ordinary buffers with shared ones (or vice versa) — so the
    // rule re-checks the value actually read now and throws the action-node
    // error (uncloneable, or retained shared memory) when this run's copy
    // cannot be independent. That throw is not a run status: the synchronous
    // entry propagates it and the asynchronous entry's Promise rejects with
    // it — never an action_failed, no retry budget is spent, no compensation
    // runs, no output is recorded for this node and no later node executes.
    // An unset, undefined or null message defaults to action:<node id>; "", 0
    // and false pass through untouched.
    setNodeOutput(
      state.context.output,
      node.id,
      readConfiguredCopy(node, 'message', ACTION_MESSAGE_COPY_ERRORS, `action:${node.id}`),
    );
  }
  if (node.type === 'form') {
    const compiled = state.formRules.get(node);
    if (compiled) {
      const formResult = processForm(node, state.context.input, compiled);
      if (!formResult.ok) {
        return { status: 'invalid_input', context: state.context, trace: state.trace, errors: formResult.errors };
      }
    }
  }
  if (node.type === 'condition') {
    const outcome = runCondition(state.conditionRules.get(node), state.context.input, state.context.output, node.id);
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
  const { nodes, formRules, conditionRules } = compileWorkflow(workflow);
  // Business operations are asynchronous: the synchronous entry must refuse
  // a workflow that names any before a single node executes.
  for (const node of nodes.values()) {
    const binding = actionBindings.get(node);
    if (binding && binding.name !== null) {
      throw new Error(`action node ${node.id} names business operation "${binding.name}", which must run asynchronously; use executeWorkflowAsync instead of executeWorkflow`);
    }
  }

  const state = createRunState(nodes, workflow, input, formRules, conditionRules);

  for (;;) {
    const step = advanceSchedule(state);

    if (step.kind === 'blocked') {
      return { status: 'blocked', context: state.context, trace: state.trace, blockedNodes: step.waiting };
    }
    if (step.kind === 'completed') {
      return { status: 'completed', result: state.endResult, context: state.context, trace: state.trace };
    }
    if (step.kind === 'end') continue;

    const early = applyRegularNode(step.node, state);
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
  const { nodes, formRules, conditionRules } = compileWorkflow(workflow);
  verifyOperations(nodes, operations);

  const state = createRunState(nodes, workflow, input, formRules, conditionRules);

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

    const step = advanceSchedule(state);

    if (step.kind === 'blocked') {
      // Unmet dependencies end the run; successful compensable actions are
      // rolled back even though an end node may already have been reached.
      return withCompensation({
        status: 'blocked', context: state.context, trace: state.trace,
        blockedNodes: step.waiting, actionAttempts: state.actionAttempts,
      }, state, operations);
    }
    if (step.kind === 'completed') {
      // A completed run never invokes compensation.
      return {
        status: 'completed', result: state.endResult, context: state.context,
        trace: state.trace, actionAttempts: state.actionAttempts,
        compensationStatus: 'not_needed', compensationAttempts: [],
      };
    }
    if (step.kind === 'end') continue;

    const ready = step.node;
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
        // compensation separately as its third argument. The input snapshot
        // goes through copyInputWithFormDefaults, so it freezes exactly the
        // defaults already effective at this action's success moment —
        // including ones a form attached to a Date — while fields a later
        // form adds to the live run input can never enter it.
        const compensationSnapshot = binding.compensation === null ? null : {
          input: copyInputWithFormDefaults(state.context.input),
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
