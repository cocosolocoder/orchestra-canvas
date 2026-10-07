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

### Successors are published only by a validation that passes the whole definition

A node's outgoing connections — a trigger's, form's or action's `next` (a single id or a successor array, replacing the array or splicing/pushing its entries in place) and a condition node's `then` and `else` exits alike — are read at the moment that node actually completes (for a condition, the moment its expression is evaluated), from the relations the most recent `validateWorkflow` (or execution-entry validation pass) accepted. A fully successful validation therefore keeps updating successors even for a run already under way: editing a node's `next`, or a condition's `then`/`else`, while an asynchronous run is parked on a pending business operation and revalidating successfully lets that node, once it completes, take the newly accepted connection, and a new run started from the edited definition adopts it as well.

A validation that is **rejected**, however, publishes no successor relation at all, and neither does an edit that is never validated. The successor checks run node by node and cycle detection runs only after every node has been examined, so the pass normalizes a changed `next`, `then` or `else` before it can later fail — on a node checked afterwards, on a cycle found only at the end, or on an untaken branch or an entry-unreachable node. None of that partial work reaches a run: until an entire pass succeeds, the previously accepted relations stay exactly as they were. Concretely, suppose a condition enters "处理订单" when it holds and "人工复核" when it does not. While an earlier business action has not returned yet, changing the true branch to the also-existing "发送通知" and failing validation because another node points at a nonexistent target leaves the parked run on the original edges: after the wait the condition, when it holds, still enters "处理订单" and finishes normally, with the trace and `context.output` recording only the route actually taken — whether or not the caller ever restores the unaccepted edits, and even if the connections were edited without any `validateWorkflow` call at all. The rule is the same for the false branch — `else` is protected exactly like `then`, never only one of the two.

The two exits of a condition are always accepted **together, as one pair by the same successful validation**: an error on any other node, or one the cycle check discovers only at the end, can never admit a `then`/`else` the pass checked earlier into an existing run. Only a later **successful** validation publishes; a new run started while the definition is still invalid is rejected before any node or operation executes. The standalone validation error is reported only to that `validateWorkflow` caller: it is never converted into the running execution's `action_failed`, it neither consumes retry attempts nor adds an attempt record, and it triggers no compensation of actions that already succeeded. After the user repairs the definition and a whole validation passes, a condition the run has not evaluated yet selects its target with the last successfully accepted `then`/`else`, and subsequent new runs use the current legal definition. The existing scheduling rules are unchanged — each condition evaluation activates only the selected exit (the unchosen target never executes), branches still fan out as declared, a shared successor still runs exactly once, and an end node still waits for the other activated branches — and the other start-time snapshots (form rules, condition expressions, action/business and compensation bindings, dependency relations) keep their per-run isolation; a message action's `message` and an end node's `result` are still read and copied at their own actual execution moment.


The completed `result` is an independent deep copy of the end node's configured `result`, taken at the moment that end node actually executes — every nested object and array is copied, not just the outermost value. The recorded value is the one read and structured-cloned **at that execution moment**: only content whose clone is independently produced from that actual read is ever recorded as a success. Editing fields, adding or deleting nested properties, or changing array contents (including the bytes of a returned plain `ArrayBuffer` or typed view) on the returned result never touches the workflow definition, other completed runs, or a result an earlier end node recorded while another activated branch is still waiting; re-running the same definition always yields the configured content. An unset or `null` result returns `null`, while strings, numbers and booleans (including `0`, `false` and `""`) pass through unchanged.

### End results that cannot be independently copied

The returned result is promised to be an independent copy. A `SharedArrayBuffer` cannot satisfy that promise: structured cloning it (or a typed array / `DataView` backed by one) "succeeds", but the clone keeps **sharing the underlying bytes** with the result embedded in the workflow definition — bytes the caller rewrites on the returned result would silently change the definition and every later run, breaking the independent-copy contract. A result that cannot be structured-cloned at all (a bare function, a function nested in an object or array, or an accessor that throws) cannot be delivered either. The independent-copy guarantee is therefore enforced at two moments:

- **Definition validation.** `validateWorkflow` throws; `executeWorkflow` throws the same error and `executeWorkflowAsync` returns a Promise rejected with it — never an `action_failed` or compensation result. The error names the end node id and explains the reason — the result contains shared memory (`SharedArrayBuffer`, or a typed array/`DataView` backed by one) and independent copies cannot be guaranteed, or the result must be structured-cloneable. The check covers every end node in the definition — including end nodes on untaken branches and nodes the entry cannot reach — and is reported before the first node, business operation or compensation executes, and before any trace or attempt record is produced.
- **End node execution.** Validation only proves the result was safe *as it was then*. An enumerable value property can return ordinary data during validation and shared memory (or a function) when the end node later runs, and a preceding business operation — or work on another activated branch — can replace a result's plain buffer with a shared one before the end executes. So a successful result is recorded **only if the value actually read at that end node's execution moment clones to an independent copy**: that single execution-time read is cloned and the clone is checked for retained shared memory. If it cannot be cloned, or its clone retains shared memory, `executeWorkflow` throws and `executeWorkflowAsync` rejects the returned Promise with an error naming that end node — the run does **not** return `completed`, this is not treated as a business-action failure (it neither consumes action retry attempts nor records a failed attempt), and no compensation runs. (When the end node reached on one activated branch records a legal result while another branch still has work to do, that recorded result stays as recorded and remains isolated; it is only returned once the run otherwise completes normally.)

At both moments the judgment targets exactly the content the structured clone actually **retains**: the result is cloned first and the clone is traversed, so an enumerable accessor is read only by the clone's own single read. The execution-time check adds no second read of the original value, so it cannot change an accessor's return order — the clone's read is the only execution-time read, and the value that read produced is both what is judged and what is saved; this also means a legal result whose accessor returns a different *ordinary* value at execution time records that fresh value rather than a stale validation-time one. A custom `Map`/`Set` `Symbol.iterator` neither hides the container's real members nor fabricates shared ones. A `SharedArrayBuffer` supplied directly; a typed array or `DataView` whose backing buffer is one; shared memory held by an own enumerable property of a plain object, class instance or array (including an enumerable non-index array property); used as a `Map` key or value or as a `Set` member; or carried in an `Error`'s `cause` (even when non-enumerable) — nested, cyclic or repeatedly referenced — all reject the result. Shared memory placed only where cloning drops it — an own property of a `Date` or `RegExp` (including a subclass), a non-enumerable or symbol-keyed property of an object or array (including a non-enumerable array index, which clones as a hole), an own property of a plain `ArrayBuffer`/`SharedArrayBuffer` or a byte view, a boxed primitive or host leaf, or an `Error` own property other than `cause` — is discarded with that property and never causes a rejection, including when it only appears there at execution time.

A result that cannot be structured-cloned reports the structured-cloneability error, which takes precedence when a result carries both that and shared memory — at validation and at execution alike. The same error covers a value whose properties cannot actually be read (an accessor that throws, or a revoked proxy) when that only becomes observable at the end node's execution moment. A plain `ArrayBuffer` and views over one remain legal results — copied byte-for-byte at the end node's execution moment with the cloned type, byte content and circular/repeated references preserved — and modifying the returned bytes never reaches the definition or another run. Unset/`null` results still return `null`; `0`, `false` and `""` keep their exact values; result recording timing, branch waiting and completion conditions are unchanged.

