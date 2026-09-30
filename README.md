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
