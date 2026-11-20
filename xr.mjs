import { add, at, forward, inside, length, makeWall, mul, project, rayToPanel, sub, unit, cross, xyz } from './geometry.mjs';
import { makeRenderer } from './renderer.mjs';

const instructions = ['Верхний левый угол', 'Верхний правый угол', 'Нижний левый угол'];
const contact = 0.035;
const release = 0.055;
const paper = [0.98, 0.96, 0.92, 0.78];
const violet = [0.55, 0.42, 0.95, 0.93];

function instructionPanel(transform) {
  const direction = forward(transform.orientation);
  const horizontal = [direction[0], 0, direction[2]];
  const facing = length(horizontal) > 0.001 ? unit(horizontal) : [0, 0, -1];
  const right = cross(facing, [0, 1, 0]);
  const center = add(xyz(transform.position), mul(direction, 0.92));
  return {
    origin: add(add(center, mul(right, -0.38)), [0, -0.13, 0]),
    right, down: [0, -1, 0], normal: mul(facing, -1), width: 0.76, height: 0.15
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
    let pinched = new WeakMap();
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
      pinched = new WeakMap();
    };
    space.addEventListener('reset', reset);

    function updateHUD(title, detail, hovered) {
      const key = JSON.stringify([Boolean(wall), title, detail, board.tool, hovered]);
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
        paint.textAlign = 'left';
        paint.fillStyle = '#fff6ed';
        paint.font = 'bold 46px sans-serif';
        paint.fillText(title, 36, 62);
        paint.fillStyle = '#e5d7fa';
        paint.font = '34px sans-serif';
        paint.fillText(detail, 36, 130, hud.width - 72);
      }
      renderer.update(renderer.interfaceTexture, hud);
    }

    function toolbarHit(hand, frame) {
      const position = project(toolbar, hand.held ? hand.pinch : hand.tip);
      if (inside(position) && Math.abs(position[2]) < 0.11) return position;
      const ray = frame.getPose(hand.source.targetRaySpace, space)?.transform;
      return ray && rayToPanel(toolbar, xyz(ray.position), forward(ray.orientation));
    }

    function actionIndex(hit) {
      return Math.min(actions.length - 1, Math.floor(hit[0] * actions.length));
    }

    function markCorner(hand, viewer) {
      points.push(hand.pinch);
      message = '';
      if (points.length === 2 && length(sub(points[1], points[0])) < 0.25) {
        points.pop();
        message = 'Разнеси верхние углы хотя бы на 25 см';
      }
      if (points.length !== 3) return;
      wall = makeWall(...points, viewer);
      if (wall) {
        toolbar = toolbarPanel(wall);
        blockedHand = hand.source;
      } else {
        points = [];
        message = 'Отметь углы по порядку, начиная с верхнего левого';
      }
    }

    function drawWith(hand, hands) {
      const blocked = hands.find(input => input.source === blockedHand);
      if (!blocked || Math.abs(project(wall, blocked.tip)[2]) > release) blockedHand = null;
      if (!hand || hand.held || hand.source === blockedHand) {
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

    function tick(_time, frame) {
      if (stopped || failed) return;
      try {
        session.requestAnimationFrame(tick);
        renderer.begin(layer);
        const pose = frame.getViewerPose(space);
        if (!pose || session.visibilityState !== 'visible') {
          lift();
          pinched = new WeakMap();
          return;
        }
        const hands = Array.from(session.inputSources, source => readHand(frame, space, source, pinched)).filter(Boolean);
        const pressing = hands.find(hand => hand.pressed);
        const writingHand = hands.find(hand => hand.source === activeHand) ??
          (wall && hands.filter(hand => !hand.held && hand.source !== blockedHand)
            .map(hand => ({hand, pos: project(wall, hand.tip)}))
            .filter(({pos}) => inside(pos))
            .sort((a, b) => Math.abs(a.pos[2]) - Math.abs(b.pos[2]))[0]?.hand);

        if (wall) {
          const hit = pressing && toolbarHit(pressing, frame);
          if (hit) {
            lift();
            const action = actions[actionIndex(hit)];
            action.run();
            if (action.id === 'exit') return;
          } else {
            drawWith(writingHand, hands);
          }
        } else if (pressing) {
          markCorner(pressing, xyz(pose.transform.position));
        }

        const panel = wall ? toolbar : instructionPanel(pose.transform);
        const hovered = wall && hands.map(hand => toolbarHit(hand, frame)).find(Boolean);
        updateHUD(wall ? '' : (points.length + 1) + ' / 3   ' + instructions[points.length],
          message || (hands.length ? 'Отметь угол щипком у стены' : 'Подними руку перед собой'),
          hovered ? actionIndex(hovered) : null);
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