Definition validation rejects empty successor arrays, duplicate or non-string successor/dependency ids, unknown targets, non-array `dependsOn`, self-dependencies, and dependencies on the entry node. Cycles formed by successor edges and dependency relations together are rejected as well — including untaken branches and entry-unreachable nodes — with an error naming the node id chain (first and last id identical) where each step is a real edge or dependency. An end `result` that cannot be structured-cloned — an object or array containing a function, or a bare function result — is also rejected with the end node id and reason, and so is a result whose clone retains shared memory (a `SharedArrayBuffer`, or a typed array/`DataView` backed by one, anywhere in the content the clone actually saves), for every end node including those on untaken branches and entry-unreachable ones. All definition errors are reported before the first node executes, and neither the definition nor the caller's input is ever mutated.

## Conditions

Every condition is one of the following, and conditions may be nested freely (up to 32 levels, the root counting as level 1):

- Comparison — `{ "field": "<path>", "operator": "<op>", ... }`
- Conjunction — `{ "all": [condition, ...] }`, true when every child is true.
- Disjunction — `{ "any": [condition, ...] }`, true when at least one child is true.
- Negation — `{ "not": condition }`, the inverted result of its single child.

`all` and `any` must be non-empty arrays, and every array slot must hold an actual child condition — an array with length but no elements (all holes, e.g. `new Array(2)`), or a gap left between or after valid children (such as after deleting an entry through the JavaScript API), is rejected. A hole is never treated as `false`, ignored, or filled in. An explicitly supplied non-condition value (`undefined`, `null`, numbers, etc.) is handled by the ordinary invalid-child rule instead. A node uses exactly one of `all`, `any`, `not`, and a compound cannot also carry comparison keys. Children are evaluated in declaration order with short-circuiting: `all` stops at the first `false`, `any` at the first `true`, so skipped children are never read and cannot raise errors.

Comparison operators:

- `eq` — strict equality (`===`) against the comparison value; types are never coerced.
- `gte` / `lte` — numeric ordering. Values are converted with JavaScript numeric conversion (numeric strings, booleans and `null` convert, e.g. `"10"`, `true`, `null`), but **both** sides must convert to a finite number. Objects and arrays never convert, even though `Number([])` is `0`.
- `exists` — takes only the left side (`field` or `outputField`) and `operator`; true when the left side is present as an own property. `null`, `""`, `0`, `false`, and `undefined` all count as present.

A comparison names its left side with exactly one of:

- `field` — a dot-separated path into the run input, or
- `outputField` — a reference to a successful action's output (see below).

A normal comparison names its right side with exactly one of:

- `value` — a string, finite number, boolean, or `null` constant,
- `valueField` — a dot-separated path to another input field, or
- `valueOutputField` — a reference to a successful action's output.

If either side is missing, an ordinary comparison is `false` (this does not apply to `exists`).

All input field paths are dot-separated and read only own properties at each level; a non-object parent counts as missing. Empty paths, empty segments, and `__proto__` / `prototype` / `constructor` segments are forbidden.

### Output references

An output reference reads the value a successful action node stored in the run's output. It is a non-array object:

```json
{ "nodeId": "risk-check", "path": "risk.score" }
```

- `nodeId` is matched as a whole string (dots are literal characters, not path separators) and must name an `action` node in this workflow definition. The segment restrictions below apply only to paths, not to node ids: an action may be named `__proto__` or `constructor`, and its result is saved and read under that exact name.
- `path` is optional; when omitted the reference reads the action's entire return value. When present it follows the same segment rules as input paths (non-empty, no empty segments, no `__proto__` / `prototype` / `constructor`).

At execution time a reference reads only outputs saved by actions that succeeded in this run — failed attempts and compensation returns are never read. An action that has not run, was never activated, or sits on an untaken branch is simply missing; a reference never activates an action, never waits for a future result, and adds no dependency. A path walks own properties level by level; encountering an array or a non-object parent value counts as missing, as does a missing property. A successfully saved `null`, `""`, `0`, `false`, or `undefined` is still present. The synchronous entry can reference message action outputs the same way.

The whole condition tree of every condition node is checked at definition time — including branches that execution would never take. Unknown operators, empty `all`/`any`, missing child conditions (array holes, including arrays that have length but no elements at all), children that are not conditions, mixing multiple compound keys (or compound keys with comparison keys), illegal comparison values, non-finite numeric constants, malformed output references, references to missing or non-action nodes, and source conflicts (both `field` and `outputField`, or more than one right-side source) are rejected with the node id and a child position such as `$.all[1]` or `$.any[1].not` — the position keeps every `all`/`any`/`not` level from the root and the index matches the slot in the original array — before the workflow runs. The check never depends on which branch execution would select: a hole following children that would already decide the compound's result, or one sitting in an untaken or entry-unreachable condition, still rejects the definition. `validateWorkflow` throws; the synchronous entry throws before any node executes; the asynchronous entry rejects the returned Promise — in no case does a business action run first, and the failure is never reported as `invalid_condition` or `action_failed`, nor is compensation triggered.

At execution time, a numeric comparison that is actually evaluated (i.e. not short-circuited away) against an object, an array, or a value that does not convert to a finite number stops the workflow with `status: "invalid_condition"`, reporting the node id, child position, and reason. The `context` and `trace` are preserved; the trace contains the failing condition node and no further nodes execute. Earlier successful business actions are compensated under the usual rules.

Each execution fixes the whole condition tree of every condition node at its own start. The expression a run evaluates is exactly the tree the validation pass at that run's start accepted — the nested `all`/`any`/`not` structure, the child order, every comparison operator, and the data source on each side (input field paths, comparison constants and action-output references). Once the run is under way — for example while an asynchronous run is parked on a pending business operation — editing the same condition node and independently re-validating it (whether that validation succeeds or later fails on another node), or starting another run from the changed definition, never reaches a condition the earlier run has not evaluated yet: changing a comparison constant, an input field path or an action-output reference, anywhere in the tree, never reroutes it. Two runs sharing the condition node each keep their own tree regardless of which run finishes first, and editing the node without revalidating changes nothing for an existing run. New executions still validate the current definition, so an illegal edited condition fails before any node of that new run executes. Pinning the tree does not pin its result: when the condition actually runs it still reads that run's current input and the successful action outputs saved so far — a preceding form's defaults and a business operation's just-returned data both participate — compounds still short-circuit in the order that run adopted, and an evaluated numeric comparison that cannot convert to a finite number is still `invalid_condition` at the node and child position of that run's own expression, with `context` and `trace` preserved and earlier successful business actions compensated as usual. Each evaluation still activates only the selected exit; the unchosen target never runs, and the existing dependency and completion rules are otherwise unchanged. This snapshot covers only the condition expression together with the form rules; it does **not** pin branch destinations. `then`/`else` follow the same rule as every ordinary `next` connection — they are read at the condition's own evaluation moment from the pair the most recent validation that passed the **whole** definition accepted, so a rejected or never-invoked validation can never reroute a run that has not evaluated the condition yet (both exits are accepted together; see "Successors are published only by a validation that passes the whole definition"). Dependency scheduling, the synchronous entry and the form-rule snapshot keep their existing behavior, while a message action's `message` and an end node's `result` are still read and copied at their own actual execution moment.

