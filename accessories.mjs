import { add, at, cross, forward, length, mul, sub, unit, xyz } from './geometry.mjs';
import { boardHeight, boardWidth } from './instruments.mjs?v=5';

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
  return makePanel(add(position, add(mul(right, -0.145), [0, 0.21, 0])), right, down, 0.29, 0.24);
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

export function drawRuler(renderer, surface, ruler) {
  const front = [0.99, 0.79, 0.39, 0.33];
  const [a, b] = ruler;
  const edge = sub(b, a);
  const across = mul(unit([-edge[1], edge[0]]), 74);
  const corners = [a, b, add(b, across), add(a, across)];
  renderer.drawSolid(vertices([0, 1, 2, 0, 2, 3].map(i => pointOnBoard(surface, corners[i], 0.017))), front);
  const rim = [0, 1, 1, 2, 2, 3, 3, 0].flatMap((i, n, ids) => {
    if (n % 2) return [];
    const j = ids[n + 1];
    const a = pointOnBoard(surface, corners[i], 0.006), b = pointOnBoard(surface, corners[j], 0.006);
    const c = pointOnBoard(surface, corners[j], 0.017), d = pointOnBoard(surface, corners[i], 0.017);
    return [a, b, c, a, c, d];
  });
  renderer.drawSolid(vertices(rim), [0.86, 0.62, 0.30, 0.55]);
  ruler.forEach(end => {
    const origin = pointOnBoard(surface, end, 0.014);
    const points = [];
    const radius = surface.width * 29 / boardWidth;
    for (let n = 0; n < 14; n++) {
      const ring = (i, depth) => {
        const phase = i * Math.PI / 7;
        return add(add(origin, mul(surface.normal, depth)), add(mul(surface.right, radius * Math.cos(phase)),
          mul(surface.down, radius * Math.sin(phase))));
      };
      points.push(ring(n, 0), ring(n + 1, 0), ring(n, 0.018), ring(n, 0.018), ring(n + 1, 0), ring(n + 1, 0.018));
    }
    renderer.drawSolid(vertices(points), [0.61, 0.37, 0.12, 1]);
  });
}

export function drawProtractor(renderer, surface, anchor, angle, scale) {
  const center = pointOnBoard(surface, anchor, 0.017);
  const points = [], sides = [];
  for (let i = 0; i < 32; i++) {
    const ring = (n, height) => {
      const phase = n * Math.PI / 32;
      const radius = surface.width * 160 / boardWidth * scale;
      return add(add(center, mul(surface.normal, height)),
        add(mul(surface.right, radius * Math.cos(angle - phase)), mul(surface.down, radius * Math.sin(angle - phase))));
    };
    const a = ring(i, 0), b = ring(i + 1, 0), c = ring(i + 1, 0.008), d = ring(i, 0.008);
    points.push(center, a, b);
    sides.push(a, b, c, a, c, d);
  }
  renderer.drawSolid(vertices(points), [0.44, 0.75, 0.66, 0.27]);
  renderer.drawSolid(vertices(sides), [0.36, 0.70, 0.59, 0.82]);
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
