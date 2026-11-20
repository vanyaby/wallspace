import { add, at, cross, dot, forward, inside, length, mul, project, sub, unit, xyz } from './geometry.mjs';

export const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
export const limits = {
  height: [0.75, 2], tilt: [0, 75], yaw: [-40, 40], distance: [1.1, 2.65],
  size: [0.65, 1.16], resistance: [0, 4], haptics: [0, 4], gripLeft: [-65, 65], gripRight: [-65, 65], speed: [0.45, 1.65]
};
const defaults = {height: 1.4, tilt: 0, yaw: 0, distance: 2.12, size: 1, resistance: 2, haptics: 2,
  gripLeft: 0, gripRight: 0, speed: 0.9, locked: false, hold: false};
const key = 'wallspace.workshop.v1';

export function loadSettings() {
  const settings = {...defaults};
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    for (const [name, range] of Object.entries(limits)) {
      if (Number.isFinite(stored?.[name])) settings[name] = clamp(stored[name], ...range);
    }
    for (const name of ['locked', 'hold']) {
      if (typeof stored?.[name] === 'boolean') settings[name] = stored[name];
    }
  } catch {}
  return settings;
}

export function rememberSettings(settings) {
  try { localStorage.setItem(key, JSON.stringify(settings)); } catch {}
}

export function flat(vector, fallback) {
  const horizontal = [vector[0], 0, vector[2]];
  return length(horizontal) > 0.0001 ? unit(horizontal) : fallback;
}

export function rotateY([x, y, z], angle) {
  return [x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle)];
}

export function controls(source) {
  const axes = source?.gamepad?.axes;
  const deadZone = value => Math.abs(value) > 0.19 ? (value - Math.sign(value) * 0.19) / 0.81 : 0;
  return [deadZone(axes?.[2] ?? axes?.[0] ?? 0), deadZone(axes?.[3] ?? axes?.[1] ?? 0)];
}

export function offsetSpace(reference, displacement, yaw) {
  if (!yaw && !displacement.some(Boolean)) return reference;
  const [x, y, z] = displacement;
  return reference.getOffsetReferenceSpace(new XRRigidTransform({x, y, z},
    {x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2)}).inverse);
}

export function constrainWalk(room, from, to) {
  const {origin, right, ahead, board} = room;
  const offset = sub(to, origin);
  const x = clamp(dot(offset, right), -2.8, 2.8);
  const z = clamp(dot(offset, ahead), -3.15, 3);
  const next = add(add(add(origin, mul(right, x)), mul(ahead, z)), [0, offset[1], 0]);
  const normal = flat(board.normal, mul(ahead, -1));
  const center = at(board, 0.5, 0.5);
  const past = dot(sub(from, center), normal);
  const depth = dot(sub(next, center), normal);
  const edge = Math.abs(dot(sub(next, center), board.right));
  const reach = Math.max(0.24, Math.abs(dot(board.down, normal)) * board.height / 2 + 0.12);
  if (edge < board.width / 2 + 0.18 && (Math.abs(depth) < reach || depth * past < 0)) {
    return add(next, mul(normal, (past >= 0 ? reach : -reach) - depth));
  }
  return next;
}

export function markerPose(transform, grip) {
  const direction = forward(transform.orientation);
  const q = transform.orientation;
  const localUp = [2 * (q.x * q.y - q.w * q.z), 1 - 2 * (q.x ** 2 + q.z ** 2),
    2 * (q.y * q.z + q.w * q.x)];
  const angle = grip * Math.PI / 180;
  const axis = add(mul(direction, Math.cos(angle)), mul(localUp, Math.sin(angle)));
  const base = add(xyz(transform.position), mul(localUp, 0.018));
  return {axis, tip: add(base, mul(axis, 0.155))};
}

export function contactPoint(panel, tip, previous, resistance) {
  const position = project(panel, tip);
  if (!inside(position) || position[2] > (previous ? 0.017 : 0.008) || position[2] < -0.065) return null;
  const raw = position.slice(0, 2);
  if (!previous) return {raw, ink: raw, delta: null};
  const delta = sub(raw, previous.raw);
  if (length(delta) < 0.00022) return {...previous, restart: false, delta: [0, 0]};
  if (length(delta) > 0.14) return {raw, ink: raw, delta: null, restart: true};
  const bend = previous.delta && dot(delta, previous.delta) < 0.45 * length(delta) * length(previous.delta);
  const follow = resistance ? clamp(0.72 - resistance * 0.135 + length(delta) * 33 + (bend ? 0.38 : 0), 0.12, 1) : 1;
  let ink = add(previous.ink, mul(sub(raw, previous.ink), follow));
  const gap = sub(raw, ink);
  if (length(gap) > 0.004) ink = sub(raw, mul(unit(gap), 0.004));
  return {raw, ink, delta};
}

export function pulse(source, amplitude, duration) {
  if (!amplitude) return;
  const act = source.gamepad?.hapticActuators?.[0];
  const dual = source.gamepad?.vibrationActuator;
  try {
    const result = act?.pulse ? act.pulse(amplitude, duration) :
      dual?.playEffect?.('dual-rumble', {duration, strongMagnitude: amplitude, weakMagnitude: amplitude});
    result?.catch(() => {});
  } catch {}
}

export function drawMarker(renderer, pose, color) {
  const {axis, tip} = pose;
  const right = flat(cross(axis, [0, 1, 0]), [1, 0, 0]);
  const perpendicular = unit(cross(axis, right));
  const tint = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
  const bands = [[0, 0.024, 0.003, 0.009, tint], [0.024, 0.043, 0.009, 0.011, tint],
    [0.043, 0.163, 0.011, 0.011, [0.87, 0.88, 0.81]], [0.163, 0.186, 0.011, 0.011, tint]];
  const ring = Array.from({length: 8}, (_, i) =>
    add(mul(right, Math.cos(i * Math.PI / 4)), mul(perpendicular, Math.sin(i * Math.PI / 4))));
  for (const [start, end, nose, tail, rgb] of bands) {
    const front = sub(tip, mul(axis, start));
    const back = sub(tip, mul(axis, end));
    const vertices = [];
    for (let i = 0; i < 8; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % 8];
      const frontA = add(front, mul(a, nose)), frontB = add(front, mul(b, nose));
      const backA = add(back, mul(a, tail)), backB = add(back, mul(b, tail));
      const shade = 0.76 + 0.24 * (Math.sin(i * Math.PI / 4) + 1) / 2;
      for (const point of [frontA, backA, backB, frontA, backB, frontB]) vertices.push(...point, 0, 0, shade);
      if (start === 0) {
        for (const point of [front, frontA, frontB]) vertices.push(...point, 0, 0, 0.90);
      }
      if (end === 0.186) {
        for (const point of [back, backA, backB]) vertices.push(...point, 0, 0, 0.80);
      }
    }
    renderer.drawSolid(new Float32Array(vertices), [...rgb, 1]);
  }
}

export function rackPosition(board, index, count) {
  return at(board, 0.14 + index * (0.72 / Math.max(1, count - 1)), 1.045, 0.12);
}