### End-to-end example: branch on an action output with an explicit dependency

Reading an action output with `outputField` does **not** wait for that action and does not activate it (see "Output references" above). To make a condition decide *after* a business action has succeeded and saved its output, activate the action on the real path **and** name it in the condition's `dependsOn`. The script below is complete and runnable.

A trigger activates two nodes at once: a business action `score-action` that returns a score, and a condition `score-gate` that reads that score. The condition is declared **before** the action in `nodes`, but it declares `dependsOn: ["score-action"]`, so it cannot run until that action has completed successfully. A score at or above the input's `threshold` takes the `then` branch; a lower score takes `else`; both branches arrive at the same `end` node.

```js
import { executeWorkflowAsync } from './src/engine.js';

const workflow = {
  id: 'score-routing',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'trigger', next: ['score-gate', 'score-action'] },
    {
      id: 'score-gate',
      type: 'condition',
      dependsOn: ['score-action'],
      condition: {
        outputField: { nodeId: 'score-action', path: 'score' },
        operator: 'gte',
        valueField: 'threshold',
      },
      then: 'approved',
      else: 'rejected',
    },
    { id: 'score-action', type: 'action', operation: 'score', next: 'finish' },
    { id: 'approved', type: 'action', message: 'approved', next: 'finish' },
    { id: 'rejected', type: 'action', message: 'rejected', next: 'finish' },
    { id: 'finish', type: 'end', result: 'finished' },
  ],
};

// Registered under the operation name the action node uses. When the action
// succeeds, its resolved return value is cloned into the run output under the
// node id; the input is read but never modified.
const operations = {
  async score(input) {
    const a = input.application;
    const score = 60 + Math.min(a.years * 4, 24) - Math.min(a.incidents * 12, 36);
    return { score };
  },
};

const atThreshold = { threshold: 80, application: { years: 5, incidents: 0 } };
const belowThreshold = { threshold: 80, application: { years: 2, incidents: 1 } };

console.log(await executeWorkflowAsync(workflow, atThreshold, operations));
console.log(await executeWorkflowAsync(workflow, belowThreshold, operations));
```

Save it as `score-routing.mjs` in the project root and run it with Node 20:

```bash
node score-routing.mjs
```

**Input `atThreshold`** yields a score of `80`, equal to the threshold. `gte` is inclusive, so equality takes the `then` branch:

```json
{
  "status": "completed",
  "result": "finished",
  "context": {
    "input": { "threshold": 80, "application": { "years": 5, "incidents": 0 } },
    "output": { "score-action": { "score": 80 }, "approved": "approved" }
  },
  "trace": [
    { "nodeId": "start", "type": "trigger" },
    { "nodeId": "score-action", "type": "action" },
    { "nodeId": "score-gate", "type": "condition" },
    { "nodeId": "approved", "type": "action" },
    { "nodeId": "finish", "type": "end" }
  ]
}
```

**Input `belowThreshold`** yields a score of `56`, below the threshold, so the run takes `else`:

```json
{
  "status": "completed",
  "result": "finished",
  "context": {
    "input": { "threshold": 80, "application": { "years": 2, "incidents": 1 } },
    "output": { "score-action": { "score": 56 }, "rejected": "rejected" }
  },
  "trace": [
    { "nodeId": "start", "type": "trigger" },
    { "nodeId": "score-action", "type": "action" },
    { "nodeId": "score-gate", "type": "condition" },
    { "nodeId": "rejected", "type": "action" },
    { "nodeId": "finish", "type": "end" }
  ]
}
```

The node order shows what the dependency guarantees: although `score-gate` is declared first and is activated together with the action, it runs only after `score-action` has succeeded and its return value has been saved to the run output. The condition then reads `score-action.score` from that output, compares it with the input's `threshold`, and activates exactly one exit. The unchosen branch never executes — only `approved` appears in the first output and trace, only `rejected` in the second — even though both lead to the shared `finish` node. (Every `executeWorkflowAsync` result also carries the `actionAttempts`, `compensationStatus`, and `compensationAttempts` fields described in earlier sections.)

The action's return value is stored under `context.output["score-action"]`; it is **not** written back to the input. `context.input` stays exactly `{ threshold, application }` with no `score` field. Conditions that need the score read it through an output reference; conditions that need a request value keep using an input path such as `threshold`.

#### If you remove the dependency

Deleting `dependsOn` from `score-gate` does not make the output reference wait. Both nodes are still activated by the trigger, and scheduling then follows `nodes` declaration order, so the condition runs first — before the action has run. Re-running the **same `atThreshold` input that passes above** now produces:

```json
{
  "status": "completed",
  "result": "finished",
  "context": {
    "input": { "threshold": 80, "application": { "years": 5, "incidents": 0 } },
    "output": { "score-action": { "score": 80 }, "rejected": "rejected" }
  },
  "trace": [
    { "nodeId": "start", "type": "trigger" },
    { "nodeId": "score-gate", "type": "condition" },
    { "nodeId": "score-action", "type": "action" },
    { "nodeId": "rejected", "type": "action" },
    { "nodeId": "finish", "type": "end" }
  ]
}
```

