#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { executeWorkflow, validateWorkflow } from './engine.js';

async function load(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const [command, path = 'examples/order-approval.json'] = process.argv.slice(2);
  const workflow = await load(path);
  if (command === 'validate') {
    const nodes = validateWorkflow(workflow);
    console.log(JSON.stringify({ valid: true, workflowId: workflow.id, nodeCount: nodes.size }, null, 2));
    return;
  }
  if (command === 'demo') {
    const execution = executeWorkflow(workflow, { request: { amount: 18000, department: 'Operations' } });
    console.log(JSON.stringify({ workflowId: workflow.id, ...execution }, null, 2));
    return;
  }
  throw new Error('usage: node src/cli.js <demo|validate> [workflow.json]');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
