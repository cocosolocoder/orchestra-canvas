const NODE_TYPES = new Set(['trigger', 'form', 'condition', 'action', 'end']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
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
    currentId = node.type === 'condition'
      ? (evaluateCondition(node.condition, context.input) ? node.then : node.else)
      : node.next;
  }
  throw new Error('workflow did not terminate; a cycle is present');
}
