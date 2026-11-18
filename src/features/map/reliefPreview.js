const vertexSource = `#version 300 es
in vec3 a_position;
in vec2 a_corner;
uniform vec2 u_scale;
uniform vec2 u_rotation;
uniform vec2 u_height;
uniform vec2 u_dotExtent;
uniform float u_verticalCenter;
uniform bool u_points;
out vec2 v_dot;
flat out vec3 v_color;

void main() {
  float right = a_position.x * u_rotation.x - a_position.z * u_rotation.y;
  float depth = a_position.x * u_rotation.y + a_position.z * u_rotation.x;
  float up = a_position.y * .88 - depth * .47 - u_verticalCenter;
  float height = u_height.y > 0. ? clamp((a_position.y - u_height.x) * u_height.y, 0., 1.) : .35;
  // Two-segment ramp anchored at the established mid tone: height = .5 maps
  // exactly to (.43, .79, .925); the ends extend so height differences read.
  // Per-instance constant (it only depends on a_position.y), so it is computed
  // in the vertex stage here instead of once per fragment.
  v_color = height < .5
    ? mix(vec3(.05, .51, .82), vec3(.43, .79, .925), height * 2.)
    : mix(vec3(.43, .79, .925), vec3(.81, 1., 1.), height * 2. - 1.);
  v_dot = u_points ? a_corner : vec2(0.);
  float distanceToCamera = .88 * depth + .47 * a_position.y;
  gl_Position = vec4(vec2(right, up) * u_scale + v_dot * u_dotExtent,
    -.72 * distanceToCamera, 1.);
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform bool u_points;
flat in vec3 v_color;
in vec2 v_dot;
out vec4 pixel;

void main() {
  if (!u_points) {
    pixel = vec4(vec3(.20, .56, .64) * .30, .30);
    return;
  }
  float radius = length(v_dot);
  // Outside the circle coverage is exactly zero, so blending there is a no-op.
  if (radius >= 1.) discard;
  float coverage = .86 * (1. - smoothstep(.08, 1., radius));
  pixel = vec4(v_color * coverage, coverage);
}`;

function createProgram(gl) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

