import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWorkflow, validateWorkflow } from '../src/engine.js';

const workflow = {
  id: 'routing',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'trigger', next: 'check' },
    { id: 'check', type: 'condition', condition: { field: 'score', operator: 'gte', value: 80 }, then: 'pass', else: 'fail' },
    { id: 'pass', type: 'end', result: 'passed' },
    { id: 'fail', type: 'end', result: 'failed' }
  ]
};

test('routes a workflow through the matching branch', () => {
  assert.equal(executeWorkflow(workflow, { score: 90 }).result, 'passed');
  assert.equal(executeWorkflow(workflow, { score: 60 }).result, 'failed');
});

test('rejects unknown destinations', () => {
  const broken = structuredClone(workflow);
  broken.nodes[0].next = 'missing';
  assert.throws(() => validateWorkflow(broken), /unknown destination/);
});

test('detects a reachable cycle', () => {
  const cyclic = {
    id: 'cycle', entry: 'a', nodes: [
      { id: 'a', type: 'trigger', next: 'b' },
      { id: 'b', type: 'action', next: 'a' }
    ]
  };
  assert.throws(() => executeWorkflow(cyclic), /cycle is present/);
});
