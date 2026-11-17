const vertexSource = `#version 300 es
in vec3 a_position;
in vec2 a_corner;
uniform vec2 u_scale;
uniform vec2 u_rotation;
uniform vec2 u_height;
uniform vec2 u_dotExtent;
uniform float u_verticalCenter;
uniform float u_depthBias;
uniform bool u_points;
out float v_height;
out vec2 v_dot;

void main() {
  float right = a_position.x * u_rotation.x - a_position.z * u_rotation.y;
  float depth = a_position.x * u_rotation.y + a_position.z * u_rotation.x;
  float up = a_position.y * .88 - depth * .47 - u_verticalCenter;
  v_height = u_height.y > 0. ? clamp((a_position.y - u_height.x) * u_height.y, 0., 1.) : .35;
  v_dot = u_points ? a_corner : vec2(0.);
  float distanceToCamera = .88 * depth + .47 * a_position.y;
  gl_Position = vec4(vec2(right, up) * u_scale + v_dot * u_dotExtent,
    -.72 * distanceToCamera + u_depthBias, 1.);
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform bool u_points;
uniform bool u_depthOnly;
in float v_height;
in vec2 v_dot;
out vec4 pixel;

void main() {
  if (!u_points) {
    pixel = vec4(vec3(.20, .56, .64) * .30, .30);
    return;
  }
  float radius = length(v_dot);
  if (u_depthOnly) {
    if (radius > .88) discard;
    pixel = vec4(0.);
    return;
  }
  float coverage = .86 * (1. - smoothstep(.08, 1., radius));
  // Two-segment ramp anchored at the established mid tone: v_height = .5 maps
  // exactly to (.43, .79, .925); the ends extend so height differences read.
  vec3 color = v_height < .5
    ? mix(vec3(.05, .51, .82), vec3(.43, .79, .925), v_height * 2.)
    : mix(vec3(.43, .79, .925), vec3(.81, 1., 1.), v_height * 2. - 1.);
  pixel = vec4(color * coverage, coverage);
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

function fitPoints(source, rings) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.length; i++) {
    const axis = i % 3;
    if (!Number.isFinite(source[i])) throw new Error('分区点阵含有无效坐标');
    low[axis] = Math.min(low[axis], source[i]);
    high[axis] = Math.max(high[axis], source[i]);
  }
  for (const ring of rings) for (const [x, z] of ring) {
    low[0] = Math.min(low[0], x);
    high[0] = Math.max(high[0], x);
    low[2] = Math.min(low[2], z);
    high[2] = Math.max(high[2], z);
  }
  const spans = high.map((value, axis) => value - low[axis]);
  const span = Math.max(1, ...spans);
  const center = low.map((value, axis) => (value + high[axis]) / 2);
  const positions = Float32Array.from(source, (value, i) => (value - center[i % 3]) / span);
  const outline = footprintData(rings, center, span, low[1]);
  let radius = 0;
  let halfHeight = 0;
  for (const vertices of [positions, outline]) {
    for (let i = 0; i < vertices.length; i += 3) {
      const extent = Math.hypot(vertices[i], vertices[i + 2]);
      radius = Math.max(radius, extent);
      halfHeight = Math.max(halfHeight, Math.abs(vertices[i + 1] * .88) + extent * .47);
    }
  }
  // Across the full turn, each point stays within these vertical bounds.
  // Use quantiles so a few extreme peaks or deep outliers cannot displace the subject.
  const lower = new Float32Array(positions.length / 3);
  const upper = new Float32Array(lower.length);
  const elevations = new Float32Array(lower.length);
  let xx = 0, xz = 0, zz = 0;
  for (let i = 0; i < lower.length; i++) {
    const j = i * 3;
    const x = positions[j], z = positions[j + 2];
    const sway = .47 * Math.hypot(x, z);
    const elevation = .88 * positions[j + 1];
    xx += x * x;
    xz += x * z;
    zz += z * z;
    lower[i] = elevation - sway;
    upper[i] = elevation + sway;
    elevations[i] = positions[j + 1];
  }
  lower.sort();
  upper.sort();
  elevations.sort();
  const trim = Math.floor(lower.length * .025);
  const bottom = lower[trim];
  const top = upper[upper.length - 1 - trim];
  // Color ramp domain from robust quantiles: a few extreme peaks or shaft
  // outliers must not flatten the gradient of the ordinary terrain mass.
  const colorTrim = Math.floor(elevations.length * .02);
  const colorLow = elevations[colorTrim];
  const colorHigh = elevations[elevations.length - 1 - colorTrim];
  const anisotropy = Math.hypot(xx - zz, 2 * xz);
  const angle = anisotropy > .35 * (xx + zz) ? .18 - .5 * Math.atan2(2 * xz, xx - zz) : .48;
  return {positions, outline, span, fit: {radius, halfHeight, height: spans[1] / span,
    angle, verticalCenter: (bottom + top) / 2, verticalSpan: top - bottom,
    colorLow, colorHigh: Math.max(colorHigh, colorLow + 1e-6)}};
}

function footprintData(rings, center, span, floor) {
  const lines = [];
  const y = (floor - center[1]) / span;
  const vertex = ([x, z]) => [(x - center[0]) / span, y, (z - center[2]) / span];
  for (const ring of rings) {
    if (!ring.length) continue;
    let from = vertex(ring.at(-1));
    for (const corner of ring) {
      const to = vertex(corner);
      lines.push(...from, ...to);
      from = to;
    }
  }
  return new Float32Array(lines);
}

export function mountReliefPreview(canvas, active = true) {
  // The dots have shader-based coverage, so the transparent dock needs no MSAA resolve.
  const gl = canvas.getContext('webgl2', {alpha: true, depth: true, premultipliedAlpha: true, antialias: false});
  if (!gl) throw new Error('WebGL 2 不可用');
  const program = createProgram(gl);
  const position = gl.getAttribLocation(program, 'a_position');
  const corner = gl.getAttribLocation(program, 'a_corner');
  const uniform = Object.fromEntries(['scale', 'rotation', 'height', 'dotExtent', 'verticalCenter',
    'depthBias', 'depthOnly', 'points'].map((key) =>
    [key, gl.getUniformLocation(program, `u_${key}`)]));
  const outlineLayer = {buffer: gl.createBuffer(), count: 0};
  const pointLayer = {buffer: gl.createBuffer(), count: 0};
  const layers = [outlineLayer, pointLayer];
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
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
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!pointLayer.count) return;

    const {width, height} = canvas;
    const {radius, height: elevationSpan, verticalCenter, verticalSpan, colorLow, colorHigh} = fit;
    const horizontalFit = .93 * width / (2 * Math.max(.1, radius));
    const verticalFit = (height - 6 * density) / Math.max(.001, verticalSpan);
    const pixelsPerUnit = Math.min(horizontalFit, Math.max(1, verticalFit));
    const dotRadius = Math.min(3 * density, Math.max(1.65 * density, pixelsPerUnit * (normalizedSpacing ?? 0) * .52));
    gl.useProgram(program);
    gl.enableVertexAttribArray(position);
    gl.uniform2f(uniform.scale, 2 * pixelsPerUnit / width, 2 * pixelsPerUnit / height);
    gl.uniform2f(uniform.rotation, Math.cos(angle), Math.sin(angle));
    gl.uniform2f(uniform.height, elevationSpan ? colorLow : 0,
      elevationSpan ? 1 / (colorHigh - colorLow) : 0);
    gl.uniform1f(uniform.verticalCenter, verticalCenter);
    if (outlineLayer.count) {
      gl.disable(gl.DEPTH_TEST);
      gl.disableVertexAttribArray(corner);
      gl.bindBuffer(gl.ARRAY_BUFFER, outlineLayer.buffer);
      gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(position, 0);
      gl.uniform1i(uniform.points, 0);
      gl.uniform1f(uniform.depthBias, 0);
      gl.drawArrays(gl.LINES, 0, outlineLayer.count);
    }
    // Instanced quads preserve fractional pixel centers throughout the rotation.
    // No depth pre-pass: the parallel oblique view has no occlusion basis, and a
    // splat mask would erase the real side walls (city walls, cliffs, shafts).
    gl.disable(gl.DEPTH_TEST);
    gl.enableVertexAttribArray(corner);
    gl.bindBuffer(gl.ARRAY_BUFFER, pointLayer.buffer);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(position, 1);
    gl.uniform1i(uniform.points, 1);
    gl.uniform1i(uniform.depthOnly, 0);
    gl.uniform1f(uniform.depthBias, 0);
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
    schedule();
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
    setPoints(source, rings = [], spacing = null) {
      if (source) {
        const fitted = fitPoints(source, rings);
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
      if (source) return fit.radius / Math.max(.1, fit.halfHeight);
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotionChange);
      for (const {buffer} of layers) gl.deleteBuffer(buffer);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
