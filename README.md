# Orchestra Canvas

Orchestra Canvas is a compact starting point for a business workflow automation product. The baseline provides a deterministic workflow definition, validation, conditional routing, and an executable command-line demo without external services.

## Requirements

- Node.js 20 or newer

## Run the product

```bash
npm run demo
npm run validate
```

The demo loads `examples/order-approval.json`, runs it with a sample purchase request, and prints each visited node plus the final workflow result.

## Test

```bash
npm test
```

## Workflow format

A workflow contains a unique `id`, an `entry` node id, and a list of nodes. This baseline supports `trigger`, `form`, `condition`, `action`, and `end` nodes. A condition evaluates a boolean condition tree over the input payload and selects its `then` or `else` destination from the root result; other nodes continue through `next`.

## Branching and dependencies

The `next` of a trigger, form, or action node may be a single node id or a non-empty, duplicate-free array of node ids; on success every listed successor is activated. Any node may also declare `dependsOn`, an array of node ids (absent means none). Dependencies only gate *when* a node runs — they never activate it. The entry node starts active; every other node becomes active once at least one actually traversed edge reaches it, and it executes once all of its dependencies have completed successfully. Each node executes at most once, and a condition's unchosen exit does not activate its target — though a shared successor can still be activated through another traversed edge.

Each step picks, in `nodes` declaration order, the next activated node whose dependencies are satisfied. Branches share the run's input and output, so defaults applied by a successful form are visible to later nodes. A failing form or condition still returns `invalid_input` / `invalid_condition` immediately with the preserved `context` and `trace` (including the failing node), the failed form's defaults rolled back, and no further nodes running.

Workflows that use array successors or declare dependencies must contain exactly one `end` node. Reaching `end` does not stop other activated branches; the run returns `completed` with that end's `result` only after every activated node has completed. If activated nodes are left waiting on dependencies that never complete, the run processes every other eligible branch first and then returns `status: "blocked"` with the preserved `context` and `trace` plus a `blockedNodes` array — one `{ nodeId, missingDependencies }` entry per waiting node, both listed in `nodes` declaration order. Waiting or never-activated nodes appear neither in the trace nor in the output.

Definition validation rejects empty successor arrays, duplicate or non-string successor/dependency ids, unknown targets, non-array `dependsOn`, self-dependencies, and dependencies on the entry node. Cycles formed by successor edges and dependency relations together are rejected as well — including untaken branches and entry-unreachable nodes — with an error naming the node id chain (first and last id identical) where each step is a real edge or dependency. All definition errors are reported before the first node executes, and neither the definition nor the caller's input is ever mutated.

## Conditions

Every condition is one of the following, and conditions may be nested freely (up to 32 levels, the root counting as level 1):

- Comparison — `{ "field": "<path>", "operator": "<op>", ... }`
- Conjunction — `{ "all": [condition, ...] }`, true when every child is true.
- Disjunction — `{ "any": [condition, ...] }`, true when at least one child is true.
- Negation — `{ "not": condition }`, the inverted result of its single child.

`all` and `any` must be non-empty arrays. A node uses exactly one of `all`, `any`, `not`, and a compound cannot also carry comparison keys. Children are evaluated in declaration order with short-circuiting: `all` stops at the first `false`, `any` at the first `true`, so skipped children are never read and cannot raise errors.

Comparison operators:

- `eq` — strict equality (`===`) against the comparison value; types are never coerced.
- `gte` / `lte` — numeric ordering. Values are converted with JavaScript numeric conversion (numeric strings, booleans and `null` convert, e.g. `"10"`, `true`, `null`), but **both** sides must convert to a finite number. Objects and arrays never convert, even though `Number([])` is `0`.
- `exists` — takes only `field` and `operator`; true when the field is present as an own property. `null`, `""`, `0`, and `false` all count as present.

A normal comparison names its right side with exactly one of:

- `value` — a string, finite number, boolean, or `null` constant, or
- `valueField` — a dot-separated path to another input field.

If either compared field is missing, an ordinary comparison is `false` (this does not apply to `exists`).

All field paths are dot-separated and read only own properties at each level; a non-object parent counts as missing. Empty paths, empty segments, and `__proto__` / `prototype` / `constructor` segments are forbidden.

The whole condition tree of every condition node is checked at definition time — including branches that execution would never take. Unknown operators, empty `all`/`any`, children that are not conditions, mixing multiple compound keys (or compound keys with comparison keys), illegal comparison values, and non-finite numeric constants are rejected with the node id and a child position such as `$.all[1].not`, before the workflow runs.

