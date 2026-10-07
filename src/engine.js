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

// The successor edges every run resolves against, keyed by node object. A
// validation pass publishes into this map ONLY after the whole definition has
// been accepted (see compileWorkflow): a rejected validateWorkflow — whether
// it fails on a later node's edge, on a cycle found after every connection
// checked out, or on any other node, reachable or not — leaves the edges the
// most recent SUCCESSFUL validation accepted untouched, so a run already in
// flight keeps following exactly those. A successful revalidation replaces
// them, and runs started (or still parked) afterwards see the new edges.
const successorTargets = new WeakMap();

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
// `successors` and `dependencies` are the per-pass maps compileWorkflow
// built, keyed by the node objects of this definition; neither is read from
// module-level, node-keyed storage, so a later validateWorkflow over the same
// objects can never change which relations this check (or a run that started
// through it) uses.
//
// The search is an iterative three-color DFS with an explicit frame stack:
// a recursive walk over a legal definition tens of thousands of chained
// nodes deep would overflow the call stack before producing a result. `path`
// holds the gray nodes in DFS order (what a recursive stack would hold) and
// `depthById` locates a gray node in it, so a back edge still reports
// exactly the cycle segment — never the entry path leading into it.
function detectCycles(nodes, successors, dependencies) {
  const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
  for (const [id, node] of nodes) {
    adjacency.get(id).push(...successors.get(node));
    for (const dependency of dependencies.get(node)) {
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
// table together with the per-form rules, per-condition trees, per-action
// business bindings and per-node dependency lists compiled by THIS pass. The
// four maps are fresh per validation and keyed by the node objects of this
// definition — they deliberately are not shared in module-level, node-keyed
// storage, so a later validateWorkflow (or execution entry) against the same
// node objects can never overwrite the form rules, the condition expression,
// the business action configuration or the explicit dependsOn relations an
// earlier, still-running run accepted. Each execution captures all four maps
// at its own start, before the first suspension, and every form, condition,
// business action and dependency gate in that run keeps using exactly the
// rules, tree, binding and dependency list captured then — including the
// action's operation name, retry settings, and whether it compensates with
// which compensation operation and retry settings.
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
  // the live node. The condition map holds the whole compiled condition tree
  // of every condition node this pass accepted; the action map holds the
  // compiled business binding (operation name, retry, compensation) of every
  // action node this pass accepted; the dependency map holds a fresh array of
  // dependency node ids — copied out of the definition — for every node this
  // pass accepted (an absent dependsOn maps to []). All four maps are
  // captured by the run that starts through this pass and never shared with a
  // later one, so editing the original dependsOn array in place, replacing
  // it with another array, deleting the property or adding one afterwards
  // reaches only runs started later.
  //
  // The successor map is the resolved next/then/else edges of every node this
  // pass accepted. It stays local to the pass while validation is in
  // progress: the edges a run follows live in the shared successorTargets
  // map, and this pass publishes into that map only after the WHOLE
  // definition has been accepted (the commit just below the cycle check). A
  // validateWorkflow that is rejected — by a later node's bad edge, by a
  // cycle discovered only after every connection checked out, or by a node on
  // an untaken branch or one the entry cannot reach — therefore cannot
  // replace the edges the most recent successful validation installed: an
  // in-flight run parked on a business operation keeps the successors its
  // start-time validation accepted, never a rejected edit's. This covers
  // every way next can change — a replaced single target, a replaced array,
  // and elements added to or removed from the original array in place — since
  // only the committed arrays are ever read at execution.
  const formRules = new Map();
  const conditionRules = new Map();
  const actionBindings = new Map();
  const dependencies = new Map();
  const successors = new Map();

  let requiresSingleEnd = false;
  for (const node of nodes.values()) {
    successors.set(node, normalizeSuccessors(node, nodes));
    const nodeDependencies = normalizeDependencies(node, nodes, workflow.entry);
    dependencies.set(node, nodeDependencies);
    const usesArraySuccessors = node.type !== 'end' && node.type !== 'condition' && Array.isArray(node.next);
    if (usesArraySuccessors || nodeDependencies.length > 0) requiresSingleEnd = true;
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

  detectCycles(nodes, successors, dependencies);

  // The definition is fully accepted: publish this pass's successor edges so
  // runs resolving successors from here on — including runs already parked on
  // a business operation — see them. Until this point a rejected pass has
  // touched nothing a run can observe.
  for (const [node, targets] of successors) {
    successorTargets.set(node, targets);
  }
  return { nodes, formRules, conditionRules, actionBindings, dependencies };
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

// A canonical numeric index string in the spec sense ("2", "0", "-0", but
// not "02", "2.5" or " 2"): exactly the property names a typed array treats
// as element indices rather than ordinary own properties.
function isCanonicalNumericIndex(segment) {
  if (segment === '-0') return true;
  return String(Number(segment)) === segment;
}

// A typed array's element set is fixed at creation: every index below its
// length already exists, and an out-of-bounds index can never be added —
// assigning to one is silently ignored (the integer-indexed exotic [[Set]]
// reports success without storing anything, even in strict mode). Letting
// that no-op pass as a successful default write would report a field the
// input does not actually carry, so a default whose path ends at — or merely
// crosses — a missing typed-array index fails as a type error, exactly like
// a path crossing a primitive. Ordinary property names on a typed array
// (including numeric-looking strings that are not canonical indices, such as
// "02" or "2.5") remain plain own properties a default can add, and existing
// in-bounds indices keep the field's normal type and range checks.
function isUnwritableTypedArrayIndex(object, segment) {
  return nodeTypes.isTypedArray(object) && isCanonicalNumericIndex(segment)
    && !Object.hasOwn(object, segment);
}

// Defines `key` as a fresh own enumerable data property holding `value` on
// `object`, never assigning through the prototype chain. A structured input
// may legitimately be a host object whose prototype already answers the same
// name with an inherited member a default is allowed to shadow with an own
// property — a Map's prototype, for example, carries "size" as an
// accessor-only property: an own "size" is a perfectly legal field, but a
// plain `object[key] = value` [[Set]] finds the inherited getter (with no
// setter) and throws a TypeError instead of creating the own property the
// field needs. Definition bypasses [[Set]] entirely and installs exactly the
// own data property the missing-field semantics call for. The path compiler
// already rejects "__proto__", so an inherited setter for that name can never
// reach this either.
function defineOwnField(object, key, value) {
  Object.defineProperty(object, key, {
    value, writable: true, enumerable: true, configurable: true,
  });
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
//
// Presence is judged with hasOwn at every step: a value inherited from the
// prototype (Map.prototype.size and friends) neither fills a missing field
// nor blocks a default. When an own parent is missing it is created even if
// the prototype answers that name — the default never descends into the
// inherited member — and the writes use defineOwnProperty so an inherited
// read-only or accessor-only property cannot make the legal default throw.
function applyDefault(root, segments, value, undo) {
  let current = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const part = segments[i];
    if (Object.hasOwn(current, part)) {
      const next = current[part];
      if (!isUsableObject(next)) return false;
      current = next;
    } else {
      // Never create a parent at an out-of-bounds typed-array index: the
      // definition would be ignored and the fresh object would be orphaned.
      if (isUnwritableTypedArrayIndex(current, part)) return false;
      const created = {};
      defineOwnField(current, part, created);
      undo.push([current, part]);
      current = created;
    }
  }
  const leaf = segments[segments.length - 1];
  // The leaf is missing (the caller only runs when the full path is absent),
  // so on a typed array a canonical numeric leaf is always out of bounds and
  // the write would be silently dropped.
  if (isUnwritableTypedArrayIndex(current, leaf)) return false;
  defineOwnField(current, leaf, value);
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

// ── The clone graph: one model of what structuredClone serializes ─────────
//
// Three moments need to agree, exactly, on the graph a structuredClone
// produces from a value:
//   1. containsSharedMemory judges a fresh clone for retained shared bytes —
//      the shared independent-copy rule every saved value follows;
//   2. maskErrorStringSlots brackets one clone of the LIVE run input,
//      temporarily neutralizing form-written Error "message"/"name" slots so
//      the serializer's ABSTRACT string coercion can never throw on them;
//   3. copyInputWithFormDefaults walks the live graph and its clone in
//      lockstep and reattaches what the clone dropped or coerced away —
//      run-time form defaults.
//
// Those three used to carry separate container dispatch, separate Error
// recognition and separate reads of the non-enumerable cause, and the
// message/name rules were split further between a masking pass, a one-slot
// repair helper and the generic dropped-key walk. The classification and
// edge rules below are now that knowledge in a single place; the three call
// sites only consume it.
//
// Node kinds and the edges the clone actually recurses into:
//  - sharedArrayBuffer: the clone keeps sharing bytes — the one leaf that
//    fails the independent-copy rule;
//  - arrayBuffer, typedArray/dataView, host leaves (DOMException/Blob/File/
//    CryptoKey), Date/RegExp, boxed primitives: clone leaves — only internal
//    bytes/time/pattern/wrapped value is copied, every attached own property
//    is dropped unread (a byte view additionally exposes its true backing
//    buffer while probing for shared memory, since an own "buffer" property
//    can shadow the slot);
//  - array/object: enumerable own string-keyed property values;
//  - Map: every entry's key and value; Set: every member;
//  - native Error: ONLY the own "cause" edge — message/name/stack serialize
//    from their slots and every other own property is dropped.
// The host-leaf test must precede the Error classification: util.types
// brands DOMException as a native Error, but unlike a real Error it has no
// cloned cause. Brand checks (util.types) recognize cross-realm values and
// reject objects faking @@toStringTag; every read is guarded, so a revoked
// proxy or a throwing getter/iterator exposes no edge instead of crashing —
// structuredClone itself stays the authority that rejects the genuinely
// uncloneable value.
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
// value cannot be classified as an array here; the enumerable-key read is
// guarded too and structuredClone reports the unreadable value itself.
function isArrayGuarded(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isObjectValue(value) {
  return value !== null && typeof value === 'object';
}

function isObjectValueGuarded(value) {
  try {
    return isObjectValue(value);
  } catch {
    // Even `typeof` can throw for a revoked proxy; structuredClone rejects
    // such a value on its own in the caller.
    return false;
  }
}

// Enumerable own string keys, or null when the object cannot even be asked
// (a revoked proxy), exactly as structuredClone's own key read sees it.
function enumerableKeys(object) {
  try {
    return Object.keys(object);
  } catch {
    return null;
  }
}

function hasOwnGuarded(object, key) {
  try {
    return Object.hasOwn(object, key);
  } catch {
    return false;
  }
}

// Reads an own property defensively, returning [false] when the access throws
// (a revoked proxy or a throwing getter); structuredClone's own read remains
// the authority for whether the value is cloneable at all.
function readGuarded(object, key) {
  try {
    return [true, object[key]];
  } catch {
    return [false];
  }
}

// The two Error slots structuredClone serializes through ABSTRACT ToString,
// with the value the masking pass temporarily installs:
//  - "message": the clone installs the coerced text as its own non-enumerable
//    message, so masking it with "" leaves the same own-string slot shape,
//    which restoreFormErrorSlot then replaces with the true live value;
//  - "name": the coerced text only SELECTS the clone's constructor and is
//    never installed as an own property, so masking it with undefined makes
//    the clone omit it outright, letting the same reattachment rule restore
//    the live slot.
// Only an OBJECT-valued slot needs masking: ToString of a number/boolean/
// string cannot throw, and those values are repaired after the clone. An
// object carrying an own non-callable "toString" (an ordinary form-written
// string field, no different from any other key) is precisely what makes the
// coercion throw, taking the whole clone down with it.
const ERROR_STRING_SLOTS = [
  { name: 'message', mask: '' },
  { name: 'name', mask: undefined },
];

// An own data descriptor for `key`, or null when the slot is absent, is an
// accessor, or cannot be read (a revoked proxy).
function getOwnDataDescriptor(object, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return null;
  }
  if (!descriptor || !('value' in descriptor)) return null;
  return descriptor;
}

// The exact own-data shape defineOwnField gives a slot a successful form
// writes: an enumerable, writable, configurable data property. Nothing else
// on a run input can be a run-time form default — caller-attached slots have
// already been through the receiving clone (which coerced/dropped them) — so
// masking and repair act only on this shape.
function isFormWrittenDataSlot(descriptor) {
  return descriptor !== null
    && descriptor.enumerable && descriptor.writable && descriptor.configurable;
}

// Reads a native Error's own "cause" — the one edge structuredClone preserves
// even when non-enumerable. { present: false } means the clone has no cause
// edge here; an unreadable slot is treated as absent, mirroring the clone.
function readErrorCause(error) {
  let present;
  try {
    present = Object.hasOwn(error, 'cause');
  } catch {
    return { present: false };
  }
  if (!present) return { present: false };
  let value;
  try {
    value = error.cause;
  } catch {
    return { present: false };
  }
  return { present: true, value };
}

// Classifies one object node exactly as structuredClone serializes it. The
// branch order mirrors the serializer's own exclusions: shared bytes first,
// byte views, host leaves (DOMException before the Error brand), containers,
// native Errors, internal-value leaves, and ordinary objects last.
function classifyCloneNode(current) {
  if (nodeTypes.isSharedArrayBuffer(current)) return 'sharedArrayBuffer';
  if (nodeTypes.isArrayBuffer(current)) return 'arrayBuffer';
  if (nodeTypes.isTypedArray(current)) return 'typedArray';
  if (nodeTypes.isDataView(current)) return 'dataView';
  for (const constructor of HOST_LEAF_CONSTRUCTORS) {
    if (isInstanceOfGuarded(current, constructor)) return 'hostLeaf';
  }
  if (isArrayGuarded(current)) return 'array';
  if (nodeTypes.isMap(current)) return 'map';
  if (nodeTypes.isSet(current)) return 'set';
  if (nodeTypes.isNativeError(current)) return 'error';
  if (nodeTypes.isDate(current) || nodeTypes.isRegExp(current)
    || nodeTypes.isBoxedPrimitive(current)) {
    return 'valueLeaf';
  }
  return 'object';
}

// The object children the clone recurses into for a node of `kind` (the edges
// listed above), or null when the node carries none / cannot be read. With
// probe: true a byte view additionally yields its true internal backing
// buffer — the only way shared bytes hiding behind an own "buffer" property
// can be discovered — while the live-graph masking/pairing walks treat the
// view as the clone leaf it is.
function cloneChildValues(current, kind, { probe = false } = {}) {
  switch (kind) {
    case 'typedArray':
    case 'dataView': {
      if (!probe) return null;
      const getter = kind === 'typedArray'
        ? TYPED_ARRAY_BUFFER_GETTER : DATAVIEW_BUFFER_GETTER;
      let buffer = null;
      try {
        buffer = getter.call(current);
      } catch {
        buffer = null;
      }
      return buffer === null ? null : [buffer];
    }
    case 'array':
    case 'object': {
      const keys = enumerableKeys(current);
      if (keys === null) return null;
      const children = [];
      for (const key of keys) {
        const [exists, value] = readGuarded(current, key);
        if (exists) children.push(value);
      }
      return children;
    }
    case 'map': {
      const children = [];
      try {
        for (const [key, value] of current) {
          children.push(key, value);
        }
      } catch {
        // An unreadable iterator exposes nothing else to inspect.
      }
      return children;
    }
    case 'set': {
      const children = [];
      try {
        for (const member of current) children.push(member);
      } catch {
        // Ignore an unreadable iterator.
      }
      return children;
    }
    case 'error': {
      const cause = readErrorCause(current);
      return cause.present ? [cause.value] : null;
    }
    default:
      // sharedArrayBuffer / arrayBuffer / hostLeaf / valueLeaf
      return null;
  }
}

// Walks every object the clone would reach from `root`, identity-deduplicating
// repeated and circular references. probe: true judges shared bytes (a byte
// view's backing buffer is followed and onSharedMemory fires for a
// SharedArrayBuffer); otherwise the walk follows exactly the edges a live
// input clone recurses into. onNode receives the classified kind for the
// Error-slot masking pass. Returning true from either callback stops the walk.
function traverseCloneGraph(root, { probe = false, onNode = null, onSharedMemory = null } = {}) {
  if (!isObjectValueGuarded(root)) return false;
  const seen = new Set([root]);
  const stack = [root];
  const pushObject = child => {
    if (isObjectValueGuarded(child) && !seen.has(child)) {
      seen.add(child);
      stack.push(child);
    }
  };
  while (stack.length > 0) {
    const current = stack.pop();
    const kind = classifyCloneNode(current);
    if (kind === 'sharedArrayBuffer') {
      if (onSharedMemory !== null && onSharedMemory(current) === true) return true;
      continue;
    }
    if (onNode !== null && onNode(current, kind) === true) return true;
    const children = cloneChildValues(current, kind, { probe });
    if (children !== null) {
      for (const child of children) pushObject(child);
    }
  }
  return false;
}

// A structured clone of a SharedArrayBuffer — or of a typed array / DataView
// backed by one — succeeds, but the clone keeps sharing the underlying bytes
// with the object the operation implementation holds: mutating those bytes
// later would mutate the value the engine saved, breaking the promise that
// every saved output is an independent copy. Such a value therefore fails the
// independent-copy rule.
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
//   than "cause") are simply absent here and can never fail the check.
// The clone graph contains only genuine clone-produced objects — no getters,
// proxies or custom iterators — so the traversal never observes user code.
function containsSharedMemory(value) {
  return traverseCloneGraph(value, {
    probe: true,
    onSharedMemory: () => true,
  });
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
//    one Date (or one Error), both still point at the single repaired clone
//    node inside this copy (each invocation gets its own copy, so retries and
//    the live run input stay independent of one another);
//  - a reattached subtree is itself structured-cloned, so an action or
//    compensation editing a default, a created parent or the Date itself
//    cannot reach the run input, the caller's input or any other copy.
//
// Everything Error-specific about that repair lives in one place and is
// expressed through the same clone-graph model containsSharedMemory uses:
//
// 1. The cause edge. A native Error's own "cause" survives the clone (even
//    though non-enumerable; message/name/stack are copied as primitives and
//    every other own property is dropped), so the ordinary enumerable-key
//    pairing below never visits it. readErrorCause — the exact read the
//    shared-memory traversal uses — pairs the source and clone causes
//    explicitly, so a cause chain (Error -> cause -> Error -> cause -> Date)
//    is followed link by link exactly like any other path, and form defaults
//    a chain alone can reach are repaired there.
//
// 2. The "message"/"name" slots (ERROR_STRING_SLOTS). structuredClone
//    serializes both through ABSTRACT STRING COERCION of the live value:
//    - a live own message holding the object a form creates for a default at
//      failure.message.label (or the number/boolean a form writes directly at
//      failure.message) reaches the clone as the coerced text
//      "[object Object]"/"5"/"false", installed as a fresh own slot, so the
//      key walk above could neither reattach nor even see that the value was
//      lost;
//    - an own name is coerced only to SELECT the clone's constructor and is
//      never installed as an own property, so the clone simply omits it;
//    - the coercion can itself THROW: "toString" is an ordinary form data
//      field exactly like "label", and an own non-callable toString leaves
//      the object no conversion path, so the whole structuredClone dies with
//      "Cannot convert object to primitive value" before any operation or
//      compensation is entered.
//    maskErrorStringSlots neutralizes every form-shaped OBJECT-valued slot
//    for the duration of the one clone (message -> "", which the serializer
//    installs as the clone's own string slot; name -> undefined, which it
//    omits), and restoreFormErrorSlot then repairs BOTH slots by one rule —
//    replace what the clone coerced/dropped with an independent
//    structuredClone of the live value in the live slot's own enumerable data
//    shape. Such a subtree holds only form-created plain objects and
//    primitive defaults (an own non-callable "toString" being just one more
//    string field), so that clone always succeeds and fully detaches the
//    repaired slot from the live run input. The generic dropped-key walk does
//    not touch either slot: on an Error node the three special keys
//    ("cause", "message", "name") belong solely to the Error pass.
//
// What counts as "form-shaped" is the reception boundary. The receiving
// cloneRunInput already coerced or dropped every non-string slot the CALLER
// attached before the run (and did so non-enumerably), so within a run an own
// ENUMERABLE, writable, configurable message/name data slot can only be one a
// successful form just installed — isFormWrittenDataSlot is the single test
// both the masking pass and the repair pass use; caller-attached slots are
// never resurrected here.

// Restores one form-written Error string slot ("message" or "name") on a
// paired clone node. The clone never preserves such a slot verbatim: it
// coerced message to an own text slot (here the "" mask value) and never
// installs name at all, so every non-undefined live value except an ordinary
// string MESSAGE (which the clone already carries verbatim) is replaced with
// an independent deep copy, in the live slot's own enumerable data shape.
// defineProperty (never assignment) keeps an inherited accessor from
// intercepting the repair. Everything that is not a form-written slot — an
// absent/inherited/accessor slot, the prototype's "" message, the ordinary
// string message a caller or `new Error('boom')` supplied — is left exactly
// as the clone produced it.
function restoreFormErrorSlot(source, target, slot) {
  const descriptor = getOwnDataDescriptor(source, slot);
  if (!isFormWrittenDataSlot(descriptor)) return;
  const liveValue = descriptor.value;
  if (liveValue === undefined) return;
  if (slot === 'message' && typeof liveValue === 'string') return;
  Object.defineProperty(target, slot, {
    value: structuredClone(liveValue),
    writable: true, enumerable: true, configurable: true,
  });
}

// Repairs the Error-only parts of one paired [live node, clone node]: the two
// string slots and the non-enumerable cause edge. A cause the clone dropped
// (not expected for a genuine Error clone, which always carries it) is
// reattached in the non-enumerable shape a cloned cause has; otherwise the
// paired causes are pushed for the lockstep walk. Returns the [source,
// target] cause pair to enqueue when both are objects.
function pairErrorNode(source, target) {
  for (const slot of ERROR_STRING_SLOTS) {
    restoreFormErrorSlot(source, target, slot.name);
  }
  const cause = readErrorCause(source);
  if (!cause.present) return null;
  if (!hasOwnGuarded(target, 'cause')) {
    if (cause.value === undefined) return null;
    Object.defineProperty(target, 'cause', {
      value: structuredClone(cause.value),
      writable: true, enumerable: false, configurable: true,
    });
    return null;
  }
  const [, targetCause] = readGuarded(target, 'cause');
  if (isObjectValue(cause.value) && isObjectValue(targetCause)) {
    return [cause.value, targetCause];
  }
  return null;
}

// Temporarily replaces every form-shaped OBJECT-valued "message"/"name" slot
// on every Error the structured clone would otherwise serialize — reached
// through exactly the edges the clone recurses into (the shared traverseClone
// graph: enumerable own properties, Map keys/values, Set members and each
// Error's non-enumerable cause) — and returns a restore function that puts
// every original descriptor back verbatim. Only object slots are masked:
// ToString of a primitive cannot throw, and primitives are repaired after the
// clone; the object is the one whose own non-callable "toString" makes the
// serializer's coercion crash. Own properties of clone-special leaves and
// Errors' ordinary own properties are never serialized and need no mask. The
// whole mask/restore bracketing one clone is synchronous, so the live run
// input is never observed masked.
function maskErrorStringSlots(root) {
  const masks = [];
  traverseCloneGraph(root, {
    onNode: (error, kind) => {
      if (kind !== 'error') return;
      for (const { name, mask } of ERROR_STRING_SLOTS) {
        const descriptor = getOwnDataDescriptor(error, name);
        if (!isFormWrittenDataSlot(descriptor)) continue;
        const value = descriptor.value;
        if (value === null || typeof value !== 'object') continue;
        masks.push([error, name, descriptor]);
        Object.defineProperty(error, name, {
          value: mask, writable: true, enumerable: true, configurable: true,
        });
      }
    },
  });
  return () => {
    for (const [error, slot, descriptor] of masks) {
      Object.defineProperty(error, slot, descriptor);
    }
  };
}

function copyInputWithFormDefaults(input) {
  // Mask every form-written object message/name slot for the duration of this
  // one clone so the serializer never ABSTRACT-string-coerces one — coercion
  // that crashes when the object carries an own non-callable "toString". The
  // live slots are restored the instant the clone finishes (or throws); the
  // clone keeps the "" message mask (repaired below) or omits the masked name
  // (reattached by the same repair).
  const restoreSlots = maskErrorStringSlots(input);
  let clone;
  try {
    clone = structuredClone(input);
  } finally {
    restoreSlots();
  }

  const processed = new Set();
  // Pairs of [live node, its clone counterpart]. The lockstep walk follows
  // enumerable own properties — the same protocol forms and lookupOwn
  // navigate by — on plain objects, host objects and arrays alike, mirroring
  // the clone graph node for node; on an Error node the three special keys
  // (cause/message/name) are removed from the key walk and handled once by
  // pairErrorNode. (Form paths may not cross an array intermediate — such a
  // default is a type error — but descending into arrays anyway keeps the
  // pairing total and harmless.) The internal entries of Map/Set and the
  // slots of byte views are unreachable by own-property paths and need no
  // pairing; enumerable own props riding on such a clone-special node still
  // get reattached by the same key walk.
  const stack = [[input, clone]];
  const isTraversable = value => isObjectValue(value);
  while (stack.length > 0) {
    const [source, target] = stack.pop();
    if (processed.has(source)) continue;
    processed.add(source);
    if (!isObjectValue(source) || !isObjectValue(target)) continue;

    const kind = classifyCloneNode(source);
    if (kind === 'error') {
      const causePair = pairErrorNode(source, target);
      if (causePair !== null) stack.push(causePair);
    }

    let keys = enumerableKeys(source);
    if (keys === null) continue;
    if (kind === 'error') {
      keys = keys.filter(key => key !== 'cause' && key !== 'message' && key !== 'name');
    }
    for (const key of keys) {
      const [readOk, sourceValue] = readGuarded(source, key);
      if (!readOk) continue;
      if (!hasOwnGuarded(target, key)) {
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
      const [targetReadOk, targetValue] = readGuarded(target, key);
      if (!targetReadOk) continue;
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
// `formRules`, `conditionRules`, `actionBindings` and `dependencies` are the
// per-form compiled-rules map, the per-condition compiled-tree map, the
// per-action compiled-binding map and the per-node dependency map produced by
// the validation pass THIS run started through. They are captured here —
// before the first suspension point — as part of the run state, so a form,
// condition, business action or dependency gate that executes only after a
// business-operation wait keeps using exactly the rules, expression, action
// configuration and dependency relations that start-time validation
// accepted: the operation actually invoked, its attempt count and waits,
// whether a compensation runs under which name and retry settings, and which
// nodes a node must wait for — including a dependency on a node the run
// never activates, which still holds the gate until the run ends blocked. A
// later validateWorkflow or a new run over the same node objects builds its
// own maps and cannot reach these — even one that fails partway through,
// since a rejected pass never publishes its maps at all. The compiled form
// entries hold only primitives (field types restrict defaults to primitives)
// and freshly built segment arrays; the compiled condition trees hold only
// primitives, pre-resolved output-reference node ids and freshly built
// segment arrays; the compiled bindings hold only the operation name strings
// and fresh retry/compensation objects compileAction built; the dependency
// lists are fresh arrays of id strings normalizeDependencies built — so all
// four snapshots are already independent of the caller's definition. The
// branch destinations (then/else/next) are deliberately not snapshotted
// here: only the condition *expression*, the action configuration and the
// dependency relations are pinned to the run's start, matching the
// form-rules rule. What a run resolves through successorTargets is still
// always the product of a fully successful validation — a rejected
// validateWorkflow never publishes its edges there (see compileWorkflow) —
// so a failed edit cannot reroute a run already in flight.
function createRunState(nodes, workflow, input, formRules, conditionRules, actionBindings, dependencies) {
  const declarationOrder = [...nodes.values()];
  const declarationIndex = new Map(declarationOrder.map((node, index) => [node.id, index]));
  return {
    trace: [],
    actionAttempts: [],
    context: { input: cloneRunInput(input), output: {} },
    formRules,
    conditionRules,
    actionBindings,
    dependencies,
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
    && state.dependencies.get(node).every(dependency => state.completed.has(dependency)));
}

function blockedResult(state) {
  const waiting = state.declarationOrder.filter(node =>
    state.activated.has(node.id) && !state.completed.has(node.id));
  if (waiting.length === 0) return null;
  return waiting.map(node => ({
    nodeId: node.id,
    missingDependencies: state.dependencies.get(node)
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
    // Evaluate the whole condition tree this run captured from the validation
    // pass at its own start. A revalidation of the same definition while this
    // run is parked on a business operation compiles a fresh tree into a
    // different map and cannot reach this one, so changing the comparison
    // constant, an input field path or an action-output reference — including
    // inside nested all/any/not children — never changes the branch a waiting
    // run has not chosen yet. The tree is pinned, not its result: evaluation
    // still reads this run's current input and the successful action outputs
    // saved so far, compounds still short-circuit in this tree's order, and
    // an unconvertible numeric comparison is still invalid_condition at the
    // position this run's expression gives it.
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

function verifyOperations(nodes, operations, actionBindings) {
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
  const { nodes, formRules, conditionRules, actionBindings, dependencies } = compileWorkflow(workflow);
  // Business operations are asynchronous: the synchronous entry must refuse
  // a workflow that names any before a single node executes.
  for (const node of nodes.values()) {
    const binding = actionBindings.get(node);
    if (binding && binding.name !== null) {
      throw new Error(`action node ${node.id} names business operation "${binding.name}", which must run asynchronously; use executeWorkflowAsync instead of executeWorkflow`);
    }
  }

  const state = createRunState(nodes, workflow, input, formRules, conditionRules, actionBindings, dependencies);

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
  const { nodes, formRules, conditionRules, actionBindings, dependencies } = compileWorkflow(workflow);
  verifyOperations(nodes, operations, actionBindings);

  const state = createRunState(nodes, workflow, input, formRules, conditionRules, actionBindings, dependencies);

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
      // The binding this run captured at its own start: a revalidation of the
      // same node object while this run was parked compiled a fresh binding
      // into a different map and cannot reach this one, so the operation
      // invoked, the retry budget and the compensation configuration are
      // exactly the ones this run's start-time validation accepted.
      const binding = state.actionBindings.get(ready);
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
