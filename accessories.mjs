import { add, at, cross, forward, length, mul, sub, unit, xyz } from './geometry.mjs';
import { boardHeight, boardWidth } from './instruments.mjs?v=8';

const clear = [0, 0, 0, 0];
export const wristActions = [['home', 'К доске'], ['settings', 'Настройки'],
  ['locomotion', 'Ходьба'], ['undo', 'Отмена'], ['return', 'Вернуть инструменты'], ['closeWrist', 'Закрыть']];

export function makePanel(origin, right, down, width, height) {
  return {origin, right, down, width, height, normal: cross(down, right)};
}

export function teleportArc(origin, direction, floor) {
  const points = [origin];
  const acceleration = 7;
  const velocity = mul(direction, 4.5);
  const ground = floor.origin[1];
  for (let step = 1; step <= 36; step++) {
    const time = step * 0.05;
    const next = add(add(origin, mul(velocity, time)), [0, -acceleration * time * time / 2, 0]);
    if (next[1] <= ground) {
      const prior = points.at(-1);
      const hit = add(prior, mul(sub(next, prior), (ground - prior[1]) / (next[1] - prior[1])));
      points.push(hit);
      return {points, hit};
    }
    points.push(next);
  }
  return {points, hit: null};
}

export function drawArc(renderer, points, valid) {
  const mesh = [];
  for (let i = 1; i < points.length; i++) {
    if (i % 2 === 0) continue;
    const a = points[i - 1], b = points[i];
    const left = cross(sub(b, a), [0, 1, 0]);
    if (length(left) < 0.001) continue;
    const side = mul(unit(left), 0.009);
    mesh.push(sub(a, side), add(a, side), add(b, side), sub(a, side), add(b, side), sub(b, side));
  }
  renderer.drawSolid(vertices(mesh), valid ? [0.63, 0.85, 0.66, 1] : [0.85, 0.45, 0.37, 1]);
}

export function wristPanel(grip, view) {
  const position = xyz(grip.position);
  const eye = xyz(view.position);
  const toward = sub(eye, position);
  if (length(toward) < 0.12) return null;
  const normal = unit(toward);
  const sideways = cross([0, 1, 0], normal);
  const right = length(sideways) > 0.01 ? unit(sideways) : [1, 0, 0];
  const down = cross(right, normal);
  return makePanel(add(position, add(mul(right, -0.115), [0, 0.165, 0])), right, down, 0.23, 0.18);
}

export function paintWrist(ctx) {
  ctx.fillStyle = '#1d302e';
  ctx.fillRect(0, 0, 512, 320);
  ctx.font = 'bold 31px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  wristActions.forEach(([, label], i) => {
    const x = (i % 2) * 256, y = Math.floor(i / 2) * (320 / 3);
    ctx.fillStyle = '#395e54';
    ctx.fillRect(x + 6, y + 6, 244, 320 / 3 - 12);
    ctx.fillStyle = '#f8f5de';
    ctx.fillText(label, x + 128, y + 160 / 3, 222);
  });
}

function vertices(points, shade = 1) {
  return new Float32Array(points.flatMap(point => [...point, 0, 0, shade]));
}

const sphere = [];
for (let band = 0; band < 6; band++) {
  for (let slice = 0; slice < 12; slice++) {
    const point = (row, column) => {
      const polar = Math.PI * row / 6;
      const azimuth = Math.PI * column / 6;
      const x = Math.sin(polar) * Math.cos(azimuth), y = Math.cos(polar), z = Math.sin(polar) * Math.sin(azimuth);
      return [x, y, z, 0.72 + 0.21 * (y + 1) / 2 + 0.07 * (z + 1) / 2];
    };
    const a = point(band, slice), b = point(band, slice + 1);
    const c = point(band + 1, slice + 1), d = point(band + 1, slice);
    sphere.push(a, b, c, a, c, d);
  }
}

export function drawSphere(renderer, [x, y, z], radius, color) {
  const mesh = new Float32Array(sphere.length * 6);
  sphere.forEach(([a, b, c, shade], i) => {
    mesh.set([x + a * radius, y + b * radius, z + c * radius, 0, 0, shade], i * 6);
  });
  renderer.drawSolid(mesh, color);
}

export function drawFootprint(renderer, surface, points, color) {
  const outline = [];
  for (let i = 0; i < points.length; i++) {
    const a = at(surface, ...points[i], 0.006), b = at(surface, ...points[(i + 1) % points.length], 0.006);
    const edge = sub(b, a);
    if (length(edge) < 0.001) continue;
    const side = mul(unit(cross(edge, surface.normal)), 0.001);
    outline.push(sub(a, side), add(a, side), add(b, side), sub(a, side), add(b, side), sub(b, side));
  }
  renderer.drawSolid(vertices(outline), color);
}

export function drawBox(renderer, center, axes, size, color) {
  const faces = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, k = (i + 2) % 3;
    for (const sign of [-1, 1]) {
      const face = add(center, mul(axes[i], sign * size[i] / 2));
      const a = mul(axes[j], size[j] / 2), b = mul(axes[k], size[k] / 2);
      const corners = [sub(sub(face, a), b), add(sub(face, b), a), add(add(face, a), b), add(sub(face, a), b)];
      for (const index of [0, 1, 2, 0, 2, 3]) faces.push(...corners[index], 0, 0, 0.78 + i * 0.11);
    }
  }
  renderer.drawSolid(new Float32Array(faces), color);
}