At execution time, a numeric comparison that is actually evaluated (i.e. not short-circuited away) against an object, an array, or a value that does not convert to a finite number stops the workflow with `status: "invalid_condition"`, reporting the node id, child position, and reason. The `context` and `trace` are preserved; the trace contains the failing condition node and no further nodes execute.

## Form input validation

A `form` node may carry a `schema` object with a `fields` array. Fields are processed in declaration order; a form without a schema passes input through unchanged. Each field declares:

- `path` — dot-separated path into the input (e.g. `request.amount`). Empty paths, empty segments, and `__proto__`/`prototype`/`constructor` segments are rejected, as are duplicate or parent/child-related paths.
- `type` — one of `string`, `number`, `integer`, `boolean`. Values are never coerced; numbers must be finite and `integer` must be a whole number.
- `required` — defaults to `false`. Only an absent own property counts as missing: `null`, `""`, `0`, and `false` are present values.
- `default` — applied to missing fields before required/constraint checks. Defaults may create missing parent objects, but an existing parent that is `null`, an array, or a non-object raises a type error. A default must match the field's own type and constraints.
- String constraints: `minLength` / `maxLength`, counted in Unicode code points, both non-negative integers with `minLength <= maxLength`.
- Numeric constraints: `min` / `max` (inclusive), finite numbers with `min <= max`. Constraints that do not apply to a field's type are rejected at definition time.

Missing fields take their defaults first; a missing non-required field without a default is allowed. Applied defaults are written to `context.input`, so later conditions can use them; the caller's input object is never mutated.

When validation fails, execution returns `status: "invalid_input"` with the preserved `context` and `trace` and an `errors` array. Errors are collected in field declaration order, one per field, in the priority `required` → `type` → `range`/`length`. Later nodes do not run, and every default the failed form applied is rolled back. Undeclared input fields are always retained.

Workflow definition (`validateWorkflow`, also run at the start of execution) checks every form schema and every condition tree in the workflow — including branches that will not be traversed — and reports the offending node, field, and condition position before execution. At runtime, only forms on the traversed path are validated, so a missing input in an untaken branch is not an error.

## Business actions

An `action` node either keeps its legacy behavior (`message`, defaulting to `action:<nodeId>`) or performs a real business operation. Name the operation on the node and supply implementations by name when running:

```json
{
  "id": "charge-card",
  "type": "action",
  "operation": "charge",
  "retry": { "attempts": 3, "initialDelayMs": 100, "backoffFactor": 2, "maxDelayMs": 1000 },
  "next": "receipt"
}
```

```js
import { executeWorkflowAsync } from './src/engine.js';

const result = await executeWorkflowAsync(workflow, input, {
  charge: async (input, output, nodeId, attempt) => { ... },
});
```

`executeWorkflowAsync(workflow, input?, operations?)` is the asynchronous entry point. Legacy message actions, forms, conditions, branching, dependencies and join semantics work exactly as in `executeWorkflow`; that synchronous entry, `validateWorkflow`, and the command-line demo continue to work unchanged. If a validated workflow names any business operation, `executeWorkflow` rejects before the first node executes, naming the node and explaining that the workflow must run through `executeWorkflowAsync`.

An implementation is called as `operation(input, output, nodeId, attempt)`:

- `input` — an independent structured clone of the run's current input.
- `output` — an independent structured clone of every earlier successful node output.
- `nodeId` — the running node's id; `attempt` starts at `1`.
- it may return a value or a Promise; the resolved value is structured-cloned and stored as that node's output, so later mutation of an object the implementation keeps cannot touch the run.

Mutations made to the copies during a failed attempt never reach later attempts or the run context. A thrown exception, a rejected Promise, or a return value that cannot be structured-cloned all count as a failed attempt. The original caller input, the workflow definition, and other runs are never mutated.

Retry configuration (`retry`) is either omitted — exactly one attempt — or present with all four fields:

- `attempts` — integer from `1` to `10`.
- `initialDelayMs` / `maxDelayMs` — integers from `0` to `60000` milliseconds; `maxDelayMs` must not be smaller than `initialDelayMs`.
- `backoffFactor` — a finite number from `1` to `4`.

The first retry waits `initialDelayMs`; each later wait grows by `backoffFactor` and is capped at `maxDelayMs` (a zero initial delay always stays zero). No wait happens after the final attempt.

Before the run starts — covering untaken branches and entry-unreachable nodes — every action's operation name and retry config is validated (a name must be a non-blank string, and all parameter rules above apply), and every named operation must exist in `operations` as a function. Any violation throws with the node id and reason without invoking an operation even once.