The run now takes `else` even though the score is exactly the threshold. When `score-gate` evaluates, `score-action` has not run, so its output is simply **missing**, and an ordinary comparison with a missing side is `false`. The reference neither waits for the action nor activates it (the action runs here only because the trigger's array successor activated it independently), and the condition is **not** re-evaluated when the action succeeds immediately afterward and saves `score: 80` — the saved score and the `rejected` message coexist in the output, recording the branch that was actually chosen while the score was still absent. Which branch is taken therefore depends on the declared dependency, never on operation timing; do not try to establish ordering by making an operation take longer.

#### When the depended-on action is never activated: `blocked`

A dependency only gates *when an already-activated node may run*; it cannot activate the node it names. In this workflow the entry never reaches `score-action` — no actually traversed edge points to it — while `score-gate` is activated and declares a dependency on it:

```js
const blockedWorkflow = {
  id: 'score-blocked',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'trigger', next: 'prepare' },
    { id: 'prepare', type: 'action', message: 'application logged', next: 'score-gate' },
    {
      id: 'score-gate',
      type: 'condition',
      dependsOn: ['score-action'],
      condition: {
        outputField: { nodeId: 'score-action', path: 'score' },
        operator: 'gte',
        valueField: 'threshold',
      },
      then: 'approved',
      else: 'rejected',
    },
    { id: 'score-action', type: 'action', operation: 'score', next: 'finish' },
    { id: 'approved', type: 'action', message: 'approved', next: 'finish' },
    { id: 'rejected', type: 'action', message: 'rejected', next: 'finish' },
    { id: 'finish', type: 'end', result: 'finished' },
  ],
};

const blocked = await executeWorkflowAsync(
  blockedWorkflow,
  { threshold: 80, application: { years: 5, incidents: 0 } },
  operations,
);
```

The run executes every node that can run (`start`, then `prepare`) and then returns `blocked`; the condition waits for an action that nothing ever activates:

```json
{
  "status": "blocked",
  "context": {
    "input": { "threshold": 80, "application": { "years": 5, "incidents": 0 } },
    "output": { "prepare": "application logged" }
  },
  "trace": [
    { "nodeId": "start", "type": "trigger" },
    { "nodeId": "prepare", "type": "action" }
  ],
  "blockedNodes": [
    { "nodeId": "score-gate", "missingDependencies": ["score-action"] }
  ]
}
```

Records produced before the wait are preserved (`prepare` stays in the trace and its message stays in the output), and `blockedNodes` names the waiting condition together with the dependency that never completed. The waiting `score-gate` has no trace entry of its own and has produced no branch result — neither `approved` nor `rejected` runs, and `finish` is never reached. The `score` operation is still registered and validated before the run starts, but because no traversed edge activates `score-action`, that action never executes; the dependency cannot make it run.

## Form input validation

A `form` node may carry a `schema` object with a `fields` array. Fields are processed in declaration order; a form without a schema passes input through unchanged. Each field declares:

- `path` — dot-separated path into the input (e.g. `request.amount`). Empty paths, empty segments, and `__proto__`/`prototype`/`constructor` segments are rejected, as are duplicate or parent/child-related paths.
- `type` — one of `string`, `number`, `integer`, `boolean`. Values are never coerced; numbers must be finite and `integer` must be a whole number.
- `required` — defaults to `false`. Only an absent own property counts as missing: `null`, `""`, `0`, and `false` are present values.
- `default` — applied to missing fields before required/constraint checks. Defaults may create missing parent objects, but an existing parent that is `null`, an array, or a non-object raises a type error. A default must match the field's own type and constraints.
- String constraints: `minLength` / `maxLength`, counted in Unicode code points, both non-negative integers with `minLength <= maxLength`.
- Numeric constraints: `min` / `max` (inclusive), finite numbers with `min <= max`. Constraints that do not apply to a field's type are rejected at definition time.

Missing fields take their defaults first; a missing non-required field without a default is allowed. Applied defaults are written to `context.input`, so later conditions can use them; the caller's input object is never mutated.

Only own properties count as filled; a name inherited from the prototype never substitutes for a missing field — a required field without a default still fails even when, for example, a `Map` answers that name through its prototype (`Map.prototype.size`). When a default applies at such a name it is installed as the value's own property, shadowing the inherited member rather than assigning through it: a `Map` field `size` with an integer default of `7` reads `7` as an own property while the `Map` keeps its type and original entries (its prototype member count never stands in for the field, and no read-only or getter-only prototype property — such as `Map`/`Set`'s `size` or a typed array's `length` — can make the default throw). A default path that would pass through a missing own parent creates that parent even when the prototype answers the same name, rather than descending into the inherited value (`request.options.size.label` with no own `size` on a populated `Map` creates the own parent instead of walking into the prototype's number). These own-property defaults reach conditions, business-action copies and compensation snapshots just like defaults on any other value, with the same independent-copy isolation and failed-form rollback.

A default whose path runs through a structured value — for example `request.createdAt.channel` when `request.createdAt` is a `Date` — attaches the new fields to that value itself. Such defaults are applied consistently everywhere within one run: the business action receives them on its independent input copy, the compensation input keeps exactly the defaults effective before that action succeeded, and the run result carries them, while the value keeps its original type and time (a `Date` stays a `Date` with the same timestamp). Multi-level paths creating several missing parents at once are attached as a whole. When two input fields point at one `Date`, they still point at the single copied `Date` inside each independent copy. As with every other attempt copy, editing the attached defaults, the created parents or the `Date` itself inside an action or compensation cannot reach the run input, the caller's input or the next attempt. Own properties the caller attached to such a value before the run keep their existing reception behavior — they are dropped with the receiving structured clone — and defaults on ordinary plain objects are unchanged.

An `Error`'s `message` gets the same treatment even though a structured clone serializes that slot as a string. A caller can pass a raw `Error` whose `message` is not an own property at reception (`new Error()` carries the empty-string message on the prototype); a successful form may then create a message object — a string default at `failure.message.label`, with further fields and multi-level parents beneath it — or write a default directly at `failure.message`. In the live input, and in the independent copy handed to a business attempt or stored at the action's success moment for compensation, that message keeps the form-written type, structure and value: an object stays an object with `label` readable along the same path and every created parent intact, a number or boolean default stays that number or boolean (never the text `"5"`/`"false"`), and a string default stays a string. The value itself remains an `Error` (its `name`, `stack` and `cause` unchanged), other inputs are retained, and aliases that pointed at the same `Error` still resolve to one `Error` with one repaired message inside each copy. An action or compensation editing the message, one of its fields or a created parent affects only its own argument; the run input, the caller's `Error` and a later retry's fresh parameter are untouched, and a failed retry's next parameter carries the form-written value without the prior attempt's changes. `failure.message.toString` is an ordinary data field exactly like `failure.message.label` — a string default written there is kept as that string on every copy, never forbidden or renamed; because an own non-callable `toString` makes the object fail the serializer's implicit string coercion, those slots are kept out of the coercion while each independent copy is built and then restored whole (the same covers a form-written object `name` slot and such `Error`s reached through a `cause` chain, a `Map`/`Set` or an alias). If `failure.message` is already a string once the input is received, a default beneath it (`failure.message.label`, and likewise `failure.message.toString`) is still rejected as `invalid_input` with that field recorded as a `type` error — the string is never replaced by an object — and the failed form's other defaults roll back under the usual rules. A non-string `message` the caller itself attached before the run keeps the ordinary reception behavior: one that coerces is stringified by the receiving structured clone and not reconstructed, and one that cannot even be coerced fails that receiving clone with the raw `TypeError` as before.

When validation fails, execution returns `status: "invalid_input"` with the preserved `context` and `trace` and an `errors` array. Errors are collected in field declaration order, one per field, in the priority `required` → `type` → `range`/`length`. Later nodes do not run, and every default the failed form applied is rolled back. Undeclared input fields are always retained.

Workflow definition (`validateWorkflow`, also run at the start of execution) checks every form schema and every condition tree in the workflow — including branches that will not be traversed — and reports the offending node, field, and condition position before execution. At runtime, only forms on the traversed path are validated, so a missing input in an untaken branch is not an error.

Each execution fixes the form rules at its own start. The field lists, constraints and defaults a run validates its forms against are exactly the ones the validation pass at that run's start accepted; once the run is under way — for example while an asynchronous run is parked on a pending business operation — editing the same form node's schema and independently re-validating it (whether that validation succeeds or later fails on another node), or starting a new run from the changed definition, never reaches forms the earlier run has not executed yet. They keep using the original rules: a value that passed at start still passes, and a missing field still receives the start-time default, while later runs and standalone validation use the new definition. Field errors are still returned in the field declaration order that run adopted, and the usual stop-on-failure, default rollback and compensation behavior is unchanged. This snapshot covers form rules and condition expressions (see "Conditions"); a message action's `message` and an end node's `result` are still read, copied and checked at their own actual execution moment.

