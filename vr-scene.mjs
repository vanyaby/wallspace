import { add, at, cross, forward, length, mul, unit, xyz } from './geometry.mjs';
import { boardHeight, boardWidth, magnetReach, magneticStep, shapes } from './instruments.mjs';
import { rotateY } from './workshop.mjs';

export const paletteWidth = 600;
export const paletteHeight = 1260;
const up = [0, 1, 0];
const down = [0, -1, 0];
const transparent = [0, 0, 0, 0];
const paper = [0.97, 0.95, 0.89, 1];

function panel(origin, right, down, width, height) {
  return {origin, right, down, width, height, normal: cross(down, right)};
}

export function createRoom(transform, referenceHasFloor) {
  const eye = xyz(transform.position);
  const heading = forward(transform.orientation);
  heading[1] = 0;
  const ahead = length(heading) > 0.001 ? unit(heading) : [0, 0, -1];
  const right = cross(ahead, up);
  const toward = mul(ahead, -1);
  const floorY = referenceHasFloor ? 0 : eye[1] - 1.55;
  const origin = [eye[0], floorY, eye[2]];
  const position = (x, height, distance) =>
    add(add(add(origin, mul(right, x)), mul(ahead, distance)), [0, height, 0]);
  const ceiling = 3.25;
  const floor = panel(position(-3.1, 0, 3.35), right, toward, 6.2, 6.85);
  const solids = [
    [floor, [0.13, 0.20, 0.20, 1]],
    [panel(position(-3.1, ceiling, 3.35), right, down, 6.2, ceiling), [0.11, 0.16, 0.17, 1]],
    [panel(position(-3.1, ceiling, 3.35), toward, down, 6.85, ceiling), [0.08, 0.13, 0.14, 1]],
    [panel(position(3.1, ceiling, -3.5), ahead, down, 6.85, ceiling), [0.08, 0.13, 0.14, 1]],
    [panel(position(3.1, ceiling, -3.5), mul(right, -1), down, 6.2, ceiling), [0.09, 0.14, 0.15, 1]],
    [panel(position(-3.1, ceiling, 3.35), right, toward, 6.2, 6.85), [0.073, 0.11, 0.12, 1]]
  ];
  for (let x = -3; x <= 3; x += 0.5) {
    solids.push([panel(position(x, 0.002, 3.35), right, toward, 0.007, 6.85), [0.22, 0.31, 0.29, 1]]);
  }
  for (let z = -3; z <= 3; z += 0.5) {
    solids.push([panel(position(-3.1, 0.002, z), right, toward, 6.2, 0.007), [0.22, 0.31, 0.29, 1]]);
  }
  return {origin, right, ahead, solids, position};
}

export function arrangeBoard(room, settings) {
  const turn = settings.yaw * Math.PI / 180;
  const tilt = settings.tilt * Math.PI / 180;
  const right = rotateY(room.right, turn);
  const toward = rotateY(mul(room.ahead, -1), turn);
  const downAxis = add(mul(down, Math.cos(tilt)), mul(toward, Math.sin(tilt)));
  const center = room.position(-0.28, settings.height, settings.distance);
  const width = 2.16 * settings.size;
  const height = 1.44 * settings.size;
  const board = panel(add(add(center, mul(right, -width / 2)), mul(downAxis, -height / 2)), right, downAxis, width, height);
  const palette = panel(room.position(1.1, 2.08, Math.min(settings.distance, 1.95)), room.right, down, 0.68, 1.44);
  const frame = panel(at(board, -0.025, -0.035, -0.035), right, downAxis, width * 1.05, height * 1.07);
  const tray = panel(at(board, -0.025, 1.075, -0.008), right, mul(downAxis, -1), width * 1.05, 0.11);
  const trayTop = panel(at(board, -0.025, 1.01, 0), right, toward, width * 1.05, 0.22);
  const supports = [-0.55, 0.35].map(x =>
    panel(room.position(x, settings.height, settings.distance + 0.12), room.right, down, 0.09, settings.height));
  const handles = [-0.052, 1.052].map(u => at(board, u, 0.53, 0.045));
  Object.assign(room, {board, palette, handles, hardware: [frame, tray, trayTop, ...supports]});
}

export function renderRoom(renderer, room, overlay) {
  for (const [surface, color] of room.solids) renderer.draw(surface, renderer.empty, color);
  for (const surface of room.hardware) renderer.draw(surface, renderer.empty, [0.31, 0.37, 0.33, 1]);
  renderer.draw(room.board, renderer.ink, paper);
  renderer.draw(room.board, overlay, transparent, 0, 0.003);
  renderer.draw(room.palette, renderer.interfaceTexture, transparent);
  for (const point of room.handles) {
    const {right, down} = room.board;
    const rail = panel(add(point, add(mul(right, -0.021), mul(down, -0.10))), right, down, 0.042, 0.20);
    renderer.draw(rail, renderer.empty, [0.57, 0.72, 0.62, 1]);
  }
}

