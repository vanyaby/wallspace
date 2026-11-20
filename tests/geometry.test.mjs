import assert from 'node:assert/strict';
import { test } from 'node:test';
import { project, at, rayToPanel } from '../geometry.mjs';

const panel = {origin: [0, 2, -2], right: [1, 0, 0], down: [0, -1, 0], normal: [0, 0, 1], width: 2, height: 1};

test('converts between normalized board and world coordinates', () => {
  assert.deepEqual(project(panel, [0.5, 1.25, -1.97]).slice(0, 2), [0.25, 0.75]);
  assert.ok(Math.abs(project(panel, [0.5, 1.25, -1.97])[2] - 0.03) < 1e-6);
  assert.deepEqual(at(panel, 1, 1), [2, 1, -2]);
});

test('a pointing ray only selects the panel in front of the hand', () => {
  assert.deepEqual(rayToPanel(panel, [1, 1.5, 0], [0, 0, -1]), [0.5, 0.5]);
  assert.equal(rayToPanel(panel, [1, 1.5, 0], [0, 0, 1]), null);
  assert.equal(rayToPanel(panel, [3, 1.5, 0], [0, 0, -1]), null);
});