function pointOnBoard(surface, [x, y], depth) {
  return at(surface, x / boardWidth, y / boardHeight, depth);
}

function drawSlab(renderer, surface, outline, color, edge, bottom, top) {
  const front = outline.map(point => pointOnBoard(surface, point, top));
  const back = outline.map(point => pointOnBoard(surface, point, bottom));
  const face = [], wall = [];
  for (let i = 1; i < front.length - 1; i++) face.push(front[0], front[i], front[i + 1]);
  for (let i = 0; i < front.length; i++) {
    const j = (i + 1) % front.length;
    wall.push(front[i], back[i], back[j], front[i], back[j], front[j]);
  }
  renderer.drawSolid(vertices(face), color);
  renderer.drawSolid(vertices(wall), edge);
}

export function drawRuler(renderer, surface, ruler) {
  const [a, b] = ruler;
  const along = unit(sub(b, a));
  const distance = length(sub(b, a));
  const side = [-along[1], along[0]];
  const point = (x, y) => add(a, add(mul(along, x), mul(side, y)));
  const outline = [[-15, 4], [distance + 15, 4], [distance + 25, 14], [distance + 25, 47],
    [distance + 15, 57], [-15, 57], [-25, 47], [-25, 14]].map(pair => point(...pair));
  drawSlab(renderer, surface, outline, [0.43, 0.68, 0.77, 0.21], [0.15, 0.35, 0.44, 0.68], 0.008, 0.017);
  const rail = [[-15, 49], [distance + 15, 49], [distance + 10, 55], [-10, 55]].map(pair => point(...pair));
  drawSlab(renderer, surface, rail, [0.18, 0.39, 0.47, 0.85], [0.24, 0.47, 0.53, 1], 0.017, 0.020);
  for (const end of ruler) {
    const ring = radius => Array.from({length: 20}, (_, i) => {
      const angle = i * Math.PI / 10;
      return add(end, [Math.cos(angle) * radius, Math.sin(angle) * radius]);
    });
    drawSlab(renderer, surface, ring(25), [0.20, 0.32, 0.37, 1], [0.36, 0.48, 0.53, 1], 0.006, 0.025);
    drawSlab(renderer, surface, ring(19), [0.78, 0.85, 0.85, 1], [0.53, 0.61, 0.63, 1], 0.025, 0.028);
    drawSlab(renderer, surface, ring(11), [0.24, 0.45, 0.53, 1], [0.40, 0.62, 0.69, 1], 0.028, 0.031);
  }
}

export function drawProtractor(renderer, surface, anchor, angle, scale) {
  const segment = (i, radius) => {
    const phase = angle - i * Math.PI / 42;
    return add(anchor, [radius * Math.cos(phase) * scale, radius * Math.sin(phase) * scale]);
  };
  const face = [], rim = [], inner = [];
  for (let i = 0; i < 42; i++) {
    const a = segment(i, 160), b = segment(i + 1, 160);
    const c = segment(i + 1, 110), d = segment(i, 110);
    face.push(a, b, c, a, c, d);
    const e = segment(i, 154), f = segment(i + 1, 154);
    rim.push(a, b, f, a, f, e);
    inner.push(d, c, segment(i + 1, 114), d, segment(i + 1, 114), segment(i, 114));
  }
  renderer.drawSolid(vertices(face.map(point => pointOnBoard(surface, point, 0.017))), [0.52, 0.74, 0.75, 0.24]);
  renderer.drawSolid(vertices(rim.map(point => pointOnBoard(surface, point, 0.020))), [0.24, 0.49, 0.55, 0.92]);
  renderer.drawSolid(vertices(inner.map(point => pointOnBoard(surface, point, 0.020))), [0.38, 0.64, 0.67, 0.70]);
  const across = mul([-Math.sin(angle), Math.cos(angle)], 5 * scale);
  const left = segment(42, 155), right = segment(0, 155);
  drawSlab(renderer, surface, [sub(left, across), sub(right, across), add(right, across), add(left, across)],
    [0.37, 0.63, 0.66, 0.58], [0.22, 0.48, 0.54, 0.8], 0.010, 0.019);
}

export function drawVignette(renderer, texture, pose, strength, view) {
  const distance = 0.07;
  const normal = mul(forward(pose.orientation), -1);
  const {x, y, z, w} = pose.orientation;
  const right = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  const down = cross(right, normal);
  const width = distance * (2 + 2 * Math.abs(view.projectionMatrix[8])) / view.projectionMatrix[0];
  const height = distance * (2 + 2 * Math.abs(view.projectionMatrix[9])) / view.projectionMatrix[5];
  const center = sub(xyz(pose.position), mul(normal, distance));
  const origin = sub(sub(center, mul(right, width / 2)), mul(down, height / 2));
  renderer.drawScreen(makePanel(origin, right, down, width, height), texture, clear, strength);
}

export function createSound() {
  try {
    const context = new AudioContext();
    void context.resume().catch(() => {});
    const buffer = context.createBuffer(1, Math.round(context.sampleRate * 0.11), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    return {
      play(kind, volume) {
        if (context.state !== 'running' || !volume) return;
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        const filter = context.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = kind === 'click' ? 1450 : kind === 'sponge' ? 510 : 850;
        const gain = context.createGain();
        const now = context.currentTime;
        gain.gain.setValueAtTime(volume * (kind === 'click' ? 0.035 : 0.019), now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
        noise.connect(filter).connect(gain).connect(context.destination);
        noise.start();
      },
      close() { void context.close().catch(() => {}); }
    };
  } catch { return null; }
}