export function drawPointer(renderer, {surface, uv, origin, direction}, color) {
  const hit = surface ? at(surface, ...uv, 0.008) : add(origin, mul(direction, 2.8));
  const vector = add(hit, mul(origin, -1));
  const sideways = cross(vector, up);
  if (length(sideways) > 0.001 && length(vector) > 0.02) {
    const width = unit(sideways);
    const beam = panel(add(origin, mul(width, -0.0025)), width, unit(vector), 0.005, length(vector));
    renderer.draw(beam, renderer.empty, [0.5, 0.9, 0.78, surface ? 0.62 : 0.42]);
  }
  if (!surface) return;
  const size = surface.width < 1 ? 0.011 : 0.018;
  const cursor = panel(add(hit, mul(add(surface.right, surface.down), -size / 2)), surface.right, surface.down, size, size);
  renderer.draw(cursor, renderer.empty, color);
}

export const adjustments = [
  ['height', 'Высота', 0.05, ' м'], ['tilt', 'Наклон', 5, '°'],
  ['yaw', 'Поворот', 5, '°'], ['distance', 'Дальность', 0.10, ' м'],
  ['size', 'Размер', 0.05, '×'], ['resistance', 'Тугость', 1, '/4'],
  ['haptics', 'Вибрация', 1, '/4'], ['gripLeft', 'Хват левой', 5, '°'],
  ['gripRight', 'Хват правой', 5, '°'],
  ['speed', 'Шаг', 0.15, ' м/с']
];

export function paletteButtons(colors, protractor, settingsOpen, settings) {
  if (settingsOpen) {
    const buttons = adjustments.flatMap(([id, label, , unit], row) => {
      const y = 135 + row * 75;
      const name = label + ' ' + Number(settings[id].toFixed(2)) + unit;
      return [{id: id + ':-', label: '−', x: 28, y, w: 90, h: 68},
        {id: id + ':label', label: name, x: 126, y, w: 348, h: 68, readOnly: true},
        {id: id + ':+', label: '+', x: 482, y, w: 90, h: 68}];
    });
    buttons.push(
      {id: 'seated', label: 'Сидя', x: 28, y: 894, w: 171, h: 85},
      {id: 'standing', label: 'Стоя', x: 214, y: 894, w: 171, h: 85},
      {id: 'drafting', label: 'Чертёж', x: 401, y: 894, w: 171, h: 85},
      {id: 'locked', label: settings.locked ? 'Разблокировать' : 'Зафиксировать', x: 28, y: 999, w: 264, h: 85},
      {id: 'hold', label: settings.hold ? 'Хват: держать' : 'Хват: кнопка', x: 308, y: 999, w: 264, h: 85},
      {id: 'home', label: 'К доске', x: 28, y: 1103, w: 264, h: 85},
      {id: 'settings', label: 'Назад', x: 308, y: 1103, w: 264, h: 85}
    );
    return buttons;
  }
  const entries = Object.entries(colors);
  const buttons = entries.map(([id, color], i) => ({
    id, color, x: 28 + i * (544 / entries.length), y: 152, w: 528 / entries.length, h: 118
  }));
  buttons.push(
    {id: 'settings', label: '⚙', x: 481, y: 22, w: 91, h: 82},
    {id: 'marker', label: 'Взять / убрать маркер', x: 28, y: protractor ? 522 : 858, w: 544, h: protractor ? 48 : 82},
    {id: 'eraser', label: 'Ластик', x: 28, y: 310, w: 264, h: 92},
    {id: 'ruler', label: 'Линейка', x: 308, y: 310, w: 264, h: 92},
    {id: 'protractor', label: 'Транспортир', x: 28, y: 420, w: 544, h: 92},
    {id: 'undo', label: 'Отменить', x: 28, y: 1100, w: 264, h: 94},
    {id: 'exit', label: 'Выйти', x: 308, y: 1100, w: 264, h: 94}
  );
  if (protractor) {
    shapes.forEach(([id, label], i) => {
      const short = i < 3;
      const row = short ? 0 : 1 + Math.floor((i - 3) / 3);
      const col = short ? i : (i - 3) % 3;
      buttons.push({id: 'shape:' + id, label, x: 28 + 184 * col, y: 623 + 116 * row, w: 176, h: 100});
    });
  }
  return buttons;
}

export function buttonAt(buttons, [u, v]) {
  const x = u * paletteWidth;
  const y = v * paletteHeight;
  return buttons.find(button => !button.readOnly && x >= button.x && x <= button.x + button.w &&
    y >= button.y && y <= button.y + button.h);
}