Nodes still execute one at a time in declaration order: while an action waits or retries, no other node is scheduled. Successors activate and dependencies satisfy only after the action succeeds, and a shared join still runs exactly once. When retries are exhausted the run immediately returns:

```json
{
  "status": "action_failed",
  "nodeId": "charge-card",
  "attempts": 3,
  "error": "last failure message",
  "context": { "input": {}, "output": {} },
  "trace": [ ... ],
  "actionAttempts": [ ... ]
}
```

Earlier input and successful outputs are preserved, the failed node has no output, no later node runs, and reaching an `end` node earlier does not make the run `completed`. Every result from `executeWorkflowAsync` also carries `actionAttempts`: records in invocation order, each `{ nodeId, attempt, ok, error, nextDelayMs }`, where `nextDelayMs` is the wait before the next attempt or `0` when none follows. The regular `trace` still lists each actually executed node exactly once. Form failures (`invalid_input`), condition failures (`invalid_condition`) and dependency blocking (`blocked`) keep their existing result shapes.

## Compensation

A business action may declare a `compensation` operation that undoes its effect after the run fails:

```json
{
  "id": "charge-card",
  "type": "action",
  "operation": "charge",
  "compensation": {
    "operation": "refund",
    "retry": { "attempts": 3, "initialDelayMs": 100, "backoffFactor": 2, "maxDelayMs": 1000 }
  },
  "next": "receipt"
}
```

Compensation implementations come from the same `operations` name mapping passed to `executeWorkflowAsync`; the name may be any registered function, including the same name as the business operation. `retry` is optional — without it the compensation is attempted exactly once — and, when present, must carry all four fields with the same parameter ranges and delay/backoff rules as business action retries.

When a run ends through exhausted business-action retries (`action_failed`), a form validation failure (`invalid_input`), a condition evaluation failure (`invalid_condition`), or unmet dependencies (`blocked`), no further normal nodes execute and the engine compensates the run's successful business actions: each action that **succeeded** and declares a compensation is invoked once, in the reverse of the order actions actually succeeded, and the engine waits for each compensation to finish before starting the next. Failed attempts, legacy message actions, and branches never taken are not compensated; an action that only succeeded after retries and a shared join node are each scheduled exactly once. Reaching `end` before another branch fails does not prevent compensation, while a `completed` run never invokes compensation.

A compensation implementation is called as `compensation(input, output, result, nodeId, attempt)`:

- `input` — an independent structured clone of the run input as it was when the original action succeeded (including defaults earlier forms had applied).
- `output` — an independent structured clone of every earlier successful node output as of that moment; the action's own output key is not included.
- `result` — an independent structured clone of the value the original action returned.
- `nodeId` — the original node's id; `attempt` starts at `1` for each node's compensation.
- it may return a value or a Promise; the resolved value is structured-cloned and recorded, so later mutation of an object the implementation keeps cannot change the record.

A thrown exception, a rejected Promise, or a return value that cannot be structured-cloned all fail the attempt. Every argument is a fresh copy: compensation mutations cannot affect the original run records (successful outputs are never deleted or overwritten), later attempts, or other runs, and later form defaults never leak into the captured snapshots. Each compensation uses its own retry count and backoff settings; after its retries are exhausted the engine still compensates every earlier action. Neither a failed compensation nor the original business operation is ever invoked again.

Every `executeWorkflowAsync` result also carries:

- `compensationStatus` — `not_needed` when no successful action required compensation (including all `completed` runs), `completed` when every compensation succeeded, or `failed` when at least one compensation ultimately failed.
- `compensationAttempts` — records in actual invocation order, each `{ nodeId, operation, attempt, ok, error, nextDelayMs, result }`, where `result` is the cloned success return value and `error` / `nextDelayMs` follow the same conventions as `actionAttempts`.

The original terminal status, failure details, `context`, regular `trace`, and `actionAttempts` are preserved unchanged; compensation records never appear in the normal node trace.

`validateWorkflow` rejects a `compensation` that is not an object, compensation declared on anything but a business action (including legacy message actions), a missing, non-string or blank operation name, and an illegal compensation retry block. Before the first node executes, `executeWorkflowAsync` additionally confirms that every declared compensation name — including actions on untaken branches and entry-unreachable nodes — has a function implementation. Any configuration problem throws naming the node and reason without invoking a single operation. The synchronous `executeWorkflow` and the command-line demo keep their existing behavior; workflows without compensation follow the previous execution rules exactly.