## Business actions

An `action` node either keeps its legacy behavior (`message`, defaulting to `action:<nodeId>`) or performs a real business operation. A legacy message may be a string or any structured value — objects, arrays and structured-cloneable built-ins are all accepted; a message whose structured clone retains shared memory is rejected at definition time (see "Legacy messages containing shared memory" below). The saved output is an independent deep copy of the message, taken at the moment that action actually executes (both through `executeWorkflow` and `executeWorkflowAsync`): editing nested fields, adding or deleting properties, or changing array members on a returned run's output never touches the workflow definition, other runs, or an output the action recorded while another activated branch is still waiting, and later conditions and business actions keep reading the value as it was when the action ran. An unset, `undefined` or `null` message defaults to `action:<nodeId>`, while `""`, `0` and `false` are kept verbatim. Name the operation on the node and supply implementations by name when running:

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

`executeWorkflowAsync(workflow, input?, operations?, options?)` is the asynchronous entry point. Legacy message actions, forms, conditions, branching, dependencies and join semantics work exactly as in `executeWorkflow`; that synchronous entry, `validateWorkflow`, and the command-line demo continue to work unchanged. If a validated workflow names any business operation, `executeWorkflow` rejects before the first node executes, naming the node and explaining that the workflow must run through `executeWorkflowAsync`.

An implementation is called as `operation(input, output, nodeId, attempt)`:

- `input` — an independent structured clone of the run's current input.
- `output` — an independent structured clone of every earlier successful node output.
- `nodeId` — the running node's id; `attempt` starts at `1`.
- it may return a value or a Promise; the resolved value is structured-cloned and stored as that node's output, so later mutation of an object the implementation keeps cannot touch the run. A return value that contains shared memory is not supported (see below) and fails the attempt.

Mutations made to the copies during a failed attempt never reach later attempts or the run context. A thrown exception, a rejected Promise, a return value that cannot be structured-cloned, or a return value containing shared memory all count as a failed attempt. The original caller input, the workflow definition, and other runs are never mutated.

### Return values containing shared memory

Every saved output is promised to be an independent copy. A `SharedArrayBuffer` cannot satisfy that promise: structured cloning it (or a typed array / `DataView` backed by it) "succeeds", but the clone keeps **sharing the underlying bytes** with the object the implementation holds — bytes the implementation rewrites later would silently change the already saved node output. Such a return value is therefore explicitly unsupported and fails the attempt, regardless of whether it is returned synchronously or through a Promise.

The judgment is made on the cloned value itself — exactly the content that will be saved. Each enumerable getter is therefore read only by the clone's own single read (a getter that answers differently across reads is judged, and saved, by the value the clone actually got), and a `Map`/`Set` is judged by its real members, which the clone reads directly from the container: a custom `Symbol.iterator` that yields nothing or throws cannot hide shared members, and one that fabricates shared memory cannot condemn ordinary members. The attempt fails whenever the shared memory sits in content the structured clone actually **saves**:

- a `SharedArrayBuffer` returned directly;
- a typed array (`Int8Array` … `BigUint64Array`, including `Uint8Array`) or a `DataView` whose buffer is a `SharedArrayBuffer`;
- shared memory held by an own enumerable property of a plain object, a class instance or an array — including an enumerable non-index property of an array;
- a `SharedArrayBuffer` (or a view over one) used as a `Map` key or value, or as a `Set` member;
- shared memory carried in an `Error`'s `cause` (even when `cause` is non-enumerable).

Properties that structured cloning discards are not part of the saved value and never make an attempt fail. In particular a `Date` or `RegExp` (including a subclass) clones only its internal time/pattern, and an array clones only its enumerable indices and enumerable non-index properties — so a `SharedArrayBuffer` attached as an own property of a returned date or regular expression, or stored in a non-enumerable property (including a non-enumerable index) of a returned array, is dropped with that property while the date, regular expression or array itself is saved normally and succeeds on the first attempt. The same applies to own properties on a `SharedArrayBuffer`/plain `ArrayBuffer` or a byte view, boxed primitives, `Blob`/`File`, `DOMException`, symbol-keyed properties anywhere, non-enumerable properties of plain objects, and own `Error` properties other than `cause`. The output preserves the cloned type and content (dates and regular expressions are never turned into strings), simply without those auxiliary properties; circular and repeated references in the saved graph are preserved as usual.

The failure follows the node's existing retry configuration: it uses the same attempt count, delays and backoff as a thrown exception, and every failed attempt is recorded in `actionAttempts` with an error stating that the return value contains shared memory and that isolation cannot be guaranteed. If a later attempt returns an ordinary cloneable value, the action succeeds normally and its output comes solely from that successful return. Once the attempts are exhausted the run ends `action_failed` exactly as for any other failure — prior input, successful outputs, the trace and attempt records are preserved, the failed node stores no output, no successor runs, and earlier successful actions that declared a compensation are compensated under the usual rules.

Ordinary values are unaffected: a plain `ArrayBuffer` and views over one are copied byte-for-byte and accepted, as are `Date`, `RegExp`, `Map`, `Set`, plain objects, arrays and primitives. Circular references, repeated references and in-container object relationships in legal return values are preserved; results merely containing byte arrays are not rejected. Operation call signatures and the shape of attempt/result records are unchanged.

### Run inputs containing shared memory

The run input is received — structured-cloned once — before any node executes, and every node, every business-attempt argument copy and every compensation snapshot is promised an independent copy of it. A `SharedArrayBuffer` cannot satisfy that promise: structured-cloning it (or a typed array / `DataView` backed by one) keeps sharing the underlying bytes with the object the caller holds, so a business action that rewrites the input copy it receives could mutate the caller's data, and a failed attempt's rewrite would be read again by the next attempt.

An input whose clone actually retains shared memory is therefore rejected at reception, before any node runs:

- `executeWorkflow` throws a `TypeError`; `executeWorkflowAsync` returns a Promise rejected with the same `TypeError`. The message states that the run input contains shared memory (`SharedArrayBuffer`, or a typed array/`DataView` backed by one) and that independent copies cannot be guaranteed.
- This is an input-reception failure, not a run failure: the call never returns `action_failed`, produces no node trace and no attempt records, and invokes no business operation and no compensation.

The existing checks keep their order and precedence: the workflow definition, the cancellation options and the business/compensation operation registrations are all validated first. Only once they pass is the input received, so the same rejection still applies to a request whose `AbortSignal` was already aborted at start; a legal input under such a signal keeps returning the ordinary `cancelled` result with an independent copy of that input.

