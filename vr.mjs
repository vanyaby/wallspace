import { add, at, cross, dot, forward, length, mul, project, rayToPanel, sub, xyz } from './geometry.mjs';
import { boardHeight, boardWidth, figure, initialRuler, magnetReach, moveMagnet, projectToRuler } from './instruments.mjs';
import { makeRenderer } from './renderer.mjs?v=4';
import { adjustments, arrangeBoard, buttonAt, createRoom, drawPointer, paintGuide, paintPalette, paletteButtons,
  paletteHeight, paletteWidth, renderRoom } from './vr-scene.mjs?v=4';
import { clamp, constrainWalk, contactPoint, controls, drawMarker, flat, limits, loadSettings, markerPose, offsetSpace,
  pulse, rackPosition, rememberSettings, rotateY } from './workshop.mjs';

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
    const settings = loadSettings();
    let settingsOpen = false;
    let room = null;
    let activeSpace = space;
    let displacement = [0, 0, 0];
    let yaw = 0;
    let lastTime = null;
    let turnReady = true;
    let teleport = null;
    let teleportHeld = false;
    let home = false;
    let markerSource = null;
    let contact = null;
    let lastInk = null;
    let lastPulse = 0;
    let drag = null;
    let preferredSource = null;
    let ruler = initialRuler();
    let rulerVisible = false;
    let protractor = false;
    let shape = '60';
    let buttons = paletteButtons(board.colors, protractor, settingsOpen, settings);
    let lastColor = board.colors[board.tool] ? board.tool : 'indigo';
    let inkRevision = -1;
    let paletteState = '';
    let guideState = '';

    function stopDrag() {
      if (drag?.type === 'ink') board.endStroke();
      if (drag?.type === 'board') {
        rememberSettings(settings);
        buttons = paletteButtons(board.colors, protractor, settingsOpen, settings);
        paletteState = '';
      }
      drag = null;
    }

    function liftMarker() {
      if (contact) board.endStroke();
      contact = null;
      lastInk = null;
    }

    function resetRoom() {
      stopDrag();
      liftMarker();
      room = null;
      activeSpace = space;
      displacement = [0, 0, 0];
      yaw = 0;
      lastTime = null;
      teleport = null;
      teleportHeld = false;
    }

    function choose(button, source) {
      const id = button.id;
      liftMarker();
      if (id === 'exit') {
        void session.end().catch(fail);
      } else if (id === 'settings') {
        settingsOpen = !settingsOpen;
      } else if (id === 'marker') {
        markerSource = markerSource === source ? null : source;
        if (markerSource && board.tool === 'eraser') board.selectTool(lastColor);
        protractor = false;
      } else if (id === 'home') {
        home = true;
        settingsOpen = false;
      } else if (id === 'locked' || id === 'hold') {
        settings[id] = !settings[id];
      } else if (['seated', 'standing', 'drafting'].includes(id)) {
        if (!settings.locked) {
          const presets = {seated: [1.10, 12], standing: [1.42, 0], drafting: [1.10, 65]};
          [settings.height, settings.tilt] = presets[id];
        }
      } else if (settingsOpen) {
        const [name, sign] = id.split(':');
        const step = adjustments.find(([key]) => key === name)?.[2];
        const transform = ['height', 'tilt', 'yaw', 'distance', 'size'].includes(name);
        if (step && (!settings.locked || !transform)) {
          settings[name] = clamp(Number((settings[name] + (sign === '+' ? step : -step)).toFixed(3)), ...limits[name]);
        }
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
      if (settingsOpen || id === 'settings') rememberSettings(settings);
      arrangeBoard(room, settings);
      buttons = paletteButtons(board.colors, protractor, settingsOpen, settings);
      paletteState = '';
    }

    function gripPose(frame, source) {
      return (source.gripSpace && frame.getPose(source.gripSpace, activeSpace))?.transform;
    }

    function begin(event, mode) {
      const {inputSource: source, frame} = event;
      if (!room || closed || failed || drag || !isController(source) || session.visibilityState !== 'visible') return;
      preferredSource = source;
      const hit = locate(frame, activeSpace, room, source);
      if (mode === 'squeeze') {
        if (markerSource === source) {
          if (!settings.hold) {
            liftMarker();
            markerSource = null;
          }
          return;
        }
        const grip = gripPose(frame, source);
        if (grip) {
          const hand = xyz(grip.position);
          if (!settings.locked && room.handles.some(handle => length(sub(hand, handle)) < 0.12)) {
            liftMarker();
            drag = {source, mode, type: 'board', origin: hand, height: settings.height, distance: settings.distance};
            return;
          }
          const colors = Object.keys(board.colors);
          const index = colors.findIndex((_, i) => length(sub(hand, rackPosition(room.board, i, colors.length))) < 0.15);
          if (index >= 0) {
            liftMarker();
            markerSource = source;
            lastColor = colors[index];
            protractor = false;
            board.selectTool(lastColor);
            buttons = paletteButtons(board.colors, protractor, settingsOpen, settings);
            pulse(source, settings.haptics * 0.075, 30);
            return;
          }
        }
      }
      if (!hit?.surface) return;
      if (!hit.point) {
        const button = buttonAt(buttons, hit.uv);
        if (mode === 'select' && button) choose(button, source);
        return;
      }
      const end = rulerVisible ? ruler.findIndex(magnet => length(sub(magnet, hit.point)) <= magnetReach) : -1;
      if (end !== -1 && (mode === 'squeeze' || (!protractor && board.tool !== 'eraser'))) {
        drag = {source, mode, type: 'magnet', end};
      } else if (mode === 'select' && protractor) {
        board.stamp(figure(shape, hit.point));
      } else if (mode === 'select' && source !== markerSource) {
        liftMarker();
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
        const next = moveMagnet(ruler, drag.end, hit.point);
        if (next !== ruler) pulse(drag.source, settings.haptics * 0.06, 24);
        ruler = next;
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
      if (mode === 'squeeze' && settings.hold && event.inputSource === markerSource) {
        liftMarker();
        markerSource = null;
      }
    }

    session.addEventListener('selectstart', event => begin(event, 'select'), options);
    session.addEventListener('selectend', event => end(event, 'select'), options);
    session.addEventListener('squeezestart', event => begin(event, 'squeeze'), options);
    session.addEventListener('squeezeend', event => end(event, 'squeeze'), options);
    session.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible') {
        stopDrag();
        liftMarker();
        lastTime = null;
        teleport = null;
        teleportHeld = false;
      }
    }, options);
    space.addEventListener('reset', resetRoom, options);

    function navigate(time, frame, pose, controllers) {
      const dt = lastTime === null ? 0 : clamp((time - lastTime) / 1000, 0, 0.05);
      lastTime = time;
      const left = controllers.find(source => source.handedness === 'left');
      const right = controllers.find(source => source.handedness === 'right');
      const [moveX, moveY] = controls(left);
      const [turn, jump] = controls(right);
      const eye = xyz(pose.transform.position);
      const direction = flat(forward(pose.transform.orientation), room.ahead);
      const sideways = cross(direction, [0, 1, 0]);
      const floor = room.solids[0][0];
      const aiming = jump > 0.58;
      const ray = aiming && right && frame.getPose(right.targetRaySpace, activeSpace)?.transform;
      let destination = null;
      if (ray) {
        const origin = xyz(ray.position);
        const direction = forward(ray.orientation);
        const uv = rayToPanel(floor, origin, direction);
        if (uv && uv[0] > 0.06 && uv[0] < 0.94 && uv[1] > 0.06 && uv[1] < 0.94) {
          destination = {surface: floor, uv, origin, direction};
        }
      }
      let next = eye;
      if (home && !contact) {
        const point = at(room.board, 0.5, 0.5);
        next = [point[0] - room.ahead[0] * 0.95, eye[1], point[2] - room.ahead[2] * 0.95];
        home = false;
      } else if (teleportHeld && !aiming && teleport && !contact) {
        const point = at(floor, ...teleport.uv);
        next = [point[0], eye[1], point[2]];
      } else if (!contact && !aiming && (moveX || moveY)) {
        const motion = add(mul(sideways, moveX), mul(direction, -moveY));
        next = add(eye, mul(motion, dt * settings.speed / Math.max(1, length(motion))));
      }
      teleportHeld = aiming;
      teleport = destination;
      if (next !== eye) next = constrainWalk(room, eye, next);
      let turnBy = 0;
      if (!aiming && Math.abs(turn) < 0.22) turnReady = true;
      if (!contact && !aiming && turnReady && Math.abs(turn) > 0.65) {
        turnReady = false;
        turnBy = -Math.sign(turn) * Math.PI / 6;
      }
      if (turnBy || next !== eye) {
        yaw += turnBy;
        displacement = add(next, rotateY(sub(displacement, eye), turnBy));
        activeSpace = offsetSpace(space, displacement, yaw);
      }
    }

    function writeWithMarker(time, frame, controllers) {
      if (markerSource && !controllers.includes(markerSource)) markerSource = null;
      const grip = markerSource && gripPose(frame, markerSource);
      if (!grip) {
        liftMarker();
        return null;
      }
      const model = markerPose(grip, settings[markerSource.handedness === 'left' ? 'gripLeft' : 'gripRight']);
      const sample = !protractor && !settingsOpen && drag?.type !== 'ink' &&
        dot(model.axis, room.board.normal) < -0.04 && project(room.board, xyz(grip.position))[2] > 0 &&
        contactPoint(room.board, model.tip, contact, settings.resistance);
      if (!sample) {
        liftMarker();
        return model;
      }
      const starting = !contact || sample.restart;
      if (sample.restart) board.endStroke();
      if (starting || length(sub(sample.ink, lastInk)) > 0.00036) {
        board.stroke(...sample.ink);
        lastInk = sample.ink;
        if (starting || (length(sample.delta) > 0.0006 && time - lastPulse > 55)) {
          pulse(markerSource, settings.haptics * (starting ? 0.09 : 0.035), starting ? 28 : 18);
          lastPulse = time;
        }
      }
      contact = sample;
      return {...model, tip: at(room.board, ...sample.ink, 0.004)};
    }

    function tick(time, frame) {
      if (closed || failed) return;
      try {
        session.requestAnimationFrame(tick);
        renderer.begin(layer);
        let pose = frame.getViewerPose(activeSpace);
        if (!pose || session.visibilityState !== 'visible') {
          stopDrag();
          liftMarker();
          lastTime = null;
          return;
        }
        if (!room) {
          room = createRoom(pose.transform, hasFloor);
          arrangeBoard(room, settings);
        }
        const controllers = Array.from(session.inputSources).filter(isController);
        const beforeMove = activeSpace;
        navigate(time, frame, pose, controllers);
        if (beforeMove !== activeSpace) {
          pose = frame.getViewerPose(activeSpace);
          if (!pose) return;
        }
        if (drag && !controllers.includes(drag.source)) stopDrag();
        const hits = controllers.map(source => ({source, hit: locate(frame, activeSpace, room, source)}));
        if (drag?.type === 'board') {
          const grip = gripPose(frame, drag.source);
          if (grip) {
            const movement = sub(xyz(grip.position), drag.origin);
            settings.height = clamp(drag.height + movement[1], ...limits.height);
            settings.distance = clamp(drag.distance + dot(movement, room.ahead), ...limits.distance);
            arrangeBoard(room, settings);
          } else {
            stopDrag();
          }
        } else if (drag) continueDrag(hits.find(input => input.source === drag.source)?.hit);
        const marker = writeWithMarker(time, frame, controllers);
        const pointer = (drag && hits.find(input => input.source === drag.source && input.hit)) ??
          hits.find(input => input.source === preferredSource && input.hit?.surface) ??
          hits.find(input => input.hit?.surface) ??
          hits.find(input => input.source === preferredSource && input.hit) ??
          hits.find(input => input.hit);
        const hover = pointer?.hit.surface === room.palette ? buttonAt(buttons, pointer.hit.uv)?.id : null;
        const active = [board.tool, rulerVisible && 'ruler', protractor && 'protractor',
          protractor && 'shape:' + shape, markerSource && 'marker', settingsOpen && 'locked:' + settings.locked];
        const nextPalette = JSON.stringify([active, hover, Boolean(controllers.length)]);
        if (paletteState !== nextPalette) {
          paletteState = nextPalette;
          paintPalette(paletteCanvas, buttons, active, hover, protractor, rulerVisible, Boolean(controllers.length), settingsOpen);
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
          if (teleport) drawPointer(renderer, teleport, [0.95, 0.79, 0.38, 1]);
          const colors = Object.entries(board.colors);
          colors.forEach(([id, color], i) => {
            if (!markerSource || id !== lastColor) {
              const base = rackPosition(room.board, i, colors.length);
              drawMarker(renderer, {axis: [0, 1, 0], tip: add(base, [0, 0.18, 0])}, color);
            }
          });
          if (marker) drawMarker(renderer, marker, board.colors[lastColor]);
          if (pointer && (pointer.source !== markerSource || pointer.hit.surface === room.palette || protractor)) {
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
