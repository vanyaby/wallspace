import { add, dot, length, mul, sub } from './geometry.mjs';

export const boardWidth = 1440;
export const boardHeight = 960;
export const magneticStep = 60;
export const magnetReach = 38;

export const initialRuler = () => [[360, 480], [1080, 480]];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function moveMagnet(ruler, end, point, magnetic = true) {
  const snap = (value, size) => clamp(magnetic ? Math.round(value / magneticStep) * magneticStep : value,
    magneticStep, size - magneticStep);
  const next = [snap(point[0], boardWidth), snap(point[1], boardHeight)];
  if (length(sub(next, ruler[1 - end])) < 2 * magneticStep) return ruler;
  if (next.every((value, i) => value === ruler[end][i])) return ruler;
  return ruler.map((original, i) => i === end ? next : original);
}

export function moveRuler(ruler, center, magnetic) {
  const [a, b] = ruler;
  const mid = mul(add(a, b), 0.5);
  const offset = sub(center, mid);
  const dimensions = [boardWidth, boardHeight];
  return ruler.map(point => add(point, offset.map((value, i) => {
    const goal = magnetic ? Math.round(value / magneticStep) * magneticStep : value;
    return clamp(goal, magneticStep - Math.min(a[i], b[i]), dimensions[i] - magneticStep - Math.max(a[i], b[i]));
  })));
}

export function projectToRuler([a, b], pointer) {
  const edge = sub(b, a);
  const along = clamp(dot(sub(pointer, a), edge) / dot(edge, edge), 0, 1);
  const point = add(a, mul(edge, along));
  return {point, distance: length(sub(pointer, point))};
}

export const shapes = [
  ['segment', 'Отрезок'], ['circle', 'Круг'], ['rectangle', 'Прямоуг.'],
  ['square', 'Квадрат'], ['triangle', 'Треугольник'], ['arc', 'Дуга'], ['angle', 'Угол']
];

export function figure(id, pointer, scale = 1, rotation = 0, degrees = 60, fixed = false) {
  let outline;
  let closed = true;
  const radians = (id === 'angle' ? degrees : Number(id)) * Math.PI / 180;
  if (id === 'circle') {
    outline = Array.from({length: 64}, (_, i) => {
      const phase = i * Math.PI / 32;
      return [128 * Math.cos(phase), 128 * Math.sin(phase)];
    });
  } else if (id === 'square') {
    outline = [[-120, -120], [120, -120], [120, 120], [-120, 120]];
  } else if (id === 'rectangle') {
    outline = [[-165, -95], [165, -95], [165, 95], [-165, 95]];
  } else if (id === 'triangle') {
    outline = [[0, -148], [128, 74], [-128, 74]];
  } else if (id === 'segment') {
    closed = false;
    outline = [[-150, 0], [150, 0]];
  } else if (id === 'arc') {
    closed = false;
    outline = Array.from({length: 41}, (_, i) => {
      const phase = i * degrees * Math.PI / (40 * 180);
      return [145 * Math.cos(phase), -145 * Math.sin(phase)];
    });
  } else {
    closed = false;
    outline = [[200, 0], [0, 0], [Math.round(200 * Math.cos(radians)), -Math.round(200 * Math.sin(radians))]];
  }
  const cosine = Math.cos(rotation) * scale;
  const sine = Math.sin(rotation) * scale;
  outline = outline.map(([x, y]) => [x * cosine - y * sine, x * sine + y * cosine]);
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  const anchor = fixed ? pointer : [clamp(pointer[0], 12 - Math.min(...xs), boardWidth - 12 - Math.max(...xs)),
    clamp(pointer[1], 12 - Math.min(...ys), boardHeight - 12 - Math.max(...ys))];
  const points = outline.map(point => add(point, anchor));
  const valid = points.every(([x, y]) => x >= 12 && x <= boardWidth - 12 && y >= 12 && y <= boardHeight - 12);
  return {points, valid, anchor, closed, angle: rotation, scale,
    protractor: id === 'angle' || id === 'arc' || Number.isFinite(Number(id))};
}
