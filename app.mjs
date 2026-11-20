import { enterMR } from './xr.mjs?v=2';

const colors = {indigo: '#4946a6', red: '#c0314b', teal: '#007d72'};
const canvas = document.querySelector('#ink');
const context = canvas.getContext('2d', {willReadFrequently: true});
const undoButton = document.querySelector('#undo');
const eraserButton = document.querySelector('#eraser');
const colorButtons = [...document.querySelectorAll('[data-ink]')];
const mrButton = document.querySelector('#mr');
const xrStatus = document.querySelector('#xr-status');
const saveStatus = document.querySelector('#save-status');
const storageKey = 'wallspace.ink.v1';
const undoStack = [];
let tool = 'indigo';
let previous = null;
let activePointer = null;
let saveTimer = null;
let revision = 0;

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(storageKey, canvas.toDataURL('image/png'));
    saveStatus.textContent = 'Сохранено на этом устройстве';
  } catch {
    saveStatus.textContent = 'Автосохранение недоступно. Скачай PNG.';
  }
}

function queueSave() {
  clearTimeout(saveTimer);
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

function stroke(u, v) {
  const x = u * canvas.width;
  const y = v * canvas.height;
  const erasing = tool === 'eraser';
  const width = erasing ? 54 : 14;
  context.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  context.strokeStyle = context.fillStyle = colors[tool] ?? '#000';
  context.lineCap = 'round';
  context.lineWidth = width;
  context.beginPath();
  if (previous) {
    context.moveTo(...previous);
    context.lineTo(x, y);
    context.stroke();
  } else {
    undoStack.push(context.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.length > 8) undoStack.shift();
    undoButton.disabled = false;
    context.arc(x, y, width / 2, 0, 2 * Math.PI);
    context.fill();
  }
  previous = [x, y];
  revision++;
}

function endStroke() {
  if (!previous) return;
  previous = null;
  queueSave();
}

function undo() {
  endStroke();
  const image = undoStack.pop();
  if (!image) return;
  context.putImageData(image, 0, 0);
  undoButton.disabled = !undoStack.length;
  revision++;
  queueSave();
}

function drawPointer(event) {
  const rect = canvas.getBoundingClientRect();
  const u = (event.clientX - rect.left) / rect.width;
  const v = (event.clientY - rect.top) / rect.height;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) stroke(u, v);
  else endStroke();
}

async function restore() {
  try {
    const imageData = localStorage.getItem(storageKey);
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
document.querySelector('#export').addEventListener('click', () => {
  const file = document.createElement('a');
  file.download = 'wallspace.png';
  file.href = canvas.toDataURL('image/png');
  file.click();
});

const board = {canvas, colors, stroke, endStroke, undo, selectTool,
  get revision() { return revision; },
  get tool() { return tool; }};

let supported = false;
try {
  supported = await navigator.xr?.isSessionSupported('immersive-ar');
} catch {
  // The 2D board is available even when the browser cannot check WebXR.
}
mrButton.disabled = !supported;
xrStatus.textContent = supported ? 'Режим смешанной реальности доступен' :
  'Открой сайт в браузере Quest, чтобы войти в MR';
mrButton.addEventListener('click', async () => {
  mrButton.disabled = true;
  xrStatus.textContent = 'Открываем режим MR…';
  try {
    await enterMR(board, () => {
      mrButton.disabled = false;
      xrStatus.textContent = 'Режим MR завершён';
    }, () => {
      mrButton.disabled = false;
      xrStatus.textContent = 'Сеанс MR прервался. Попробуй войти снова.';
    });
  } catch (error) {
    mrButton.disabled = false;
    xrStatus.textContent = error.name === 'NotSupportedError'
      ? 'Для MR нужно отслеживание рук. Проверь настройки Quest.'
      : 'Не удалось войти в MR. Проверь отслеживание рук и попробуй снова.';
    console.error(error);
  }
});
