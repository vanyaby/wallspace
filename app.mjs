import { enterVR } from './vr.mjs?v=8';
import { archive, recover, traceHull } from './ink-tools.mjs';

const colors = {black: '#263238', indigo: '#4946a6', red: '#c0314b', teal: '#007d72', orange: '#b65a08'};
const canvas = document.querySelector('#ink');
const context = canvas.getContext('2d', {willReadFrequently: true});
const undoButton = document.querySelector('#undo');
const eraserButton = document.querySelector('#eraser');
const colorButtons = [...document.querySelectorAll('[data-ink]')];
const vrButton = document.querySelector('#vr');
const xrStatus = document.querySelector('#xr-status');
const saveStatus = document.querySelector('#save-status');
const storageKey = 'wallspace.ink.v1';
const undoStack = [];
const redoStack = [];
const tileSize = 96;
const historyBudget = 36 * 1024 * 1024;
let tool = 'indigo';
let previous = null;
let action = null;
let dirty = null;
let footprint = null;
let saveState = 'saved';
let exportPending = false;
let preparedPNG = null;
let activePointer = null;
let saveTimer = null;
let revision = 0;

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const data = canvas.toDataURL('image/png');
  try {
    const before = localStorage.getItem(storageKey);
    localStorage.setItem(storageKey, data);
    if (before && before !== data) void archive(before, 'previous');
    saveState = 'saved';
    saveStatus.textContent = 'Сохранено на этом устройстве';
  } catch {
    saveState = 'error';
    saveStatus.textContent = 'Автосохранение недоступно. Скачай PNG.';
  }
  void archive(data, 'current');
}

function queueSave() {
  clearTimeout(saveTimer);
  saveState = 'pending';
  saveTimer = setTimeout(save, 450);
}

function selectTool(next) {
  endStroke();
  tool = next;
  eraserButton.setAttribute('aria-pressed', String(next === 'eraser'));
  for (const button of colorButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.ink === tool));
  }
}

function bounds(points, margin = 0) {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return [Math.max(0, Math.floor(Math.min(...xs) - margin)), Math.max(0, Math.floor(Math.min(...ys) - margin)),
    Math.min(canvas.width, Math.ceil(Math.max(...xs) + margin)), Math.min(canvas.height, Math.ceil(Math.max(...ys) + margin))];
}

function invalidate([x, y, right, bottom]) {
  if (right <= x || bottom <= y) return;
  dirty = dirty ? [Math.min(x, dirty[0]), Math.min(y, dirty[1]), Math.max(right, dirty[2]), Math.max(bottom, dirty[3])] :
    [x, y, right, bottom];
  revision++;
}

function remember(rect) {
  action ??= new Map();
  for (let y = Math.floor(rect[1] / tileSize) * tileSize; y < rect[3]; y += tileSize) {
    for (let x = Math.floor(rect[0] / tileSize) * tileSize; x < rect[2]; x += tileSize) {
      const key = y * canvas.width + x;
      if (!action.has(key)) action.set(key, {x, y, image: context.getImageData(x, y,
        Math.min(tileSize, canvas.width - x), Math.min(tileSize, canvas.height - y))});
    }
  }
}

function commit() {
  if (!action?.size) {
    action = null;
    return;
  }
  const tiles = Array.from(action.values());
  undoStack.push(tiles);
  redoStack.length = 0;
  const weight = entry => entry.reduce((total, tile) => total + tile.image.data.byteLength, 0);
  let usage = undoStack.reduce((total, entry) => total + weight(entry), 0);
  while ((usage > historyBudget || undoStack.length > 96) && undoStack.length > 1) usage -= weight(undoStack.shift());
  action = null;
  undoButton.disabled = false;
  queueSave();
}

function stroke(u, v, thickness, erase = tool === 'eraser', pigment = tool) {
  const x = u * canvas.width;
  const y = v * canvas.height;
  const width = thickness ?? (erase ? 54 : 14);
  const rect = bounds(previous ? [previous, [x, y]] : [[x, y]], width / 2 + 3);
  remember(rect);
  context.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  context.strokeStyle = context.fillStyle = colors[pigment] ?? '#000';
  context.lineCap = 'round';
  context.lineWidth = width;
  context.beginPath();
  if (previous) {
    context.moveTo(...previous);
    context.lineTo(x, y);
    context.stroke();
  } else {
    context.arc(x, y, width / 2, 0, 2 * Math.PI);
    context.fill();
  }
  previous = [x, y];
  invalidate(rect);
}

function eraseFootprint(corners) {
  const points = corners.map(([u, v]) => [u * canvas.width, v * canvas.height]);
  const all = footprint ? [...footprint, ...points] : points;
  const rect = bounds(all, 2);
  remember(rect);
  context.globalCompositeOperation = 'destination-out';
  context.fillStyle = '#000';
  context.beginPath();
  traceHull(context, all);
  context.fill();
  footprint = points;
  invalidate(rect);
}