export function paintPalette(ctx, buttons, active, hover, protractor, ruler, controllersReady, settingsOpen) {
  ctx.fillStyle = '#182625';
  ctx.fillRect(0, 0, paletteWidth, paletteHeight);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = 'bold 51px sans-serif';
  ctx.fillStyle = '#f6f2df';
  ctx.fillText(settingsOpen ? 'Настройки' : 'WALLSPACE', 28, 53);
  ctx.fillStyle = '#aec6bb';
  ctx.font = '29px sans-serif';
  if (!settingsOpen) ctx.fillText('Цвет маркера', 28, 116);
  ctx.textAlign = 'center';
  for (const {id, color, label, x, y, w, h} of buttons) {
    const selected = active.includes(id);
    ctx.fillStyle = selected ? '#547d6f' : '#304844';
    ctx.fillRect(x, y, w, h);
    if (selected || id === hover) {
      ctx.strokeStyle = id === hover ? '#fff3c2' : '#a6e2c2';
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    }
    if (color) {
      ctx.fillStyle = color;
      ctx.strokeStyle = '#eae5cf';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, 23, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = '#f6f2df';
      ctx.font = label.length > 10 ? 'bold 27px sans-serif' : 'bold 34px sans-serif';
      ctx.fillText(label, x + w / 2, y + h / 2, w - 12);
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#c6d8cc';
  ctx.font = '30px sans-serif';
  if (settingsOpen) return;
  if (!controllersReady) {
    ctx.fillText('Возьми контроллеры', 28, protractor ? 1013 : 592, 544);
  } else if (protractor) {
    ctx.fillText('Фигуры и углы', 28, 595);
    ctx.font = '25px sans-serif';
    ctx.fillText('Наведи на доску и нажми триггер', 28, 1013, 544);
  } else if (ruler) {
    ctx.fillText('Потяни за круглый магнит', 28, 592, 544);
    ctx.fillText('Веди маркер рядом с кромкой', 28, 650, 544);
  } else {
    ctx.fillText('Хват: маркер на полке', 28, 592, 544);
    ctx.fillText('Стики: ходьба и поворот', 28, 643, 544);
  }
}

export function paintGuide(ctx, ruler, heldEnd, previews, color) {
  ctx.clearRect(0, 0, boardWidth, boardHeight);
  if (ruler) {
    // Draw the body to one side of the working edge so ink remains visible.
    const [[x, y], [bx, by]] = ruler;
    const angle = Math.atan2(by - y, bx - x);
    const distance = Math.hypot(bx - x, by - y);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = 'rgba(221, 176, 63, 0.36)';
    ctx.fillRect(0, 0, distance, 74);
    ctx.strokeStyle = '#65481a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(distance, 0);
    for (let i = 1; i * 20 < distance; i++) {
      const dx = i * 20;
      ctx.moveTo(dx, 1);
      ctx.lineTo(dx, i % 3 === 0 ? 26 : 14);
    }
    ctx.stroke();
    ctx.restore();
    if (heldEnd !== null) {
      ctx.fillStyle = 'rgba(67, 94, 81, 0.42)';
      for (let col = magneticStep; col < boardWidth; col += magneticStep) {
        for (let row = magneticStep; row < boardHeight; row += magneticStep) {
          ctx.fillRect(col - 2, row - 2, 4, 4);
        }
      }
    }
    ruler.forEach(([cx, cy], index) => {
      ctx.beginPath();
      ctx.arc(cx, cy, magnetReach - 7, 0, Math.PI * 2);
      ctx.fillStyle = heldEnd === index ? '#fbecaa' : '#e4ac44';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#65481a';
      ctx.stroke();
      ctx.fillStyle = '#493612';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), cx, cy);
    });
  }
  previews.forEach((preview, index) => {
    ctx.save();
    ctx.globalAlpha = index === 0 ? 1 : 0.55;
    paintFigurePreview(ctx, preview, color);
    ctx.restore();
  });
}

function paintFigurePreview(ctx, preview, color) {
  if (!preview.closed) {
    ctx.save();
    ctx.translate(...preview.anchor);
    ctx.fillStyle = 'rgba(87, 136, 121, 0.25)';
    ctx.strokeStyle = 'rgba(43, 94, 76, 0.70)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 161, Math.PI, 2 * Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    for (let degree = 0; degree <= 180; degree += 10) {
      const rad = degree * Math.PI / 180;
      const tick = degree % 30 === 0 ? 140 : 151;
      ctx.moveTo(tick * Math.cos(rad), -tick * Math.sin(rad));
      ctx.lineTo(160 * Math.cos(rad), -160 * Math.sin(rad));
    }
    ctx.stroke();
    ctx.fillStyle = '#34584d';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let degree = 0; degree <= 180; degree += 30) {
      const rad = degree * Math.PI / 180;
      ctx.fillText(String(degree), 123 * Math.cos(rad), -123 * Math.sin(rad) - 7);
    }
    ctx.restore();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  ctx.setLineDash([14, 9]);
  ctx.beginPath();
  ctx.moveTo(...preview.points[0]);
  for (const point of preview.points.slice(1)) ctx.lineTo(...point);
  if (preview.closed) ctx.closePath();
  ctx.stroke();
}