As with operation return values, the judgment targets exactly the content the input clone retains. Shared memory supplied directly; held in an own enumerable property of a plain object, a class instance or an array (including an enumerable non-index array property); used as a `Map` key or value or as a `Set` member; or carried in an `Error`'s `cause` (even when non-enumerable) — with containers nested, cyclic or repeatedly referenced — all reject. Shared memory placed only where cloning drops it — an own property of a `Date` or `RegExp` (including a subclass), a non-enumerable or symbol-keyed property of an object or array, an own property of a plain `ArrayBuffer` or a byte view, a boxed primitive/host leaf, or an `Error` own property other than `cause` — is discarded with that property and never condemns otherwise-legal data. An enumerable getter is read only by the clone's own single read and is judged by that value; a custom `Map`/`Set` iterator neither hides the container's real members nor fabricates shared ones.

A plain `ArrayBuffer` and views over one remain valid input: they are copied byte-for-byte, the cloned type and byte content are preserved, and circular and repeated references survive. Rewrites a business action makes to its own copy stay within that attempt — the caller's input, the run context and later attempts each keep their original content. Form defaults, condition evaluation and business return values keep their existing rules.

### Legacy messages containing shared memory

A legacy message action saves an independent deep copy of its configured `message`, and the workflow definition itself must remain untouched by anything the action output later goes through. A `SharedArrayBuffer` cannot satisfy that promise: structured cloning it (or a typed array / `DataView` backed by one) "succeeds", but the clone keeps **sharing the underlying bytes** with the definition's message — rewriting the bytes on the saved action output would silently rewrite the message embedded in the workflow definition, breaking the independent-copy contract for every later run. Such a message is therefore a **definition error**, rejected exactly like a message that cannot be cloned at all:

- `validateWorkflow` throws; `executeWorkflow` throws the same error and `executeWorkflowAsync` returns a Promise rejected with it. The error names the action node id and explains that the message contains shared memory (`SharedArrayBuffer`, or a typed array/`DataView` backed by one) and that independent copies cannot be guaranteed.
- The check covers every legacy message action in the definition — including actions on untaken branches and nodes the entry cannot reach — and is reported before the first node executes: the call never returns `action_failed`, produces no node trace and no attempt records, and invokes no business operation and no compensation.

As with run inputs and operation return values, the judgment targets exactly the content the structured clone actually **retains**: the message is cloned first and the clone is traversed, so an enumerable getter is read only by the clone's own single read, and a custom `Map`/`Set` `Symbol.iterator` neither hides the container's real members nor fabricates shared ones. A `SharedArrayBuffer` supplied directly, held by an own enumerable property of a plain object, class instance or array (including an enumerable non-index array property), used as a `Map` key or value or as a `Set` member, or carried in an `Error`'s `cause` (even when non-enumerable) — nested, cyclic or repeatedly referenced — all reject the workflow. Shared memory placed only where cloning drops it — an own property of a `Date` or `RegExp` (including a subclass), a non-enumerable or symbol-keyed property of an object or array, an own property of a plain `ArrayBuffer` or a byte view, a boxed primitive, or an `Error` own property other than `cause` — is discarded with that property while the message stays legal.

The existing rules are otherwise unchanged: a bare function or a function nested in an object/array message is still rejected with the structured-cloneability error first; an action that names an `operation` ignores its `message`, so an unused shared-memory message never fails it; an unset, `undefined` or `null` message still defaults to `action:<nodeId>`, and `""`, `0` and `false` are kept verbatim. A plain `ArrayBuffer` and views over one remain legal messages — copied byte-for-byte at the action's execution moment with type, byte content and circular/repeated references preserved, never touching the definition or the caller's input, and never entering business-attempt or compensation records.

Retry configuration (`retry`) is either omitted — exactly one attempt — or present with all four fields:

- `attempts` — integer from `1` to `10`.
- `initialDelayMs` / `maxDelayMs` — integers from `0` to `60000` milliseconds; `maxDelayMs` must not be smaller than `initialDelayMs`.
- `backoffFactor` — a finite number from `1` to `4`.

The first retry waits `initialDelayMs`; each later wait grows by `backoffFactor` and is capped at `maxDelayMs` (a zero initial delay always stays zero). No wait happens after the final attempt.

Before the run starts — covering untaken branches and entry-unreachable nodes — every action's operation name and retry config is validated (a name must be a non-blank string, and all parameter rules above apply), and every named operation must exist in `operations` as a function. A legacy message action's `message` must also be structured-cloneable: a bare function or an object or array containing a function is rejected with the action node id and reason, and so is a message whose clone retains shared memory (a `SharedArrayBuffer`, or a typed array/`DataView` backed by one, anywhere in the content the clone actually saves), for every legacy message action including those on untaken branches and entry-unreachable ones. An action that names an operation ignores its `message`, so an unused uncloneable or shared-memory message is never rejected for it. Any violation throws with the node id and reason without invoking an operation even once.

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
- it may return a value or a Promise; the resolved value is structured-cloned and recorded, so later mutation of an object the implementation keeps cannot change the record. As with business operations, a return value carrying shared memory in content the clone actually saves (a `SharedArrayBuffer`, or a typed array/`DataView` backed by one, in a saved property, `Map` entry, `Set` member or `Error` `cause`) is unsupported and fails the attempt; shared memory placed only in properties structured cloning discards — such as an own property of a returned `Date`/`RegExp` or a non-enumerable property of a returned array — is dropped with that property and the compensation succeeds normally.

A thrown exception, a rejected Promise, a return value that cannot be structured-cloned, or a return value containing shared memory all fail the attempt. Every argument is a fresh copy: compensation mutations cannot affect the original run records (successful outputs are never deleted or overwritten), later attempts, or other runs, and later form defaults never leak into the captured snapshots. A failed shared-memory return is never recorded as a `result`. Each compensation uses its own retry count and backoff settings; after its retries are exhausted the engine still compensates every earlier action. Neither a failed compensation nor the original business operation is ever invoked again; the run keeps its original terminal status and failure reason, with `compensationStatus: "failed"` reported in the usual way.

Every `executeWorkflowAsync` result also carries:

- `compensationStatus` — `not_needed` when no successful action required compensation (including all `completed` runs), `completed` when every compensation succeeded, or `failed` when at least one compensation ultimately failed.
- `compensationAttempts` — records in actual invocation order, each `{ nodeId, operation, attempt, ok, error, nextDelayMs, result }`, where `result` is the cloned success return value and `error` / `nextDelayMs` follow the same conventions as `actionAttempts`.

The original terminal status, failure details, `context`, regular `trace`, and `actionAttempts` are preserved unchanged; compensation records never appear in the normal node trace.

`validateWorkflow` rejects a `compensation` that is not an object, compensation declared on anything but a business action (including legacy message actions), a missing, non-string or blank operation name, and an illegal compensation retry block. Before the first node executes, `executeWorkflowAsync` additionally confirms that every declared compensation name — including actions on untaken branches and entry-unreachable nodes — has a function implementation. Any configuration problem throws naming the node and reason without invoking a single operation. The synchronous `executeWorkflow` and the command-line demo keep their existing behavior; workflows without compensation follow the previous execution rules exactly.