export function mountReliefPreview(canvas, active = true) {
  // The dots have shader-based coverage, so the transparent dock needs no MSAA
  // resolve. Neither pass reads depth (the oblique view has no occlusion basis),
  // so the context carries no depth buffer at all and only color is cleared.
  const gl = canvas.getContext('webgl2', {alpha: true, depth: false, premultipliedAlpha: true, antialias: false});
  if (!gl) throw new Error('WebGL 2 不可用');
  const program = createProgram(gl);
  const position = gl.getAttribLocation(program, 'a_position');
  const corner = gl.getAttribLocation(program, 'a_corner');
  const uniform = Object.fromEntries(['scale', 'rotation', 'height', 'dotExtent', 'verticalCenter',
    'points'].map((key) =>
    [key, gl.getUniformLocation(program, `u_${key}`)]));
  const outlineLayer = {buffer: gl.createBuffer(), count: 0};
  const pointLayer = {buffer: gl.createBuffer(), count: 0};
  const layers = [outlineLayer, pointLayer];
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  // Bind each layer's full layout (attributes, divisors) up front so draw only
  // has to switch the VAO instead of re-pointing attributes every frame.
  const outlineVao = gl.createVertexArray();
  gl.bindVertexArray(outlineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, outlineLayer.buffer);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(position, 0);
  gl.disableVertexAttribArray(corner);
  const pointVao = gl.createVertexArray();
  gl.bindVertexArray(pointVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, pointLayer.buffer);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(position, 1);
  gl.enableVertexAttribArray(corner);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  function upload(layer, data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    layer.count = data.length / 3;
  }
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const fullTurn = Math.PI * 2;
  let frame = 0;
  let lastDraw = null;
  let angle = .48;
  let density = 1;
  let fit;
  let normalizedSpacing = null;
  const schedule = () => {
    if (active && !frame && !document.hidden && !gl.isContextLost()) frame = requestAnimationFrame(draw);
  };

  function draw(now) {
    frame = 0;
    if (document.hidden || gl.isContextLost()) return;
    if (!motion.matches && lastDraw !== null) {
      angle = (angle + (now - lastDraw) * fullTurn / 16000) % fullTurn;
    }
    lastDraw = now;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!pointLayer.count) return;

    const {width, height} = canvas;
    const {radius, height: elevationSpan, verticalCenter, verticalSpan, colorLow, colorHigh} = fit;
    const horizontalFit = .93 * width / (2 * Math.max(.1, radius));
    const verticalFit = (height - 6 * density) / Math.max(.001, verticalSpan);
    const pixelsPerUnit = Math.min(horizontalFit, Math.max(1, verticalFit));
    const dotRadius = Math.min(3 * density, Math.max(1.65 * density, pixelsPerUnit * (normalizedSpacing ?? 0) * .52));
    gl.useProgram(program);
    gl.uniform2f(uniform.scale, 2 * pixelsPerUnit / width, 2 * pixelsPerUnit / height);
    gl.uniform2f(uniform.rotation, Math.cos(angle), Math.sin(angle));
    gl.uniform2f(uniform.height, elevationSpan ? colorLow : 0,
      elevationSpan ? 1 / (colorHigh - colorLow) : 0);
    gl.uniform1f(uniform.verticalCenter, verticalCenter);
    if (outlineLayer.count) {
      gl.bindVertexArray(outlineVao);
      gl.uniform1i(uniform.points, 0);
      gl.drawArrays(gl.LINES, 0, outlineLayer.count);
    }
    // Instanced quads preserve fractional pixel centers throughout the rotation.
    // No depth pre-pass: the parallel oblique view has no occlusion basis, and a
    // splat mask would erase the real side walls (city walls, cliffs, shafts).
    gl.bindVertexArray(pointVao);
    gl.uniform1i(uniform.points, 1);
    gl.uniform2f(uniform.dotExtent, 2 * dotRadius / width, 2 * dotRadius / height);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pointLayer.count);
    if (!motion.matches) schedule();
  }

  const observer = new ResizeObserver(([{contentRect}]) => {
    density = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(contentRect.width * density));
    const height = Math.max(1, Math.round(contentRect.height * density));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    // Resizing clears the drawing buffer. Redraw before the browser paints,
    // so a map zoom cannot expose an empty point cloud for one frame.
    cancelAnimationFrame(frame);
    draw(performance.now());
  });
  observer.observe(canvas);
  function onVisibility() {
    lastDraw = null;
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else schedule();
  }
  function onMotionChange() {
    lastDraw = null;
    schedule();
  }
  document.addEventListener('visibilitychange', onVisibility);
  motion.addEventListener('change', onMotionChange);
  return {
    setActive(value) {
      active = value;
      lastDraw = null;
      if (active) schedule();
      else {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    // Accepts an already-fitted result ({positions, outline, span, fit}) from
    // the fit worker or the main-thread fallback; the GL side only uploads.
    setPoints(fitted, spacing = null) {
      if (fitted) {
        fit = fitted.fit;
        angle = fit.angle;
        normalizedSpacing = spacing ? spacing / fitted.span : null;
        upload(outlineLayer, fitted.outline);
        upload(pointLayer, fitted.positions);
      } else {
        for (const layer of layers) layer.count = 0;
        normalizedSpacing = null;
      }
      lastDraw = null;
      schedule();
      if (fitted) return fit.radius / Math.max(.1, fit.halfHeight);
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotionChange);
      for (const {buffer} of layers) gl.deleteBuffer(buffer);
      gl.deleteBuffer(quad);
      gl.deleteVertexArray(outlineVao);
      gl.deleteVertexArray(pointVao);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
