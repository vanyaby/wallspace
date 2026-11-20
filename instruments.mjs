import { add, dot, length, mul, sub } from './geometry.mjs';

export const boardWidth = 1440;
export const boardHeight = 960;
export const magneticStep = 60;
export const magnetReach = 38;

export const initialRuler = () => [[360, 480], [1080, 480]];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function moveMagnet(ruler, end, point) {
  const snap = (value, size) => clamp(Math.round(value / magneticStep) * magneticStep,
    magneticStep, size - magneticStep);
  const next = [snap(point[0], boardWidth), snap(point[1], boardHeight)];
  if (length(sub(next, ruler[1 - end])) < 2 * magneticStep) return ruler;
  if (next.every((value, i) => value === ruler[end][i])) return ruler;
  return ruler.map((original, i) => i === end ? next : original);
}

export function projectToRuler([a, b], pointer) {
  const edge = sub(b, a);
  const along = clamp(dot(sub(pointer, a), edge) / dot(edge, edge), 0, 1);
  const point = add(a, mul(edge, along));
  return {point, distance: length(sub(pointer, point))};
}

export const shapes = [
  ['circle', 'Круг'], ['square', 'Квадрат'], ['triangle', 'Треугольник'],
  ['30', '30°'], ['45', '45°'], ['60', '60°'], ['90', '90°'], ['120', '120°']
];

export function figure(id, pointer) {
  let outline;
  let closed = true;
  const radians = Number(id) * Math.PI / 180;
  if (id === 'circle') {
    outline = Array.from({length: 64}, (_, i) => {
      const phase = i * Math.PI / 32;
      return [128 * Math.cos(phase), 128 * Math.sin(phase)];
    });
  } else if (id === 'square') {
    outline = [[-120, -120], [120, -120], [120, 120], [-120, 120]];
  } else if (id === 'triangle') {
    outline = [[0, -148], [128, 74], [-128, 74]];
  } else {
    closed = false;
    outline = [[200, 0], [0, 0], [Math.round(200 * Math.cos(radians)), -Math.round(200 * Math.sin(radians))]];
  }
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  const anchor = [clamp(pointer[0], 12 - Math.min(...xs), boardWidth - 12 - Math.max(...xs)),
    clamp(pointer[1], 12 - Math.min(...ys), boardHeight - 12 - Math.max(...ys))];
  return {points: outline.map(point => add(point, anchor)), anchor, closed};
}