Each execution fixes every action's compensation configuration — whether the action compensates at all, the compensation operation name, and the retry attempts/delays/backoff — at that run's own start, as part of the same start-time snapshot that pins the business binding, form rules, condition expressions and dependency relations. Editing the workflow definition once the run is under way — for example while an asynchronous run is parked on a pending business operation, even the action that later succeeds, or on an earlier operation while a not-yet-executed action's compensation is renamed or its retry numbers rewritten — and independently re-validating the edited definition never reaches that run: when a later business action fails and exhausts its attempts, the parked run invokes the compensation name its start-time validation accepted, with exactly that retry budget and wait schedule, regardless of what the definition now says. A compensation that fails then succeeds keeps one record per actual invocation — the original node id, continuous 1-based attempt numbers and each attempt's `ok`/`error`/`nextDelayMs`/`result` — the run still returns its original `action_failed` terminal status and reports `compensationStatus: "completed"`; the renamed operation never enters that run's records, and a saved successful output is never overwritten or deleted by a compensation. Two runs sharing one edited action each keep their own start-time configuration regardless of which finishes first, and a new run started after the edit uses the current, newly validated configuration, so the two runs' actual invocations and records reflect their respective rules. An action that declared no compensation at a run's start is never compensated in that run even if one is added mid-run and revalidated; an action that declared one is still compensated even if the configuration is deleted and revalidated mid-run. If the edited definition becomes invalid, validation keeps reporting the node and reason, a new run from that definition is rejected before any business operation or compensation runs, while the already-started legal run still ends under its original configuration. Pinning the configuration does not pin its arguments: the compensation's input, earlier-output and result snapshots are still the independent copies captured at that action's own success moment, a definition edit is never treated as a new business failure, and the existing relations among the terminal failure status, the compensation status and the attempt records are unchanged.

## Cancellation

An asynchronous run can be cancelled through an `AbortSignal` passed as the optional fourth argument:

```js
const controller = new AbortController();
const run = executeWorkflowAsync(workflow, input, operations, { signal: controller.signal });
controller.abort(); // at any later moment
const result = await run;
```

Omitting the options argument, passing `undefined`, or passing an object without a `signal` keeps the existing behavior; anything else — a non-object options value, or a `signal` that is not an `AbortSignal` — throws before any node executes. The signal only affects the run it was passed to; other runs of the same workflow are untouched.

Once the signal fires, no new regular node executes and no new business-action attempt starts — not even with a zero retry delay. The run eventually returns:

```json
{
  "status": "cancelled",
  "context": { "input": {}, "output": {} },
  "trace": [ ... ],
  "actionAttempts": [ ... ],
  "compensationStatus": "completed",
  "compensationAttempts": [ ... ]
}
```

The result carries the `context`, `trace`, `actionAttempts`, `compensationStatus` and `compensationAttempts` as they stand at that moment, and never a success `result`. In detail:

- **Already aborted at start** — the definition and the business/compensation operation registration checks still run first and report problems as usual; the run input is then received (so shared memory is rejected with the usual `TypeError` even though the signal has already fired). If those checks pass with a legal input, the run returns `cancelled` with an empty trace and empty attempt records, an independent copy of the input, and `compensationStatus: "not_needed"`, without invoking any business or compensation operation.
- **During a retry wait** — the wait ends immediately and no further attempt is made. The failed attempt's record keeps its error, and its `nextDelayMs` becomes `0`.
- **While an operation is in flight** — the running call is awaited, never interrupted, and its arguments are unchanged. A success (with a supported, structured-cloneable value) stores the output, records the success and is scheduled for compensation; a throw, rejection, uncloneable return or shared-memory return keeps the failure record, stores no output and is not retried. If the signal had fired before that outcome was processed, the run ends `cancelled` — even when the failure was the last allowed attempt.
- **Compensation after cancellation** follows the usual rules: successful actions that declared a compensation are undone in reverse success order with their success-moment snapshots and compensation retry configs, a failed compensation never stops earlier ones, and the result returns only after all of them finish. Further cancellation during compensation neither interrupts it nor causes duplicate calls, and successful outputs are never deleted. With nothing to compensate, `compensationStatus` is `not_needed`.
- A run that already visited `end` but still has unfinished activated branches can still be cancelled. A cancellation that arrives only after the terminal state was determined — including while a failure's compensation is still running — never rewrites that result.

### End-to-end example: cancel while a compensable business action is still running

Cancellation is **cooperative, not an interrupt**. The snippet below makes a business action that declares a compensation start and stay pending; the caller cancels at that exact point; the action then finishes successfully with a structured result. The engine does not kill the call — it waits for it to finish, saves the success, skips every not-yet-run node, runs the declared compensation, and returns only after all of that. The whole example is self-contained and uses locally simulated timing (no external services); it is also saved as `examples/cancel-in-flight.mjs`.