function stamp({points, closed}, thickness = 14) {
  endStroke();
  const rect = bounds(points, thickness / 2 + 3);
  remember(rect);
  context.globalCompositeOperation = 'source-over';
  context.strokeStyle = colors[tool] ?? colors.indigo;
  context.lineWidth = thickness;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(...points[0]);
  for (const point of points.slice(1)) context.lineTo(...point);
  if (closed) context.closePath();
  context.stroke();
  invalidate(rect);
  commit();
}

function clear() {
  endStroke();
  void archive(canvas.toDataURL('image/png'), 'beforeClear');
  const rect = [0, 0, canvas.width, canvas.height];
  remember(rect);
  context.clearRect(0, 0, canvas.width, canvas.height);
  invalidate(rect);
  commit();
}

function endStroke() {
  previous = null;
  footprint = null;
  commit();
}

function exchange(from, to) {
  endStroke();
  const tiles = from.pop();
  if (!tiles) return;
  to.push(tiles.map(({x, y, image}) => {
    const before = context.getImageData(x, y, image.width, image.height);
    context.putImageData(image, x, y);
    invalidate([x, y, x + image.width, y + image.height]);
    return {x, y, image: before};
  }));
  undoButton.disabled = !undoStack.length;
  queueSave();
}

const undo = () => exchange(undoStack, redoStack);
const redo = () => exchange(redoStack, undoStack);
function drawPointer(event) {
  const rect = canvas.getBoundingClientRect();
  const u = (event.clientX - rect.left) / rect.width;
  const v = (event.clientY - rect.top) / rect.height;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) stroke(u, v);
  else endStroke();
}

async function restore() {
  try {
    let imageData;
    try { imageData = localStorage.getItem(storageKey); } catch {}
    imageData ||= await recover('current');
    if (!imageData) return;
    const image = new Image();
    image.src = imageData;
    await image.decode();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    revision++;
    saveStatus.textContent = 'Сохранённый рисунок загружен';
  } catch {
    saveStatus.textContent = 'Сохранённый рисунок недоступен';
  }
}

async function restoreCopy(kind) {
  const data = await recover(kind);
  if (!data) return false;
  const image = new Image();
  image.src = data;
  try { await image.decode(); } catch { return false; }
  endStroke();
  const rect = [0, 0, canvas.width, canvas.height];
  remember(rect);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'source-over';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  invalidate(rect);
  commit();
  return true;
}

function downloadPNG() {
  const file = document.createElement('a');
  file.download = 'wallspace.png';
  file.href = preparedPNG ?? canvas.toDataURL('image/png');
  file.click();
  preparedPNG = null;
}

await restore();
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || activePointer !== null) return;
  activePointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  drawPointer(event);
});
canvas.addEventListener('pointermove', event => {
  if (event.pointerId === activePointer) drawPointer(event);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(name, event => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    endStroke();
  });
}
window.addEventListener('pagehide', () => {
  endStroke();
  if (saveTimer !== null) save();
});
for (const button of colorButtons) {
  button.addEventListener('click', () => selectTool(button.dataset.ink));
}
eraserButton.addEventListener('click', () => selectTool(tool === 'eraser' ? 'indigo' : 'eraser'));
undoButton.addEventListener('click', undo);
document.querySelector('#export').addEventListener('click', downloadPNG);

const board = {canvas, colors, stroke, eraseFootprint, stamp, endStroke, undo, redo, clear, selectTool, restoreCopy, save,
  breakPath() { previous = null; footprint = null; },
  requestExport() {
    preparedPNG = canvas.toDataURL('image/png');
    exportPending = true;
  },
  takeDirty() { const rect = dirty; dirty = null; return rect; },
  get saveState() { return saveState; },
  get revision() { return revision; },
  get tool() { return tool; }};

let supported = false;
try {
  supported = await navigator.xr?.isSessionSupported('immersive-vr');
} catch {
  // The 2D board is available even when the browser cannot check WebXR.
}
vrButton.disabled = !supported;
xrStatus.textContent = supported ? 'VR доступен · возьми контроллеры' :
  'Открой сайт в браузере Quest, чтобы войти в VR';
vrButton.addEventListener('click', async () => {
  vrButton.disabled = true;
  xrStatus.textContent = 'Открываем VR-мастерскую…';
  try {
    await enterVR(board, () => {
      vrButton.disabled = false;
      xrStatus.textContent = exportPending ? 'PNG готов. Нажми «Скачать PNG».' : 'Сеанс VR завершён';
      exportPending = false;
    }, () => {
      vrButton.disabled = false;
      xrStatus.textContent = 'Сеанс VR прервался. Попробуй войти снова.';
    });
  } catch (error) {
    vrButton.disabled = false;
    xrStatus.textContent = 'Не удалось открыть VR. Попробуй снова в браузере Quest.';
    console.error(error);
  }
});
