// Standalone, service-free demonstration of cancelling an asynchronous run
// while a business action that declares a compensation is still in flight.
// The cancellation never interrupts the running action: the engine awaits its
// successful return, saves it, runs the declared compensation, and only then
// returns a "cancelled" result.
//
// Run with Node 20 or newer:
//   node examples/cancel-in-flight.mjs

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
