import { at } from './geometry.mjs';

const vertexSource = [
  'attribute vec3 aPosition;',
  'attribute vec2 aUV;',
  'uniform mat4 uProjection, uView;',
  'varying vec2 vUV;',
  'void main() {',
  '  vUV = aUV;',
  '  gl_Position = uProjection * uView * vec4(aPosition, 1.0);',
  '}'
].join('\n');

const fragmentSource = [
  'precision mediump float;',
  'uniform sampler2D uTexture;',
  'uniform vec4 uBacking;',
  'uniform float uBorder;',
  'varying vec2 vUV;',
  'void main() {',
  '  vec4 ink = texture2D(uTexture, vUV);',
  '  float backdrop = uBacking.a * (1.0 - ink.a);',
  '  float alpha = ink.a + backdrop;',
  '  vec3 color = (ink.rgb * ink.a + uBacking.rgb * backdrop) / max(alpha, 0.001);',
  '  vec2 edge = min(vUV, 1.0 - vUV);',
  '  if (uBorder > 0.0 && min(edge.x, edge.y) < uBorder) {',
  '    color = vec3(0.35, 0.31, 0.69);',
  '    alpha = 0.92;',
  '  }',
  '  gl_FragColor = vec4(color, alpha);',
  '}'
].join('\n');

export function makeRenderer(gl) {
  const program = gl.createProgram();
  for (const [type, code] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const [name, count, offset] of [['aPosition', 3, 0], ['aUV', 2, 12]]) {
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, count, gl.FLOAT, false, 20, offset);
  }
  const projection = gl.getUniformLocation(program, 'uProjection');
  const viewMatrix = gl.getUniformLocation(program, 'uView');
  const backingColor = gl.getUniformLocation(program, 'uBacking');
  const borderWidth = gl.getUniformLocation(program, 'uBorder');
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function createTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  const empty = createTexture();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const ink = createTexture();
  const interfaceTexture = createTexture();
  const allocated = new Set();
  const vertices = new Float32Array(20);
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];

  function update(texture, canvas) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (allocated.has(texture)) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      allocated.add(texture);
    }
  }

  function draw(panel, texture, backing, border = 0, depth = 0) {
    corners.forEach(([u, v], i) => vertices.set([...at(panel, u, v, depth), u, v], i * 5));
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform4fv(backingColor, backing);
    gl.uniform1f(borderWidth, border);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    ink, interfaceTexture, empty, update, draw,
    begin(layer) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },
    selectView(layer, view) {
      const viewport = layer.getViewport(view);
      if (!viewport) return false;
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.uniformMatrix4fv(projection, false, view.projectionMatrix);
      gl.uniformMatrix4fv(viewMatrix, false, view.transform.inverse.matrix);
      return true;
    },
    destroy() {
      for (const texture of [empty, ink, interfaceTexture]) gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    }
  };
}