The workflow is a straight line: `start` (trigger) → `prepare` (legacy message action) → `reserve` (business operation `reserveStock`, declaring compensation `releaseStock`) → `notify` (legacy message action) → `done` (end). The complete script is at `examples/cancel-in-flight.mjs`; the code is reproduced below (minus that file's leading comment banner), and the relative import reflects its location:

```js
import { executeWorkflowAsync } from '../src/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const startedAt = Date.now();
const log = event => console.log(
  `${String(Date.now() - startedAt).padStart(3)} ms  ${event}`,
);

// start -> prepare (message) -> reserve (business, compensable)
//        -> notify (message) -> done (end)
const workflow = {
  id: 'cancellable-order',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'trigger', next: 'prepare' },
    { id: 'prepare', type: 'action', message: 'stock request logged', next: 'reserve' },
    {
      id: 'reserve',
      type: 'action',
      operation: 'reserveStock',
      compensation: { operation: 'releaseStock' },
      next: 'notify',
    },
    { id: 'notify', type: 'action', message: 'reservation confirmed', next: 'done' },
    { id: 'done', type: 'end', result: 'order-finished' },
  ],
};

const input = { orderId: 'ord-77', sku: 'WIDGET-2', quantity: 3 };

const controller = new AbortController();
controller.signal.addEventListener('abort', () => {
  log('cancel request arrived (AbortController.abort() fired)');
});

// Captured from inside the compensation so we can inspect its arguments after
// the run. The run itself never exposes these snapshots anywhere else.
let compensationReceived = null;

const operations = {
  // A locally simulated slow business action: it is still pending when the
  // caller cancels, then finishes successfully with a structured result.
  async reserveStock(runInput, _output, nodeId, attempt) {
    log(`business action "${nodeId}" started (attempt ${attempt})`);
    setTimeout(() => controller.abort(), 15); // cancel while still in flight
    await sleep(60);
    const value = {
      reserved: true,
      reservationId: 'res-1001',
      orderId: runInput.orderId,
      items: [{ sku: runInput.sku, quantity: runInput.quantity }],
    };
    log(`business action "${nodeId}" returned a successful result`);
    return value;
  },

  // The compensation declared by "reserve". Called only after the run has
  // stopped scheduling normal nodes, and awaited before the run returns.
  async releaseStock(input, earlierOutput, result, nodeId, attempt) {
    log(`compensation for "${nodeId}" (operation "releaseStock") started, attempt ${attempt}`);
    compensationReceived = {
      input: structuredClone(input),
      earlierOutput: structuredClone(earlierOutput),
      result: structuredClone(result),
      nodeId,
      attempt,
    };
    // Every argument is an independent copy: these writes cannot reach the
    // run's saved output, the input, or any later invocation.
    input.tamperedByCompensation = true;
    result.reserved = false;
    await sleep(10);
    log('compensation "releaseStock" finished');
    return { released: true, reservationId: result.reservationId };
  },
};

const run = executeWorkflowAsync(workflow, input, operations, {
  signal: controller.signal,
});
const execution = await run;
log('workflow returned to the caller');

console.log('\n--- arguments the compensation received ---');
console.log(JSON.stringify(compensationReceived, null, 2));

console.log('\n--- workflow result ---');
console.log(JSON.stringify(execution, null, 2));
console.log(`top-level "result" field present: ${'result' in execution}`);
console.log(`"notify" ran (present in output): ${Object.hasOwn(execution.context.output, 'notify')}`);
```

Run it from the project root:

```bash
node examples/cancel-in-flight.mjs
```

The event log shows the ordering that matters (the millisecond numbers come from one real machine and will vary; the sequence is deterministic):

```text
  2 ms  business action "reserve" started (attempt 1)
 18 ms  cancel request arrived (AbortController.abort() fired)
 62 ms  business action "reserve" returned a successful result
 63 ms  compensation for "reserve" (operation "releaseStock") started, attempt 1
 73 ms  compensation "releaseStock" finished
 74 ms  workflow returned to the caller
```

The cancellation lands at 18 ms while `reserve` is still awaiting — but nothing returns at that moment. The business action runs to its successful return at 62 ms; only then does the engine record the success, stop scheduling further normal nodes, and start the compensation. The run resolves to the caller at 74 ms, after the compensation finishes. The caller cannot get a `cancelled` answer "instantly" while an action or a compensation is still running.

This is the returned result of that run:

```json
{
  "status": "cancelled",
  "context": {
    "input": { "orderId": "ord-77", "sku": "WIDGET-2", "quantity": 3 },
    "output": {
      "prepare": "stock request logged",
      "reserve": {
        "reserved": true,
        "reservationId": "res-1001",
        "orderId": "ord-77",
        "items": [{ "sku": "WIDGET-2", "quantity": 3 }]
      }
    }
  },
  "trace": [
    { "nodeId": "start", "type": "trigger" },
    { "nodeId": "prepare", "type": "action" },
    { "nodeId": "reserve", "type": "action" }
  ],
  "actionAttempts": [
    { "nodeId": "reserve", "attempt": 1, "ok": true, "error": null, "nextDelayMs": 0 }
  ],
  "compensationStatus": "completed",
  "compensationAttempts": [
    {
      "nodeId": "reserve",
      "operation": "releaseStock",
      "attempt": 1,
      "ok": true,
      "error": null,
      "nextDelayMs": 0,
      "result": { "released": true, "reservationId": "res-1001" }
    }
  ]
}
```

Reading the fields:

- **`status: "cancelled"`** and there is **no top-level `result`** (`'result' in execution` is `false`). A cancelled run never reports the end node's result, even though the in-flight action succeeded.
- **`context.output` keeps the successful business action's return value.** `reserve` holds the structured result exactly as returned (independently cloned), and the earlier `prepare` message is preserved too. Compensation undoes the *effect*; it does not delete the saved output. The writes the compensation makes to its own copies (`tamperedByCompensation`, `reserved = false`) never appear here.
- **`actionAttempts` records the call as a success**: `{ nodeId: "reserve", attempt: 1, ok: true, error: null, nextDelayMs: 0 }`. The action that was in flight when cancellation arrived is not marked failed or retried.
- **`trace` contains only nodes that actually executed**: `start`, `prepare`, `reserve`. The successor `notify` and the end node `done` never ran — neither appears in the trace, and there is no `notify` key in `context.output`.
- **`compensationStatus: "completed"`** because the one compensable success was undone successfully. The record in `compensationAttempts` carries `nodeId: "reserve"` — the **original business node**, not a new node id — together with the compensation's own operation name (`releaseStock`) and its cloned return value. Compensation calls never appear in the regular `trace`.

The compensation's five arguments, captured during the run, are:

```json
{
  "input": { "orderId": "ord-77", "sku": "WIDGET-2", "quantity": 3 },
  "earlierOutput": { "prepare": "stock request logged" },
  "result": {
    "reserved": true,
    "reservationId": "res-1001",
    "orderId": "ord-77",
    "items": [{ "sku": "WIDGET-2", "quantity": 3 }]
  },
  "nodeId": "reserve",
  "attempt": 1
}
```

- `input` is an independent copy of the run input as it was **when the original action succeeded** (forms before that action would have already applied their defaults; forms after it would not be visible).
- `earlierOutput` is an independent copy of every earlier successful node output as of that moment — the action's **own** output key is deliberately excluded, so only `prepare` is present.
- `result` is an independent copy of the value `reserveStock` returned.
- `nodeId` points back at the original action node (`reserve`), and compensation `attempt` starts at `1` for each node.

### Boundary: the awaited action fails after cancellation

If the action that is still in flight when cancellation arrives ultimately **throws** (or returns an uncloneable/shared-memory value), the run still ends `cancelled` — the late failure is neither promoted to `action_failed` nor retried. Keeping the workflow and cancellation call above but giving `reserve` three allowed attempts and replacing its implementation with one that fails after the abort:

```js
// On the "reserve" node:
//   retry: { attempts: 3, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 }
reserveStock: async () => {
  setTimeout(() => controller.abort(), 10);
  await sleep(40);
  throw new Error('warehouse rejected the reservation');
},
```

The single failed attempt is kept and the run closes immediately:

```json
{
  "status": "cancelled",
  "context": {
    "input": { "orderId": "ord-77", "sku": "WIDGET-2", "quantity": 3 },
    "output": { "prepare": "stock request logged" }
  },
  "trace": [
    { "nodeId": "start", "type": "trigger" },
    { "nodeId": "prepare", "type": "action" },
    { "nodeId": "reserve", "type": "action" }
  ],
  "actionAttempts": [
    { "nodeId": "reserve", "attempt": 1, "ok": false, "error": "warehouse rejected the reservation", "nextDelayMs": 0 }
  ],
  "compensationStatus": "not_needed",
  "compensationAttempts": []
}
```

Despite `attempts: 3`, the operation is invoked exactly once: no retry starts after cancellation (`nextDelayMs` is `0` and no wait runs). No output is saved for `reserve` — its key never appears (the earlier `prepare` output is simply preserved as-is), and `notify` and `done` never run. Because the action never succeeded, `releaseStock` is never invoked — there is nothing to compensate, hence `compensationStatus: "not_needed"` and an empty `compensationAttempts`. A failure in this position changes only the attempt record; the terminal status remains the cancellation's.

The synchronous `executeWorkflow`, the command-line demo and uncancelled runs behave exactly as before.


