import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeWall, project, at, rayToPanel } from '../geometry.mjs';

test('projects a fingertip on an orthogonal wall facing the viewer', () => {
  const wall = makeWall([0, 2, -2], [2, 2, -2], [0.2, 1, -2], [0, 1.7, 0]);
  assert.deepEqual(project(wall, [0.5, 1.25, -1.97]).slice(0, 2), [0.25, 0.75]);
  assert.ok(Math.abs(project(wall, [0.5, 1.25, -1.97])[2] - 0.03) < 1e-6);
  assert.deepEqual(at(wall, 1, 1), [2, 1, -2]);
});

test('rejects a tiny edge and nearly collinear calibration', () => {
  assert.equal(makeWall([0, 0, 0], [0.1, 0, 0], [0, -1, 0], [0, 0, 1]), null);
  assert.equal(makeWall([0, 0, 0], [1, 0, 0], [1, -0.1, 0], [0, 0, 1]), null);
});

test('rejects calibration corners placed in reverse order', () => {
  const viewer = [0, 1.5, 0];
  assert.equal(makeWall([0, 2, -2], [2, 2, -2], [0, 3, -2], viewer), null);
  assert.equal(makeWall([0, 2, -2], [-2, 2, -2], [0, 1, -2], viewer), null);
});

test('a pointing ray only selects the panel in front of the hand', () => {
  const wall = makeWall([0, 2, -2], [2, 2, -2], [0, 1, -2], [0, 1, 0]);
  assert.deepEqual(rayToPanel(wall, [1, 1.5, 0], [0, 0, -1]), [0.5, 0.5]);
  assert.equal(rayToPanel(wall, [1, 1.5, 0], [0, 0, 1]), null);
});
