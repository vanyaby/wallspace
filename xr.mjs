import { add, at, forward, inside, length, makeWall, mul, project, rayToPanel, sub, unit, cross, xyz } from './geometry.mjs';
import { makeRenderer } from './renderer.mjs';

const instructions = ['Верхний левый угол', 'Верхний правый угол', 'Нижний левый угол'];
const contact = 0.035;
const release = 0.055;
const paper = [0.98, 0.96, 0.92, 0.78];
const violet = [0.55, 0.42, 0.95, 0.93];
const confirmButton = {left: 0.25, right: 0.75, top: 0.60, bottom: 0.93};
const sampleWindow = 110;
const stableDuration = 42;
const maxDrift = 0.02;

function handKey(source) {
  return source.handedness === 'left' || source.handedness === 'right' ? source.handedness : source;
}

function instructionPanel(transform) {
  const direction = forward(transform.orientation);
  const horizontal = [direction[0], 0, direction[2]];
  const facing = length(horizontal) > 0.001 ? unit(horizontal) : [0, 0, -1];
  const right = cross(facing, [0, 1, 0]);
  const center = add(xyz(transform.position), mul(direction, 0.92));
  return {
    origin: add(add(center, mul(right, -0.46)), [0, -0.08, 0]),
    right, down: [0, -1, 0], normal: mul(facing, -1), width: 0.92, height: 0.24
  };
}

function toolbarPanel(wall) {
  const width = Math.max(0.8, Math.min(wall.width, 1.3));
  return {
    ...wall,
    origin: at(wall, (1 - width / wall.width) / 2, -0.17 / wall.height, 0.035),
    width,
    height: 0.135
  };
}

function marker(panel, point, size) {
  return {
    ...panel,
    origin: sub(point, mul(add(panel.right, panel.down), size / 2)),
    width: size, height: size
  };
}

function readHand(frame, space, source, pinched) {
  const hand = source.hand;
  if (!hand) return null;
  const joints = [hand.get('index-finger-tip'), hand.get('thumb-tip')];
  const [index, thumb] = joints.map(joint => joint && frame.getJointPose(joint, space));
  if (!index || !thumb) {
    pinched.delete(source);
    return null;
  }
  const tip = xyz(index.transform.position);
  const thumbTip = xyz(thumb.transform.position);
  const distance = length(sub(tip, thumbTip));
  const previous = pinched.get(source);
  const held = distance < (previous ? 0.033 : 0.023);
  pinched.set(source, held);
  return {source, tip, pinch: mul(add(tip, thumbTip), 0.5), held, pressed: previous === false && held};
}

