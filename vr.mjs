import { forward, length, rayToPanel, sub, xyz } from './geometry.mjs';
import { boardHeight, boardWidth, figure, initialRuler, magnetReach, moveMagnet, projectToRuler } from './instruments.mjs';
import { makeRenderer } from './renderer.mjs?v=3';
import { buttonAt, createRoom, drawPointer, paintGuide, paintPalette, paletteButtons,
  paletteHeight, paletteWidth, renderRoom } from './vr-scene.mjs';

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d');
}

function isController(source) {
  return source.targetRayMode === 'tracked-pointer' && !source.hand;
}

function locate(frame, space, room, source) {
  const pose = frame.getPose(source.targetRaySpace, space)?.transform;
  if (!pose) return null;
  const origin = xyz(pose.position);
  const direction = forward(pose.orientation);
  const palette = rayToPanel(room.palette, origin, direction);
  if (palette) return {surface: room.palette, uv: palette, origin, direction};
  const board = rayToPanel(room.board, origin, direction);
  if (board) {
    return {surface: room.board, uv: board, origin, direction, point: [board[0] * boardWidth, board[1] * boardHeight]};
  }
  return {origin, direction};
}

export async function enterVR(board, onEnd, onFailure) {
  const session = await navigator.xr.requestSession('immersive-vr', {optionalFeatures: ['local-floor']});
  const listeners = new AbortController();
  const options = {signal: listeners.signal};
  let renderer;
  let closed = false;
  let failed = false;
  let ready = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    listeners.abort();
    board.endStroke();
    renderer?.destroy();
    if (ready && !failed) onEnd();
  }

  function fail(error) {
    if (failed || closed) return;
    failed = true;
    console.error(error);
    void session.end().catch(() => {}).finally(() => {
      cleanup();
      if (ready) onFailure();
    });
  }

  session.addEventListener('end', cleanup, {once: true});
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', {alpha: false, depth: true, antialias: true, xrCompatible: true});
    if (!gl) throw new Error('WebGL недоступен');
    await gl.makeXRCompatible();
    canvas.addEventListener('webglcontextlost', fail, options);
    if (closed) throw new Error('Сеанс уже завершён');
    renderer = makeRenderer(gl);
    const layer = new XRWebGLLayer(session, gl, {alpha: false, depth: true});
    session.updateRenderState({baseLayer: layer, depthNear: 0.025, depthFar: 25});
    let hasFloor = true;
    const space = await session.requestReferenceSpace('local-floor').catch(() => {
      hasFloor = false;
      return session.requestReferenceSpace('local');
    });
    if (closed || failed) throw new Error('Сеанс уже завершён');

    const paletteCanvas = makeCanvas(paletteWidth, paletteHeight);
    const guideCanvas = makeCanvas(boardWidth / 2, boardHeight / 2);
    guideCanvas.scale(0.5, 0.5);
    const guide = renderer.createTexture();
    let room = null;
    let drag = null;
    let preferredSource = null;
    let ruler = initialRuler();
    let rulerVisible = false;
    let protractor = false;
    let shape = '60';
    let buttons = paletteButtons(board.colors, protractor);
    let lastColor = board.colors[board.tool] ? board.tool : 'indigo';
    let inkRevision = -1;
    let paletteState = '';
    let guideState = '';

    function stopDrag() {
      if (drag?.type === 'ink') board.endStroke();
      drag = null;
    }

    function resetRoom() {
      stopDrag();
      room = null;
    }

    function choose(button) {
      const id = button.id;
      if (id === 'exit') {
        void session.end().catch(fail);
      } else if (id === 'undo') {
        board.undo();
      } else if (id === 'ruler') {
        rulerVisible = !rulerVisible;
        protractor = false;
      } else if (id === 'protractor') {
        protractor = !protractor;
        if (protractor) board.selectTool(lastColor);
      } else if (id.startsWith('shape:')) {
        shape = id.slice(6);
      } else {
        protractor = false;
        if (button.color) lastColor = id;
        board.selectTool(id);
      }
      buttons = paletteButtons(board.colors, protractor);
    }

    function begin(event, mode) {
      const {inputSource: source, frame} = event;
      if (!room || closed || failed || drag || !isController(source) || session.visibilityState !== 'visible') return;
      preferredSource = source;
      const hit = locate(frame, space, room, source);
      if (!hit?.surface) return;
      if (!hit.point) {
        const button = buttonAt(buttons, hit.uv);
        if (mode === 'select' && button) choose(button);
        return;
      }
      const end = rulerVisible ? ruler.findIndex(magnet => length(sub(magnet, hit.point)) <= magnetReach) : -1;
      if (end !== -1 && (mode === 'squeeze' || (!protractor && board.tool !== 'eraser'))) {
        drag = {source, mode, type: 'magnet', end};
      } else if (mode === 'select' && protractor) {
        board.stamp(figure(shape, hit.point));
      } else if (mode === 'select') {
        const snap = rulerVisible && board.tool !== 'eraser' && projectToRuler(ruler, hit.point).distance <= 47;
        drag = {source, mode, type: 'ink', snap, last: null};
        continueDrag(hit);
      }
    }

    function continueDrag(hit) {
      if (!hit?.point) {
        if (drag.type === 'ink') {
          board.endStroke();
          drag.last = null;
        }
        return;
      }
      if (drag.type === 'magnet') {
        ruler = moveMagnet(ruler, drag.end, hit.point);
        return;
      }
      const point = drag.snap ? projectToRuler(ruler, hit.point).point : hit.point;
      if (drag.last) {
        const movement = length(sub(point, drag.last));
        if (movement < 0.5) return;
        if (!drag.snap && movement > 270) board.endStroke();
      }
      board.stroke(point[0] / boardWidth, point[1] / boardHeight);
      drag.last = point;
    }

    function end(event, mode) {
      if (drag?.source === event.inputSource && drag.mode === mode) stopDrag();
    }

    session.addEventListener('selectstart', event => begin(event, 'select'), options);
    session.addEventListener('selectend', event => end(event, 'select'), options);
    session.addEventListener('squeezestart', event => begin(event, 'squeeze'), options);
    session.addEventListener('squeezeend', event => end(event, 'squeeze'), options);
    session.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible') stopDrag();
    }, options);
    space.addEventListener('reset', resetRoom, options);

    function tick(_time, frame) {
      if (closed || failed) return;
      try {
        session.requestAnimationFrame(tick);
        renderer.begin(layer);
        const pose = frame.getViewerPose(space);
        if (!pose || session.visibilityState !== 'visible') {
          stopDrag();
          return;
        }
        room ??= createRoom(pose.transform, hasFloor);
        const controllers = Array.from(session.inputSources).filter(isController);
        if (drag && !controllers.includes(drag.source)) stopDrag();
        const hits = controllers.map(source => ({source, hit: locate(frame, space, room, source)}));
        if (drag) continueDrag(hits.find(input => input.source === drag.source)?.hit);
        const pointer = (drag && hits.find(input => input.source === drag.source && input.hit)) ??
          hits.find(input => input.source === preferredSource && input.hit?.surface) ??
          hits.find(input => input.hit?.surface) ??
          hits.find(input => input.source === preferredSource && input.hit) ??
          hits.find(input => input.hit);
        const hover = pointer?.hit.surface === room.palette ? buttonAt(buttons, pointer.hit.uv)?.id : null;
        const active = [board.tool, rulerVisible && 'ruler', protractor && 'protractor',
          protractor && 'shape:' + shape];
        const nextPalette = JSON.stringify([active, hover, Boolean(controllers.length)]);
        if (paletteState !== nextPalette) {
          paletteState = nextPalette;
          paintPalette(paletteCanvas, buttons, active, hover, protractor, rulerVisible, Boolean(controllers.length));
          renderer.update(renderer.interfaceTexture, paletteCanvas.canvas);
        }
        const previewInputs = protractor ? hits.filter(input => input.hit?.point) : [];
        previewInputs.sort((a, b) => Number(b === pointer) - Number(a === pointer));
        const previews = previewInputs.map(input => figure(shape, input.hit.point));
        const shownRuler = rulerVisible ? ruler : null;
        const heldEnd = drag?.type === 'magnet' ? drag.end : null;
        const nextGuide = JSON.stringify([shownRuler, heldEnd, previews.map(preview => preview.anchor), protractor && shape, lastColor]);
        if (guideState !== nextGuide) {
          guideState = nextGuide;
          paintGuide(guideCanvas, shownRuler, heldEnd, previews, board.colors[lastColor]);
          renderer.update(guide, guideCanvas.canvas);
        }
        if (inkRevision !== board.revision) {
          inkRevision = board.revision;
          renderer.update(renderer.ink, board.canvas);
        }
        for (const view of pose.views) {
          if (!renderer.selectView(layer, view)) continue;
          renderRoom(renderer, room, guide);
          if (pointer) {
            const color = pointer.hit.surface === room.palette ? [1, 0.91, 0.59, 1] : [0.24, 0.48, 0.38, 1];
            drawPointer(renderer, pointer.hit, color);
          }
          for (const input of previewInputs) {
            if (input !== pointer) drawPointer(renderer, input.hit, [0.43, 0.61, 0.53, 1]);
          }
        }
      } catch (error) {
        fail(error);
      }
    }

    session.requestAnimationFrame(tick);
    ready = true;
  } catch (error) {
    if (!closed) await session.end().catch(() => {});
    cleanup();
    throw error;
  }
}
