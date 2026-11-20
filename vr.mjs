import { add, at, cross, dot, forward, inside, length, mul, project, rayToPanel, sub, xyz } from './geometry.mjs';
import { boardHeight, boardWidth, figure, initialRuler, magnetReach, moveMagnet, moveRuler, projectToRuler } from './instruments.mjs?v=5';
import { makeRenderer } from './renderer.mjs?v=5';
import { adjustments, arrangeBoard, buttonAt, createRoom, drawPointer, paintGuide, paintPalette, paletteButtons,
  paletteHeight, paletteWidth, renderRoom } from './vr-scene.mjs?v=5';
import { clamp, constrainWalk, contactPoint, controls, drawMarker, flat, limits, loadSettings, markerPose, offsetSpace,
  placementKeys, pulse, rackPosition, rememberSettings, rotateY } from './workshop.mjs?v=5';
import { createSound, drawArc, drawBox, drawProtractor, drawRuler, drawSphere, drawVignette, makePanel, paintWrist,
  teleportArc, wristActions, wristPanel } from './accessories.mjs?v=6';

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
  const sound = createSound();
  const session = await navigator.xr.requestSession('immersive-vr', {optionalFeatures: ['local-floor']}).catch(error => {
    sound?.close();
    throw error;
  });
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
    sound?.close();
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
    const grid = renderer.createTexture(), wristTexture = renderer.createTexture();
    const practiceTexture = renderer.createTexture(), vignette = renderer.createTexture(), shadow = renderer.createTexture();
    const trial = makeCanvas(680, 310);
    const gridCanvas = makeCanvas(720, 480);
    const wristCanvas = makeCanvas(512, 320);
    const shade = makeCanvas(128, 128);
    const gradient = shade.createRadialGradient(64, 64, 22, 64, 64, 65);
    gradient.addColorStop(0, '#0a131900');
    gradient.addColorStop(0.55, '#0a131932');
    gradient.addColorStop(1, '#0a1319f6');
    shade.fillStyle = gradient;
    shade.fillRect(0, 0, 128, 128);
    renderer.update(vignette, shade.canvas);
    shade.clearRect(0, 0, 128, 128);
    const penShadow = shade.createRadialGradient(64, 64, 3, 64, 64, 64);
    penShadow.addColorStop(0, '#27332d59');
    penShadow.addColorStop(0.45, '#27332d29');
    penShadow.addColorStop(1, '#27332d00');
    shade.fillStyle = penShadow;
    shade.fillRect(0, 0, 128, 128);
    renderer.update(shadow, shade.canvas);
    paintWrist(wristCanvas);
    renderer.update(wristTexture, wristCanvas.canvas);
    const settings = loadSettings();
    let settingsPage = 0;
    let settingsOpen = false;
    let confirmClear = false;
    let boardGrid = null;
    let trialDirty = true;
    let wrist = null;
    let wristLatch = false;
    let shadeAmount = 0;
    let velocity = [0, 0, 0];
    let calibration = null;
    let room = null;
    let activeSpace = space;
    let displacement = [0, 0, 0];
    let yaw = 0;
    let lastTime = null;
    let turnReady = true;
    let teleport = null;
    let teleportHeld = false;
    let home = false;
    const heldTools = new Map();
    const hoveredPickups = new Map();
    let writingSource = null;
    let contact = null;
    let contactSurface = null;
    let contactSnap = false;
    let lastInk = null;
    let lastPulse = 0;
    let drag = null;
    let preferredSource = null;
    let ruler = settings.ruler ?? initialRuler();
    let rulerVisible = settings.rulerVisible ?? false;
    let protractor = false;
    let shape = 'angle';
    let construction = null;
    let adjustFigure = null;
    let buttons;
    let lastColor = settings.color;
    board.selectTool(lastColor);
    let inkRevision = -1;
    let paletteState = '';
    let guideState = '';

    function refreshButtons() {
      buttons = paletteButtons(board.colors, protractor, settingsOpen, settings, settingsPage, confirmClear);
      paletteState = '';
    }
    refreshButtons();

    function resetTrial() {
      trial.clearRect(0, 0, 680, 310);
      trial.globalCompositeOperation = 'source-over';
      trial.fillStyle = '#77847d';
      trial.font = '29px sans-serif';
      trial.fillText('Проба пера', 20, 43);
      trialDirty = true;
    }
    resetTrial();

    function stopDrag() {
      if (drag?.type === 'ink') board.endStroke();
      if (drag?.type === 'magnet') {
        settings.ruler = ruler;
        rememberSettings(settings);
      }
      if (drag?.type === 'board') {
        rememberSettings(settings);
        refreshButtons();
      }
      drag = null;
    }

    function liftMarker() {
      if (contact) board.endStroke();
      contact = null;
      contactSurface = null;
      contactSnap = false;
      lastInk = null;
      writingSource = null;
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
      velocity = [0, 0, 0];
      wrist = null;
      hoveredPickups.clear();
    }

    function choose(button, source) {
      const id = button.id;
      if (['undo', 'clear', 'return', 'calibrate'].includes(id)) liftMarker();
      if (id !== 'clear') confirmClear = false;
      if (id !== 'calibrate') calibration = null;
      if (id === 'exit') {
        void session.end().catch(fail);
      } else if (id === 'undo') {
        board.undo();
      } else if (id === 'settings') {
        settingsOpen = !settingsOpen;
      } else if (id === 'locomotion') {
        settingsOpen = true;
        settingsPage = 2;
      } else if (id.startsWith('page:')) {
        settingsPage = Number(id.slice(5));
      } else if (id === 'marker' || id === 'sponge') {
        const slot = id === 'sponge' ? 'sponge' : settings.nib === 'chisel' ? 'wide' : lastColor;
        const item = rackTools().find(tool => tool.slot === slot);
        if (heldTools.get(source)?.slot === slot) returnTool(source);
        else takeTool(source, item, false);
      } else if (id === 'return') {
        heldTools.clear();
        protractor = false;
        rulerVisible = false;
        ruler = initialRuler();
        settings.ruler = ruler;
        construction = adjustFigure = null;
        sound?.play('click', settings.volume);
      } else if (id === 'clearPractice') {
        resetTrial();
      } else if (id === 'clear') {
        if (confirmClear) board.clear();
        confirmClear = !confirmClear;
      } else if (id === 'nib') {
        settings.nib = settings.nib === 'chisel' ? 'round' : 'chisel';
        const held = heldTools.get(source);
        if (held && !held.sponge) held.wide = settings.nib === 'chisel';
      } else if (id === 'calibrate') {
        const hand = [...heldTools].find(([, tool]) => !tool.sponge)?.[0] ?? source;
        if (!heldTools.has(hand) || heldTools.get(hand).sponge) {
          takeTool(hand, rackTools().find(tool => !tool.sponge && !ownerOf(tool.slot)), false);
        }
        settingsOpen = false;
        calibration = heldTools.has(hand) && !heldTools.get(hand).sponge ? hand : null;
      } else if (id.startsWith('anglePreset:')) {
        settings.angle = Number(id.split(':')[1]);
      } else if (id === 'personalSave') {
        settings.personal = Object.fromEntries(placementKeys.map(key => [key, settings[key]]));
        sound?.play('click', settings.volume);
      } else if (id === 'personalLoad') {
        if (!settings.locked && settings.personal) Object.assign(settings, settings.personal);
      } else if (id === 'resetPlacement') {
        if (!settings.locked) Object.assign(settings, {height: 1.4, tilt: 0, yaw: 0, distance: 2.12, shift: 0, size: 1});
        home = true;
      } else if (id === 'home') {
        home = true;
        settingsOpen = false;
      } else if (['locked', 'hold', 'magnetic', 'freeze', 'directional', 'trayLeft'].includes(id)) {
        settings[id] = !settings[id];
      } else if (['seated', 'standing', 'drafting'].includes(id)) {
        if (!settings.locked) {
          const presets = {seated: [1.10, 12], standing: [1.42, 0], drafting: [1.10, 65]};
          [settings.height, settings.tilt] = presets[id];
        }
      } else if (settingsOpen) {
        const [name, sign] = id.split(':');
        const step = adjustments.find(([key]) => key === name)?.[2];
        const transform = placementKeys.includes(name);
        if (step && (!settings.locked || !transform)) {
          const increment = name === 'angle' ? settings.angleStep : step;
          settings[name] = clamp(Number((settings[name] + (sign === '+' ? increment : -increment)).toFixed(3)), ...limits[name]);
        }
      } else if (id === 'ruler') {
        rulerVisible = !rulerVisible;
        protractor = false;
      } else if (id === 'protractor') {
        protractor = !protractor;
        construction = adjustFigure = null;
        if (protractor) board.selectTool(lastColor);
      } else if (id.startsWith('shape:')) {
        shape = id.slice(6);
      } else {
        protractor = false;
        if (button.color) {
          settings.color = lastColor = id;
          const held = heldTools.get(source);
          if (held && !held.sponge) {
            if (writingSource === source) liftMarker();
            held.id = id;
          }
        } else if (id === 'eraser' && heldTools.has(source)) {
          returnTool(source);
        }
        if (writingSource) liftMarker();
        board.selectTool(id);
      }
      settings.rulerVisible = rulerVisible;
      rememberSettings(settings);
      arrangeBoard(room, settings);
      refreshButtons();
    }

    function gripPose(frame, source) {
      return (source.gripSpace && frame.getPose(source.gripSpace, activeSpace))?.transform;
    }

    function flatPoint(grip, maxDepth = 0.18) {
      if (!grip) return null;
      const [u, v, depth] = project(room.board, xyz(grip.position));
      return Math.abs(depth) <= maxDepth ? [u * boardWidth, v * boardHeight] : null;
    }

    function gripKey(source) {
      return source.handedness === 'left' ? 'Left' : 'Right';
    }

    function spongeDock() {
      return at(room.board, settings.trayLeft ? 0.18 : 0.82, 1.045, 0.13);
    }

    function rackTools() {
      const markers = [...Object.keys(board.colors).map(id => ({slot: id, id, wide: false})),
        {slot: 'wide', id: lastColor, wide: true}];
      return [...markers.map((item, i) => {
        const base = rackPosition(room.board, i, markers.length, settings.trayLeft);
        return {...item, base, center: add(base, [0, 0.09, 0]), height: 0.17};
      }), {slot: 'sponge', sponge: true, center: add(spongeDock(), [0, 0.029, 0]), height: 0}];
    }

    function ownerOf(slot) {
      for (const [source, item] of heldTools) if (item.slot === slot) return source;
      return null;
    }

    function returnTool(source) {
      if (!heldTools.delete(source)) return;
      if (writingSource === source) liftMarker();
      if (calibration === source) calibration = null;
      pulse(source, settings.haptics * 0.055, 22);
      sound?.play('click', settings.volume);
    }

    function takeTool(source, item, byGrip) {
      if (!item || (ownerOf(item.slot) && ownerOf(item.slot) !== source)) return false;
      if (writingSource === source) liftMarker();
      if (calibration === source) calibration = null;
      heldTools.set(source, {slot: item.slot, id: item.id, sponge: item.sponge, wide: item.wide,
        momentary: byGrip && settings.hold});
      if (!item.sponge) {
        settings.color = lastColor = item.id;
        settings.nib = item.wide ? 'chisel' : 'round';
        rememberSettings(settings);
      }
      pulse(source, settings.haptics * 0.09, 30);
      sound?.play('click', settings.volume);
      return true;
    }

    function pickupTargets(rack) {
      return [...rack,
        {slot: 'rulerHook', action: 'ruler', center: at(room.board, -0.13, 0.36, 0.065), height: 0.23},
        {slot: 'protractorHook', action: 'protractor', center: at(room.board, -0.13, 0.63, 0.065), height: 0.08}];
    }

    function pickupFor(source, grip, hit, items) {
      const hand = grip ? xyz(grip.position) : hit?.origin;
      const available = items.filter(item => !ownerOf(item.slot));
      const previous = hoveredPickups.get(source);
      const order = ({item, distance}) => distance - (item.slot === previous ? 0.018 : 0);
      if (hand) {
        const nearby = available.map(item => {
          const delta = sub(hand, item.center);
          delta[1] = Math.max(0, Math.abs(delta[1]) - item.height / 2);
          return {item, distance: length(delta)};
        }).filter(({distance}) => distance < 0.15).sort((a, b) => order(a) - order(b));
        if (nearby.length) return nearby[0].item;
      }
      if (!hit?.origin) return null;
      const obstruction = hit.surface && length(sub(at(hit.surface, ...hit.uv), hit.origin));
      const aimed = available.map(item => {
        const delta = sub(item.center, hit.origin);
        const depth = dot(delta, hit.direction);
        const nearest = sub(delta, mul(hit.direction, depth));
        return {item, depth, distance: length(nearest), horizontal: Math.hypot(nearest[0], nearest[2])};
      }).filter(({item, depth, distance, horizontal}) => depth > 0 && depth < 2.6 &&
        (!obstruction || depth <= obstruction + 0.13) && horizontal < 0.052 &&
        distance < (item.height ? 0.105 : 0.065)).sort((a, b) => order(a) - order(b) || a.depth - b.depth);
      return aimed[0]?.item ?? null;
    }

    function geometryGrab(source, handPoint, hit) {
      if (protractor) {
        const point = handPoint ?? hit?.point;
        if (!point || !inside([point[0] / boardWidth, point[1] / boardHeight])) return false;
        if (!construction?.source) {
          construction = {source, anchor: point, scale: construction?.scale ?? 1, rotation: construction?.rotation ?? 0};
        } else if (construction.source !== source && !adjustFigure) {
          const offset = sub(point, construction.anchor);
          if (length(offset) < 25) return false;
          adjustFigure = {source, distance: length(offset), bearing: Math.atan2(offset[1], offset[0]),
            scale: construction.scale, rotation: construction.rotation};
        }
        return true;
      }
      if (!rulerVisible || drag) return false;
      const point = handPoint ?? hit?.point;
      if (!point) return false;
      const mid = mul(add(...ruler), 0.5);
      const end = ruler.findIndex(magnet => length(sub(magnet, point)) <= magnetReach + 12);
      if (end < 0 && length(sub(mid, point)) > 70) return false;
      drag = {source, mode: 'squeeze', type: 'magnet', end, origin: ruler, start: point, hand: Boolean(handPoint)};
      return true;
    }

    function begin(event, mode) {
      const {inputSource: source, frame} = event;
      if (!room || closed || failed || !isController(source) || session.visibilityState !== 'visible') return;
      preferredSource = source;
      const hit = locate(frame, activeSpace, room, source);
      const grip = gripPose(frame, source);
      if (mode === 'select' && wrist && source !== wrist.source && hit?.origin) {
        const uv = rayToPanel(wrist.surface, hit.origin, hit.direction);
        if (uv) {
          const row = Math.min(2, Math.floor(uv[1] * 3));
          const action = wristActions[row * 2 + (uv[0] >= 0.5 ? 1 : 0)];
          wrist = null;
          if (action[0] !== 'closeWrist') choose({id: action[0]}, source);
          return;
        }
      }
      if (mode === 'select' && calibration === source && grip) {
        const key = gripKey(source);
        const model = markerPose(grip, settings['grip' + key]);
        const delta = sub(at(room.board, 0.5, 0.53), model.tip);
        if (length(delta) <= 0.16) {
          settings['gripOffset' + key] = [dot(delta, model.localRight), dot(delta, model.localUp), dot(delta, model.direction)];
          rememberSettings(settings);
          calibration = null;
          pulse(source, settings.haptics * 0.075, 35);
          sound?.play('click', settings.volume);
          return;
        }
        if (hit?.surface !== room.palette) return;
      }
      if (mode === 'squeeze') {
        const item = pickupFor(source, grip, hit, pickupTargets(rackTools()));
        const held = heldTools.get(source);
        if (item?.action) {
          if (drag?.source === source || (drag?.type === 'magnet' && item.action === 'ruler')) stopDrag();
          settingsOpen = false;
          choose({id: item.action}, source);
          pulse(source, settings.haptics * 0.09, 30);
          sound?.play('click', settings.volume);
          return;
        }
        if (item) {
          if (drag?.source === source) stopDrag();
          takeTool(source, item, true);
          return;
        }
        if (drag?.source === source) return;
        const handPoint = flatPoint(grip);
        if ((handPoint || !held) && geometryGrab(source, handPoint, held ? null : hit)) return;
        if (grip) {
          const hand = xyz(grip.position);
          if (!drag && !settings.locked && length(sub(hand, room.hinge)) < 0.085) {
            liftMarker();
            drag = {source, mode, type: 'board', hinge: true, origin: hand, tilt: settings.tilt, yaw: settings.yaw};
            return;
          }
          if (!drag && !settings.locked && room.handles.some(handle => length(sub(hand, handle)) < 0.12)) {
            liftMarker();
            drag = {source, mode, type: 'board', origin: hand, height: settings.height, distance: settings.distance, shift: settings.shift};
            return;
          }
        }
        if (held && !held.momentary) returnTool(source);
        return;
      }
      if (drag?.source === source && drag.type !== 'magnet') return;
      if (mode === 'select' && protractor && construction && (hit?.surface !== room.palette)) {
        const {anchor, scale, rotation} = construction;
        liftMarker();
        board.stamp(figure(shape, anchor, scale, rotation, settings.angle), settings.width);
        pulse(source, settings.haptics * 0.065, 25);
        return;
      }
      if (!hit?.surface) return;
      if (!hit.point) {
        const button = buttonAt(buttons, hit.uv);
        if (mode === 'select' && button) choose(button, source);
        return;
      }
      const end = rulerVisible ? ruler.findIndex(magnet => length(sub(magnet, hit.point)) <= magnetReach) : -1;
      if (end !== -1 && !drag && mode === 'select' && !protractor && board.tool !== 'eraser' && !heldTools.has(source)) {
        drag = {source, mode, type: 'magnet', end, start: hit.point, origin: ruler};
      } else if (mode === 'select' && protractor) {
        liftMarker();
        board.stamp(figure(shape, hit.point, 1, 0, settings.angle), settings.width);
      } else if (mode === 'select' && !heldTools.has(source) && !drag) {
        liftMarker();
        const snap = rulerVisible && board.tool !== 'eraser' && projectToRuler(ruler, hit.point).distance <= 47;
        drag = {source, mode, type: 'ink', snap, last: null};
        continueDrag(hit);
      }
    }

    function continueDrag(hit, handPoint) {
      if (drag.type === 'magnet') {
        const point = drag.hand ? handPoint : hit?.point;
        if (!point) return;
        const next = drag.end < 0 ? moveRuler(drag.origin,
          add(mul(add(...drag.origin), 0.5), sub(point, drag.start)), settings.magnetic) :
          moveMagnet(ruler, drag.end, point, settings.magnetic);
        if (next.some((point, i) => length(sub(point, ruler[i])) > 0.1)) {
          if (settings.magnetic) {
            pulse(drag.source, settings.haptics * 0.06, 24);
            sound?.play('click', settings.volume);
          }
          ruler = next;
        }
        return;
      }
      if (!hit?.point) {
        if (drag.type === 'ink') {
          board.endStroke();
          drag.last = null;
        }
        return;
      }
      const point = drag.snap ? projectToRuler(ruler, hit.point).point : hit.point;
      if (drag.last) {
        const movement = length(sub(point, drag.last));
        if (movement < 0.5) return;
        if (!drag.snap && movement > 270) board.endStroke();
      }
      board.stroke(point[0] / boardWidth, point[1] / boardHeight, board.tool === 'eraser' ? 54 : settings.width);
      drag.last = point;
    }

    function end(event, mode) {
      if (drag?.source === event.inputSource && drag.mode === mode) stopDrag();
      if (mode === 'squeeze' && heldTools.get(event.inputSource)?.momentary) returnTool(event.inputSource);
      if (mode === 'squeeze' && construction?.source === event.inputSource) {
        construction.source = null;
        adjustFigure = null;
      }
      if (mode === 'squeeze' && adjustFigure?.source === event.inputSource) adjustFigure = null;
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
        if (construction) construction.source = null;
        adjustFigure = null;
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
      const handRay = settings.directional && left && frame.getPose(left.targetRaySpace, activeSpace)?.transform;
      const direction = flat(forward(handRay ? handRay.orientation : pose.transform.orientation), room.ahead);
      const sideways = cross(direction, [0, 1, 0]);
      const floor = room.solids[0][0];
      const aiming = settings.moveMode !== 1 && jump > 0.58;
      const ray = aiming && right && frame.getPose(right.targetRaySpace, activeSpace)?.transform;
      let destination = null;
      if (ray) {
        const origin = xyz(ray.position);
        const direction = forward(ray.orientation);
        const arc = teleportArc(origin, direction, floor);
        const uv = arc.hit && project(floor, arc.hit);
        const valid = uv && uv[0] > 0.06 && uv[0] < 0.94 && uv[1] > 0.06 && uv[1] < 0.94;
        const desired = valid && [arc.hit[0], eye[1], arc.hit[2]];
        const safe = desired && constrainWalk(room, eye, desired);
        destination = {points: arc.points, target: safe && length(sub(safe, desired)) < 0.05 ? safe : null};
      }
      let next = eye;
      let homeTurn = null;
      const canMove = !settings.freeze || !contact;
      if (home && canMove) {
        const point = at(room.board, 0.5, 0.5);
        const normal = flat(room.board.normal, mul(room.ahead, -1));
        next = [point[0] + normal[0] * 0.95, eye[1], point[2] + normal[2] * 0.95];
        const facing = flat(forward(pose.transform.orientation), room.ahead);
        homeTurn = Math.atan2(cross(facing, mul(normal, -1))[1], dot(facing, mul(normal, -1)));
        velocity = [0, 0, 0];
        home = false;
      } else if (teleportHeld && !aiming && teleport?.target && canMove) {
        next = teleport.target;
        velocity = [0, 0, 0];
      } else if (canMove && !aiming && settings.moveMode !== 2) {
        const motion = add(mul(sideways, moveX), mul(direction, -moveY));
        const demand = mul(motion, settings.speed / Math.max(1, length(motion)));
        const damping = 1 - Math.exp(-dt * settings.acceleration);
        velocity = add(velocity, mul(sub(demand, velocity), damping));
        if (length(velocity) > 0.025) next = add(eye, mul(velocity, dt));
      } else {
        velocity = [0, 0, 0];
      }
      teleportHeld = aiming;
      teleport = destination;
      if (next !== eye) next = constrainWalk(room, eye, next);
      let turnBy = homeTurn ?? 0;
      if (!aiming && Math.abs(turn) < 0.22) turnReady = true;
      if (homeTurn === null && canMove && !aiming && !settings.turn) {
        turnBy = -turn * dt * settings.turnSpeed * Math.PI / 180;
      } else if (homeTurn === null && canMove && !aiming && turnReady && Math.abs(turn) > 0.65) {
        turnReady = false;
        turnBy = -Math.sign(turn) * settings.turn * Math.PI / 180;
      }
      const shadeGoal = aiming || turnBy || length(velocity) > 0.10 ? settings.comfort * 0.18 : 0;
      shadeAmount += (shadeGoal - shadeAmount) * Math.min(1, dt * 13);
      if (turnBy || next !== eye) {
        if (contact && (turnBy || length(sub(next, eye)) > 0.12)) liftMarker();
        yaw += turnBy;
        displacement = add(next, rotateY(sub(displacement, eye), turnBy));
        activeSpace = offsetSpace(space, displacement, yaw);
      }
    }

    function writeWithMarker(time, hands, eye) {
      const headAtBoard = project(room.board, eye);
      const throughBoard = headAtBoard && inside(headAtBoard) && headAtBoard[2] < 0.05 && headAtBoard[2] > -0.15;
      if (throughBoard) shadeAmount = Math.max(shadeAmount, 0.8);
      const canWrite = !throughBoard && drag?.type !== 'ink' && drag?.type !== 'board';
      const tools = hands.flatMap(({source, grip}) => {
        const tool = heldTools.get(source);
        if (!tool || !grip) return [];
        const key = gripKey(source);
        const {sponge} = tool;
        const model = markerPose(grip, sponge ? 0 : settings['grip' + key], settings['gripOffset' + key]);
        if (sponge) model.tip = add(xyz(grip.position), mul(model.axis, 0.055));
        model.chisel = !sponge && tool.wide;
        const free = source !== construction?.source && source !== adjustFigure?.source &&
          source !== calibration && !(drag?.type === 'magnet' && drag.source === source);
        const surface = canWrite && free && [room.board, room.practice].find(panel => {
          const p = project(panel, model.tip);
          return inside(p) && p[2] >= -0.065 && p[2] <= settings.touch / 1000 + (source === writingSource ? 0.009 : 0) &&
            project(panel, xyz(grip.position))[2] > 0 && (sponge || dot(model.axis, panel.normal) < -0.04);
        });
        return [{source, tool, model, surface}];
      });
      const writer = tools.find(({source, surface}) => surface && source === writingSource) ??
        tools.find(({source, surface}) => surface && source.handedness === (settings.hand ? 'left' : 'right')) ??
        tools.find(({surface}) => surface);
      if (!writer) {
        liftMarker();
        return tools;
      }
      const {source, model, surface, tool: {sponge, id}} = writer;
      if (surface !== contactSurface || source !== writingSource) liftMarker();
      const sample = contactPoint(surface, model.tip, contact,
        sponge ? 0 : (settings.resistance * 0.75 + settings.trail * 0.25), settings.touch / 1000);
      if (!sample) {
        liftMarker();
        return tools;
      }
      const starting = !contact || sample.restart;
      if (sample.restart) board.endStroke();
      const width = sponge ? 23 + 65 * Math.abs(dot(model.direction, surface.normal)) :
        settings.width * (model.chisel ? 0.50 + 1.65 * Math.abs(dot(model.localRight, surface.down)) : 1);
      if (starting && surface === room.board && rulerVisible && !sponge) {
        contactSnap = projectToRuler(ruler, [sample.ink[0] * boardWidth, sample.ink[1] * boardHeight]).distance < 46;
      }
      if (contactSnap) {
        const {point} = projectToRuler(ruler, [sample.ink[0] * boardWidth, sample.ink[1] * boardHeight]);
        sample.ink = [point[0] / boardWidth, point[1] / boardHeight];
      }
      const moving = sample.delta && length(sample.delta) > 0.0006;
      if (starting || length(sub(sample.ink, lastInk)) > 0.00036) {
        if (surface === room.practice) {
          const point = [sample.ink[0] * 680, sample.ink[1] * 310];
          trial.globalCompositeOperation = sponge ? 'destination-out' : 'source-over';
          trial.strokeStyle = trial.fillStyle = board.colors[id] ?? '#000';
          trial.lineCap = 'round';
          trial.lineWidth = width;
          trial.beginPath();
          if (starting || !lastInk) {
            trial.arc(...point, width / 2, 0, Math.PI * 2);
            trial.fill();
          } else {
            trial.moveTo(lastInk[0] * 680, lastInk[1] * 310);
            trial.lineTo(...point);
            trial.stroke();
          }
          trialDirty = true;
        } else {
          board.stroke(...sample.ink, width, sponge, id);
        }
        lastInk = sample.ink;
        if (starting || (moving && time - lastPulse > 70)) {
          pulse(source, settings.haptics * (starting ? 0.09 : 0.035), starting ? 28 : 18);
          sound?.play(sponge ? 'sponge' : 'felt', settings.volume);
          lastPulse = time;
        }
      }
      contact = sample;
      contactSurface = surface;
      writingSource = source;
      model.tip = at(surface, ...sample.ink, 0.004);
      return tools;
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
        for (const source of heldTools.keys()) {
          if (!controllers.includes(source)) returnTool(source);
        }
        const hits = controllers.map(source => ({source, hit: locate(frame, activeSpace, room, source), grip: gripPose(frame, source)}));
        const sourceForWrist = controllers.find(source => !heldTools.has(source) &&
          source.handedness === (settings.hand ? 'right' : 'left')) ??
          controllers.find(source => !heldTools.has(source)) ?? controllers.find(source => source !== writingSource);
        const held = Boolean(sourceForWrist?.gamepad?.buttons?.[3]?.pressed);
        if (held && !wristLatch) wrist = wrist ? null : {source: sourceForWrist};
        wristLatch = held;
        if (wrist) {
          const grip = gripPose(frame, wrist.source);
          if (!grip || !controllers.includes(wrist.source)) wrist = null;
          else {
            wrist.surface = wristPanel(grip, pose.transform);
            if (!wrist.surface) wrist = null;
          }
        }
        if (drag?.type === 'board') {
          const grip = gripPose(frame, drag.source);
          if (grip) {
            const movement = sub(xyz(grip.position), drag.origin);
            if (drag.hinge) {
              settings.tilt = clamp(drag.tilt + movement[1] * 160, ...limits.tilt);
              settings.yaw = clamp(drag.yaw + dot(movement, room.right) * 100, ...limits.yaw);
            } else {
              settings.height = clamp(drag.height + movement[1], ...limits.height);
              settings.distance = clamp(drag.distance + dot(movement, room.ahead), ...limits.distance);
              settings.shift = clamp(drag.shift + dot(movement, room.right), ...limits.shift);
            }
            arrangeBoard(room, settings);
          } else {
            stopDrag();
          }
        } else if (drag) continueDrag(hits.find(input => input.source === drag.source)?.hit,
          drag.hand ? flatPoint(gripPose(frame, drag.source), 0.27) : null);
        if (construction?.source && !controllers.includes(construction.source)) {
          construction.source = null;
          adjustFigure = null;
        }
        if (construction?.source) {
          const target = source => flatPoint(gripPose(frame, source), 0.32) ??
            hits.find(input => input.source === source)?.hit?.point;
          const anchor = target(construction.source);
          if (anchor) construction.anchor = anchor;
          if (adjustFigure && !controllers.includes(adjustFigure.source)) adjustFigure = null;
          if (adjustFigure) {
            const handle = target(adjustFigure.source);
            if (handle) {
              const diff = sub(handle, construction.anchor);
              construction.scale = clamp(adjustFigure.scale * length(diff) / adjustFigure.distance, 0.38, 2.3);
              construction.rotation = adjustFigure.rotation + Math.atan2(diff[1], diff[0]) - adjustFigure.bearing;
            }
          }
        }
        const tools = writeWithMarker(time, hits, xyz(pose.transform.position));
        const rack = rackTools();
        const candidates = pickupTargets(rack);
        const grabTargets = new Map(hits.map(({source, grip, hit}) => [source, pickupFor(source, grip, hit, candidates)]));
        hoveredPickups.clear();
        for (const [source, item] of grabTargets) if (item) hoveredPickups.set(source, item.slot);
        const highlighted = new Set(Array.from(grabTargets.values(), item => item?.slot));
        const pointer = (drag && hits.find(input => input.source === drag.source && input.hit)) ??
          hits.find(input => input.source === preferredSource && input.hit?.surface) ??
          hits.find(input => input.hit?.surface) ??
          hits.find(input => input.source === preferredSource && input.hit) ??
          hits.find(input => input.hit);
        const hover = pointer?.hit.surface === room.palette ? buttonAt(buttons, pointer.hit.uv)?.id : null;
        const active = [board.tool, rulerVisible && 'ruler', protractor && 'protractor',
          protractor && 'shape:' + shape,
          ...Array.from(heldTools.values(), tool => tool.sponge ? 'sponge' : 'marker'),
          settingsOpen && 'page:' + settingsPage];
        const nextPalette = JSON.stringify([active, hover, Boolean(controllers.length)]);
        if (paletteState !== nextPalette) {
          paletteState = nextPalette;
          paintPalette(paletteCanvas, buttons, active, hover, protractor, rulerVisible, Boolean(controllers.length), settingsOpen);
          renderer.update(renderer.interfaceTexture, paletteCanvas.canvas);
        }
        const previewInputs = protractor && !construction ? hits.filter(input => input.hit?.point) : [];
        previewInputs.sort((a, b) => Number(b === pointer) - Number(a === pointer));
        const previews = protractor && construction ?
          [figure(shape, construction.anchor, construction.scale, construction.rotation, settings.angle)] :
          previewInputs.map(input => figure(shape, input.hit.point, 1, 0, settings.angle));
        const shownRuler = rulerVisible ? ruler : null;
        const heldEnd = drag?.type === 'magnet' ? drag.end : null;
        const nextGuide = JSON.stringify([shownRuler, heldEnd, previews.map(({anchor, angle, scale}) => [anchor, angle, scale]),
          protractor && shape, lastColor, settings.angle, Boolean(calibration), settings.size]);
        if (guideState !== nextGuide) {
          guideState = nextGuide;
          paintGuide(guideCanvas, shownRuler, heldEnd, previews, board.colors[lastColor], Boolean(calibration), room.board.width);
          renderer.update(guide, guideCanvas.canvas);
        }
        if (boardGrid !== settings.grid) {
          boardGrid = settings.grid;
          gridCanvas.clearRect(0, 0, 720, 480);
          gridCanvas.fillStyle = '#526d6027';
          if (boardGrid) {
            for (let x = 30; x < 720; x += 30) {
              if (boardGrid === 2) gridCanvas.fillRect(x, 0, 1, 480);
              for (let y = 30; y < 480; y += 30) {
                if (boardGrid === 1) gridCanvas.fillRect(x - 1, y - 1, 2, 2);
                else if (x === 30) gridCanvas.fillRect(0, y, 720, 1);
              }
            }
          }
          renderer.update(grid, gridCanvas.canvas);
        }
        if (trialDirty) {
          trialDirty = false;
          renderer.update(practiceTexture, trial.canvas);
        }
        if (inkRevision !== board.revision) {
          inkRevision = board.revision;
          renderer.update(renderer.ink, board.canvas);
        }
        for (const view of pose.views) {
          if (!renderer.selectView(layer, view)) continue;
          renderRoom(renderer, room, guide, grid, practiceTexture, settings.light);
          if (shownRuler) drawRuler(renderer, room.board, shownRuler);
          if (previews[0]?.protractor) {
            const {anchor, angle, scale} = previews[0];
            drawProtractor(renderer, room.board, anchor, angle, scale);
          }
          if (wrist) renderer.draw(wrist.surface, wristTexture, [0, 0, 0, 0]);
          if (teleport) {
            drawArc(renderer, teleport.points, Boolean(teleport.target));
            if (teleport.target) {
              const [x, , z] = teleport.target;
              drawBox(renderer, [x, room.origin[1] + 0.01, z], [room.right, [0, 1, 0], room.ahead],
                [0.25, 0.014, 0.25], [0.6, 0.84, 0.63, 1]);
            }
          }
          const toolAxes = [room.board.right, room.board.down, room.board.normal];
          drawBox(renderer, room.hinge, toolAxes, [0.052, 0.070, 0.045], [0.84, 0.61, 0.29, 1]);
          drawBox(renderer, at(room.board, -0.13, 0.36, 0.065), toolAxes, [0.038, shownRuler ? 0.10 : 0.29, 0.019],
            highlighted.has('rulerHook') ? [1, 0.83, 0.42, 1] : [0.80, 0.62, 0.30, 1]);
          if (!protractor) drawProtractor(renderer, room.board, [-187, 605], Math.PI / 2, 0.57);
          if (highlighted.has('protractorHook') || protractor) {
            drawSphere(renderer, at(room.board, -0.13, 0.63, 0.065), 0.021,
              highlighted.has('protractorHook') ? [1, 0.83, 0.42, 1] : [0.44, 0.75, 0.66, 1]);
          }
          const rackAxes = [room.right, [0, 1, 0], room.ahead];
          for (const item of rack) {
            const owner = ownerOf(item.slot);
            const target = highlighted.has(item.slot);
            const base = item.base ?? spongeDock();
            drawBox(renderer, base, rackAxes, item.sponge ? [0.137, 0.020, 0.080] : [0.066, 0.022, 0.054],
              target ? [0.94, 0.72, 0.32, 1] : [0.19, 0.27, 0.24, 1]);
            if (owner) continue;
            if (item.sponge) {
              drawBox(renderer, item.center, rackAxes, [0.12, 0.051, 0.067], [0.83, 0.58, 0.24, 1]);
            } else {
              drawMarker(renderer, {axis: [0, 1, 0], tip: add(base, [0, 0.18, 0]), chisel: item.wide, localUp: room.ahead},
                board.colors[item.id]);
            }
            if (target) drawSphere(renderer, add(item.center, [0, item.height / 2 + 0.026, 0]), 0.014, [1, 0.83, 0.42, 1]);
          }
          for (const {source, grip, hit} of hits) {
            const center = grip ? xyz(grip.position) : hit?.origin;
            if (!center) continue;
            const tint = grabTargets.get(source) ? [1, 0.82, 0.38, 1] :
              source.handedness === 'left' ? [0.47, 0.84, 0.72, 1] : [0.61, 0.72, 0.98, 1];
            drawSphere(renderer, center, 0.019, tint);
          }
          for (const {source, model, tool, surface: nearSurface} of tools) {
            if (tool.sponge) {
              const axes = [model.localRight, model.localUp, model.axis];
              drawBox(renderer, sub(model.tip, mul(model.axis, 0.025)), axes, [0.111, 0.059, 0.05], [0.83, 0.58, 0.24, 1]);
              drawBox(renderer, sub(model.tip, mul(model.axis, 0.005)), axes, [0.113, 0.061, 0.013], [0.26, 0.31, 0.28, 1]);
            } else drawMarker(renderer, model, board.colors[tool.id]);
            const surface = (source === writingSource && contactSurface) || nearSurface || room.board;
            const [u, v, depth] = project(surface, model.tip);
            if (inside([u, v]) && depth > -0.03 && depth < 0.18) {
              const point = at(surface, u, v, 0.004);
              const radius = 0.016 + Math.max(0, depth) * 0.09;
              const origin = sub(point, mul(add(surface.right, surface.down), radius));
              renderer.drawDecal(makePanel(origin, surface.right, surface.down, radius * 2, radius * 2),
                shadow, [0, 0, 0, 0], 0);
            }
          }
          if (wrist && pointer?.source !== wrist.source && pointer?.hit) {
            const uv = rayToPanel(wrist.surface, pointer.hit.origin, pointer.hit.direction);
            if (uv) drawPointer(renderer, {...pointer.hit, surface: wrist.surface, uv}, [0.95, 0.79, 0.38, 1]);
          }
          if (pointer && (!heldTools.has(pointer.source) || pointer.hit.surface === room.palette || protractor || grabTargets.get(pointer.source))) {
            const color = pointer.hit.surface === room.palette ? [1, 0.91, 0.59, 1] : [0.24, 0.48, 0.38, 1];
            drawPointer(renderer, pointer.hit, color);
          }
          for (const input of previewInputs) {
            if (input !== pointer) drawPointer(renderer, input.hit, [0.43, 0.61, 0.53, 1]);
          }
          if (shadeAmount > 0.01) drawVignette(renderer, vignette, view.transform, shadeAmount, view);
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