export async function enterMR(board, onEnd, onFailure) {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local', 'hand-tracking']
  });
  let renderer;
  let stopped = false;
  let ready = false;
  let failed = false;
  let canvas;
  let space;
  let reset;
  function cleanup() {
    if (stopped) return;
    stopped = true;
    board.endStroke();
    space?.removeEventListener('reset', reset);
    canvas?.removeEventListener('webglcontextlost', renderFailure);
    renderer?.destroy();
    if (ready && !failed) onEnd();
  }
  function renderFailure(error) {
    if (failed || stopped) return;
    failed = true;
    console.error(error);
    void session.end().catch(() => {}).finally(() => {
      cleanup();
      if (ready) onFailure();
    });
  }
  session.addEventListener('end', cleanup, {once: true});

  try {
    canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', {alpha: true, antialias: true, xrCompatible: true});
    if (!gl) throw new Error('WebGL недоступен');
    await gl.makeXRCompatible();
    if (stopped) throw new Error('Сеанс уже завершён');
    canvas.addEventListener('webglcontextlost', renderFailure);
    renderer = makeRenderer(gl);
    const layer = new XRWebGLLayer(session, gl, {alpha: true});
    session.updateRenderState({baseLayer: layer, depthNear: 0.035, depthFar: 40});
    space = await session.requestReferenceSpace('local');
    if (stopped || failed) throw new Error('Сеанс уже завершён');

    const hud = document.createElement('canvas');
    hud.width = 1024;
    hud.height = 192;
    const paint = hud.getContext('2d');
    const actions = [
      ...Object.entries(board.colors).map(([id, color]) => ({id, color, run: () => board.selectTool(id)})),
      {id: 'eraser', title: 'Ластик', run: () => board.selectTool(board.tool === 'eraser' ? 'indigo' : 'eraser')},
      {title: 'Отмена', run: board.undo},
      {title: 'Углы', run: () => reset()},
      {id: 'exit', title: 'Выход', run: () => void session.end().catch(renderFailure)}
    ];
    let wall = null;
    let toolbar = null;
    let points = [];
    let message = '';
    let activeHand = null;
    let lastPoint = null;
    let blockedHand = null;
    const pinched = new Map();
    const fingertipSamples = new Map();
    let displayedText = '';
    let displayedRevision = -1;

    function lift() {
      activeHand = null;
      lastPoint = null;
      board.endStroke();
    }

    reset = () => {
      lift();
      wall = toolbar = blockedHand = null;
      points = [];
      message = '';
      pinched.clear();
      fingertipSamples.clear();
    };
    space.addEventListener('reset', reset);

    function updateHUD(title, detail, hovered, confirmation) {
      const key = JSON.stringify([Boolean(wall), title, detail, board.tool, hovered, confirmation]);
      if (key === displayedText) return;
      displayedText = key;
      paint.clearRect(0, 0, hud.width, hud.height);
      paint.fillStyle = '#25273a';
      paint.fillRect(0, 0, hud.width, hud.height);
      paint.textBaseline = 'middle';
      if (wall) {
        const cell = hud.width / actions.length;
        actions.forEach(({id, color, title: label}, index) => {
          const x = index * cell;
          paint.fillStyle = index === hovered ? '#756391' : id === board.tool ? '#5d527a' : '#35374e';
          paint.fillRect(x + 4, 14, cell - 8, 164);
          if (color) {
            paint.fillStyle = color;
            paint.strokeStyle = '#fff6ed';
            paint.lineWidth = 4;
            paint.beginPath();
            paint.arc(x + cell / 2, 96, 36, 0, 2 * Math.PI);
            paint.fill();
            paint.stroke();
          } else {
            paint.fillStyle = '#fff6ed';
            paint.font = 'bold 32px sans-serif';
            paint.textAlign = 'center';
            paint.fillText(label, x + cell / 2, 96);
          }
        });
      } else {
        paint.textAlign = 'center';
        paint.fillStyle = '#fff6ed';
        paint.font = 'bold 40px sans-serif';
        paint.fillText(title, hud.width / 2, 36);
        paint.fillStyle = '#e5d7fa';
        paint.font = '30px sans-serif';
        paint.fillText(detail, hud.width / 2, 84, hud.width - 40);
        const {left, right, top, bottom} = confirmButton;
        paint.fillStyle = confirmation?.ready ? (confirmation.hovered ? '#fff6ed' : '#e5d7fa') : '#41445c';
        paint.fillRect(left * hud.width, top * hud.height, (right - left) * hud.width, (bottom - top) * hud.height);
        paint.fillStyle = confirmation?.ready ? '#25273a' : '#e5d7fa';
        paint.font = 'bold 34px sans-serif';
        paint.fillText('Записать точку', hud.width / 2, (top + bottom) * hud.height / 2);
      }
      renderer.update(renderer.interfaceTexture, hud);
    }

    function panelHit(panel, hand, frame) {
      const position = project(panel, hand.held ? hand.pinch : hand.tip);
      if (inside(position) && Math.abs(position[2]) < 0.11) return position;
      const ray = frame.getPose(hand.source.targetRaySpace, space)?.transform;
      return ray && rayToPanel(panel, xyz(ray.position), forward(ray.orientation));
    }

    function actionIndex(hit) {
      return Math.min(actions.length - 1, Math.floor(hit[0] * actions.length));
    }

    function markCorner({point, key}, viewer) {
      points.push(point);
      fingertipSamples.clear();
      message = '';
      if (points.length === 2 && length(sub(points[1], points[0])) < 0.25) {
        points.pop();
        message = 'Разнеси верхние углы хотя бы на 25 см';
      }
      if (points.length !== 3) return;
      wall = makeWall(...points, viewer);
      if (wall) {
        toolbar = toolbarPanel(wall);
        blockedHand = key;
      } else {
        points = [];
        message = 'Отметь углы по порядку, начиная с верхнего левого';
      }
    }

    function calibrate(hands, panel, frame, time, viewer) {
      for (const [key, history] of fingertipSamples) {
        const recent = history.filter(sample => time - sample.time <= sampleWindow);
        if (recent.length) fingertipSamples.set(key, recent);
        else fingertipSamples.delete(key);
      }
      for (const hand of hands) {
        const key = handKey(hand.source);
        if (hand.held) {
          fingertipSamples.delete(key);
          continue;
        }
        let samples = fingertipSamples.get(key) ?? [];
        if (samples.some(sample => length(sub(sample.point, hand.tip)) > maxDrift)) samples = [];
        samples.push({point: hand.tip, time});
        fingertipSamples.set(key, samples);
      }
      // Keep a stable fingertip briefly if the cameras lose it right at the wall.
      const probes = [];
      for (const [key, samples] of fingertipSamples) {
        if (samples.length < 3 || samples.at(-1).time - samples[0].time < stableDuration) continue;
        const total = samples.reduce((sum, sample) => add(sum, sample.point), [0, 0, 0]);
        probes.push({key, point: mul(total, 1 / samples.length)});
      }
      const targets = hands.filter(hand => {
        const hit = panelHit(panel, hand, frame);
        return hit && hit[0] >= confirmButton.left && hit[0] <= confirmButton.right &&
          hit[1] >= confirmButton.top && hit[1] <= confirmButton.bottom;
      });
      const otherProbe = hand => probes.find(probe => probe.key !== handKey(hand.source));
      const pressedTarget = targets.find(hand => hand.pressed && otherProbe(hand));
      if (pressedTarget) {
        markCorner(otherProbe(pressedTarget), viewer);
        return {hovered: false, ready: false, aiming: false};
      }
      const hovered = targets.some(otherProbe);
      return {hovered, ready: hovered || (!targets.length && hands.some(otherProbe)), aiming: targets.length > 0};
    }

    function drawWith(hand, hands) {
      const blocked = hands.find(input => handKey(input.source) === blockedHand);
      if (blocked && Math.abs(project(wall, blocked.tip)[2]) > release) blockedHand = null;
      if (!hand || hand.held || handKey(hand.source) === blockedHand) {
        lift();
        return;
      }
      const pos = project(wall, hand.tip);
      const continuing = activeHand === hand.source;
      if (!inside(pos) || Math.abs(pos[2]) > (continuing ? release : contact)) {
        lift();
        return;
      }
      if (!continuing || (lastPoint && length(sub(lastPoint, hand.tip)) > 0.12)) lift();
      activeHand = hand.source;
      lastPoint = hand.tip;
      board.stroke(pos[0], pos[1]);
    }

    function tick(time, frame) {
      if (stopped || failed) return;
      try {
        session.requestAnimationFrame(tick);
        renderer.begin(layer);
        const pose = frame.getViewerPose(space);
        if (!pose || session.visibilityState !== 'visible') {
          lift();
          pinched.clear();
          fingertipSamples.clear();
          return;
        }
        const sources = Array.from(session.inputSources);
        for (const source of pinched.keys()) {
          if (!sources.includes(source)) pinched.delete(source);
        }
        const hands = sources.map(source => readHand(frame, space, source, pinched)).filter(Boolean);
        const pressing = hands.find(hand => hand.pressed);
        const writingHand = hands.find(hand => hand.source === activeHand) ??
          (wall && hands.filter(hand => !hand.held && handKey(hand.source) !== blockedHand)
            .map(hand => ({hand, pos: project(wall, hand.tip)}))
            .filter(({pos}) => inside(pos))
            .sort((a, b) => Math.abs(a.pos[2]) - Math.abs(b.pos[2]))[0]?.hand);

        let placementPanel;
        let confirmation;
        if (wall) {
          const hit = pressing && panelHit(toolbar, pressing, frame);
          if (hit) {
            lift();
            const action = actions[actionIndex(hit)];
            action.run();
            if (action.id === 'exit') return;
          } else {
            drawWith(writingHand, hands);
          }
        } else {
          placementPanel = instructionPanel(pose.transform);
          confirmation = calibrate(hands, placementPanel, frame, time, xyz(pose.transform.position));
        }

        const panel = wall ? toolbar : placementPanel ?? instructionPanel(pose.transform);
        const hovered = wall && hands.map(hand => panelHit(toolbar, hand, frame)).find(Boolean);
        const detail = confirmation?.hovered ? 'Сделай щипок другой рукой' : confirmation?.aiming
          ? 'Подержи указательный палец у стены'
          : 'Палец у стены · другой рукой наведи на кнопку';
        updateHUD(wall ? '' : (points.length + 1) + ' / 3   ' + instructions[points.length],
          wall ? '' : message || detail, hovered ? actionIndex(hovered) : null, wall ? null : confirmation);
        if (wall && board.revision !== displayedRevision) {
          displayedRevision = board.revision;
          renderer.update(renderer.ink, board.canvas);
        }
        for (const view of pose.views) {
          if (!renderer.selectView(layer, view)) continue;
          if (wall) {
            renderer.draw(wall, renderer.ink, paper, 0.007, 0.01);
            if (writingHand) {
              const pos = project(wall, writingHand.tip);
              if (inside(pos) && Math.abs(pos[2]) < 0.1) {
                const point = at(wall, pos[0], pos[1], 0.014);
                renderer.draw(marker(wall, point, 0.009), renderer.empty, violet);
              }
            }
          } else {
            for (const point of points) renderer.draw(marker(panel, point, 0.016), renderer.empty, violet);
          }
          renderer.draw(panel, renderer.interfaceTexture, [0, 0, 0, 0]);
        }
      } catch (error) {
        renderFailure(error);
      }
    }

    session.requestAnimationFrame(tick);
    ready = true;
  } catch (error) {
    if (!stopped) await session.end().catch(() => {});
    cleanup();
    throw error;
  }
}
