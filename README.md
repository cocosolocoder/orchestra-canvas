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
