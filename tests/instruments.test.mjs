import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveMagnet, projectToRuler, figure } from '../instruments.mjs';

test('each magnetic end snaps independently and cannot collapse the ruler', () => {
  const ruler = [[300, 480], [960, 480]];
  assert.deepEqual(moveMagnet(ruler, 0, [233, 337]), [[240, 360], [960, 480]]);
  assert.deepEqual(moveMagnet(ruler, 1, [310, 470]), ruler);
  assert.deepEqual(moveMagnet(ruler, 1, [1690, -25]), [[300, 480], [1380, 60]]);
});

test('the ruler projects a free point onto its angled edge and clamps to its endpoints', () => {
  const ruler = [[200, 200], [600, 600]];
  assert.deepEqual(projectToRuler(ruler, [500, 300]), {point: [400, 400], distance: Math.sqrt(20000)});
  assert.deepEqual(projectToRuler(ruler, [700, 700]).point, [600, 600]);
});

test('geometric figures remain entirely on the paper near the edges', () => {
  for (const id of ['circle', 'square', 'triangle', '30', '45', '60', '90', '120']) {
    const {points, closed} = figure(id, [3, 4]);
    assert.ok(points.every(([x, y]) => x >= 0 && y >= 0 && x <= 1440 && y <= 960));
    assert.equal(closed, ['circle', 'square', 'triangle'].includes(id));
  }
});

test('the protractor places a 90 degree angle with a horizontal and a vertical ray', () => {
  const {points} = figure('90', [600, 600]);
  assert.deepEqual(points, [[800, 600], [600, 600], [600, 400]]);
});
