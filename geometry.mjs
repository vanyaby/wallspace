export const add = (a, b) => a.map((value, i) => value + b[i]);
export const sub = (a, b) => a.map((value, i) => value - b[i]);
export const mul = (a, s) => a.map(value => value * s);
export const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
export const length = a => Math.hypot(...a);
export const cross = ([x, y, z], [a, b, c]) => [y * c - z * b, z * a - x * c, x * b - y * a];
export const unit = a => mul(a, 1 / length(a));
export const xyz = ({x, y, z}) => [x, y, z];

export function at(panel, u, v, depth = 0) {
  return add(panel.origin, add(mul(panel.right, u * panel.width),
    add(mul(panel.down, v * panel.height), mul(panel.normal, depth))));
}

export function project(panel, point) {
  const delta = sub(point, panel.origin);
  return [dot(delta, panel.right) / panel.width, dot(delta, panel.down) / panel.height,
    dot(delta, panel.normal)];
}

export function inside([u, v]) {
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

export function rayToPanel(panel, origin, direction) {
  const denominator = dot(direction, panel.normal);
  if (Math.abs(denominator) < 0.0001) return null;
  const distance = dot(sub(panel.origin, origin), panel.normal) / denominator;
  if (distance <= 0) return null;
  const point = project(panel, add(origin, mul(direction, distance)));
  return inside(point) ? point.slice(0, 2) : null;
}

export function forward({x, y, z, w}) {
  return [-2 * (x * z + w * y), -2 * (y * z - w * x), -1 + 2 * (x * x + y * y)];
}
