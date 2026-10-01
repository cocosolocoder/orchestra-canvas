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

A workflow contains a unique `id`, an `entry` node id, and a list of nodes. This baseline supports `trigger`, `form`, `condition`, `action`, and `end` nodes. A condition selects its `then` or `else` destination using a simple comparison over the input payload; other nodes continue through `next`.

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

Workflow definition (`validateWorkflow`, also run at the start of execution) checks every form schema in the workflow and reports the offending node and field before execution. At runtime, only forms on the traversed path are validated, so a missing input in an untaken branch is not an error.
