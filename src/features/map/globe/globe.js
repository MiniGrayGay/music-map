import {DetailTiles, detailTextures} from './detail-tiles.js';
import {drawGlobeBoundaries} from './boundaries.js';
import {frameZone} from './framing.js';
import {lockedMoonBasis, orbitDirection, ORBIT_RADIUS} from './lunar-orbit.js';
import {moonCanonReachable} from '../mooncanonSafety.js';
import {
  cameraAtAnchor, cameraBasis, cameraRoute, chartFlattening, chartScale, clamp, dot, fullSpan,
  projectAtlas, projectVisibleOutline, surfaceRay, viewAtlasPoints, viewportAngles, wrap,
} from './projection.js';

const TAU = 2 * Math.PI;
const interpolate = (a, b, factor) => a + (b - a) * factor;
const MIN_ZOOM = .53;
const MAX_ZOOM = 18;
const LUNAR_TRANSITION_DURATION = 720;
const SPIN_RATE = TAU / 165000;
const orbitMajor = orbitDirection(0);
const orbitMinor = orbitDirection(Math.PI / 2);
const orbitRoll = Math.atan2(-orbitMajor[1], orbitMajor[0]);
const orbitAspect = Math.hypot(orbitMinor[0], orbitMinor[1]);

function overlaps(a, b, padding = 0) {
  return a.left < b.right + padding && a.right > b.left - padding
    && a.top < b.bottom + padding && a.bottom > b.top - padding;
}

function roundElevationRing(points) {
  return points.flatMap(([x, y], index) => {
    const [ax, ay] = points.at(index - 1);
    const [bx, by] = points[(index + 1) % points.length];
    const a = Math.hypot(ax - x, ay - y);
    const b = Math.hypot(bx - x, by - y);
    const trim = Math.min(9, a * .25, b * .25);
    if (trim < .5 || Math.abs((ax - x) * (by - y) - (ay - y) * (bx - x)) < a * b * .10) return [[x, y]];
    const before = [x + (ax - x) * trim / a, y + (ay - y) * trim / a];
    const after = [x + (bx - x) * trim / b, y + (by - y) * trim / b];
    return [0, .25, .5, .75, 1].map((t) => before.map((value, axis) =>
      (1 - t) ** 2 * value + 2 * (1 - t) * t * (axis ? y : x) + t * t * after[axis],
    ));
  });
}

function sky(canvas, width, height, ratio) {
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  let seed = 19353;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  for (let i = 0; i < width * height / 1350; i += 1) {
    const x = random() * width;
    const y = random() * height;
    const brightness = random();
    const r = brightness > .985 ? 1.5 : .35 + brightness * .58;
    context.fillStyle = i % 7 === 0 ? '#f4c7b5' : '#b8ccee';
    context.globalAlpha = brightness > .985 ? .60 : .07 + brightness * .21;
    context.beginPath();
    context.arc(x, y, r, 0, TAU);
    context.fill();
  }
  context.globalAlpha = 1;
}

function initialize(canvas, fragment) {
  const gl = canvas.getContext('webgl2', {
    alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL 2 不可用');
  function shader(type, source) {
    const result = gl.createShader(type);
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(result));
    }
    return result;
  }
  const program = gl.createProgram();
  const vertex = shader(gl.VERTEX_SHADER, [
    '#version 300 es',
    'void main() {',
    '  vec2 xy = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(xy * 2. - 1., 0., 1.);',
    '}',
  ].join('\n'));
  const material = shader(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vertex);
  gl.attachShader(program, material);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vertex);
  gl.deleteShader(material);
  gl.useProgram(program);
  const uniforms = Object.fromEntries(
    ['center', 'radius', 'right', 'up', 'front', 'sea', 'span', 'zoom', 'flatten', 'chartScale', 'projection', 'oceanRelief', 'naturalMoon', 'cleanFontaine', 'detailSize', 'nativeSize', 'patchRect', 'occluder'].map(
      (name) => [name, gl.getUniformLocation(program, 'u_' + name)],
    ),
  );
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program, 'u_atlas'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_detailMap'), 1);
  gl.uniform1i(gl.getUniformLocation(program, 'u_detailAtlas'), 2);
  gl.uniform1i(gl.getUniformLocation(program, 'u_nativeMap'), 3);
  gl.uniform1i(gl.getUniformLocation(program, 'u_nativeAtlas'), 4);
  const patchTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE5);
  gl.bindTexture(gl.TEXTURE_2D, patchTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.uniform1i(gl.getUniformLocation(program, 'u_patch'), 5);
  const moonStencil = gl.createTexture();
  gl.activeTexture(gl.TEXTURE6);
  gl.bindTexture(gl.TEXTURE_2D, moonStencil);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.uniform1i(gl.getUniformLocation(program, 'u_moonStencil'), 6);
  return {gl, uniforms, texture, patchTexture, moonStencil,
    detail: detailTextures(gl), nativeDetail: detailTextures(gl, 3, 4)};
}

function uploadAtlas({gl, texture}, image, wrapLongitude = false) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapLongitude ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
}

function renderSphere(renderer, canvas, view) {
  const {gl, uniforms} = renderer;
  const {cx, cy, radius, ratio, world, basis, zoom = 1, detailSize = [0, 0],
    nativeSize = [0, 0], patchRect = [0, 0, 0, 0], occluder = [0, 0, 0]} = view;
  const extent = radius * 1.002;
  const left = Math.max(0, Math.floor((cx - extent) * ratio));
  const bottom = Math.max(0, Math.floor(canvas.height - (cy + extent) * ratio));
  const right = Math.min(canvas.width, Math.ceil((cx + extent) * ratio));
  const top = Math.min(canvas.height, Math.ceil(canvas.height - (cy - extent) * ratio));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (right <= left || top <= bottom) return;
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(left, bottom, right - left, top - bottom);
  gl.uniform2f(uniforms.center, cx * ratio, canvas.height - cy * ratio);
  gl.uniform1f(uniforms.radius, radius * ratio);
  gl.uniform3fv(uniforms.right, basis.right);
  gl.uniform3fv(uniforms.up, basis.up);
  gl.uniform3fv(uniforms.front, basis.front);
  gl.uniform3fv(uniforms.sea, world.sea);
  gl.uniform2fv(uniforms.span, world.span);
  gl.uniform1f(uniforms.zoom, zoom);
  const flatten = chartFlattening(world, zoom);
  gl.uniform1f(uniforms.flatten, flatten);
  if (flatten) gl.uniform2fv(uniforms.chartScale, chartScale(world));
  gl.uniform1i(uniforms.projection, world.projection);
  gl.uniform1i(uniforms.oceanRelief, Number(Boolean(world.oceanRelief)));
  gl.uniform1i(uniforms.naturalMoon, Number(Boolean(world.naturalMoon)));
  gl.uniform1i(uniforms.cleanFontaine, Number(world.id === 'Teyvat'));
  gl.uniform2fv(uniforms.detailSize, detailSize);
  gl.uniform2fv(uniforms.nativeSize, nativeSize);
  gl.uniform4fv(uniforms.patchRect, patchRect);
  gl.uniform3fv(uniforms.occluder, occluder);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST);
}

export class Globe {
  constructor({canvas, satellite, moonLink, lunarLayer, signals, stars, labels, fragment, labelObstacles, onSelect, onView, onFrame, onContextLost}) {
    Object.assign(this, {canvas, satellite, moonLink, lunarLayer, signals, stars, labels, labelObstacles, onSelect, onView, onFrame, onContextLost});
    Object.assign(this, initialize(canvas, fragment));
    this.compact = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 680;
    // 资源紧张时浏览器直接收走上下文：交给上层切换到 2D 平面地图，而不是停在白屏。
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.onContextLost?.();
    });
    const invalidate = () => {
      this.sphereState = null;
      this.requestFrame();
    };
    this.tiles = new DetailTiles(this.gl, this.detail, invalidate, {
      compact: this.compact, capacity: this.compact ? 20 : 30, concurrency: this.compact ? 3 : 5,
    });
    this.nativeTiles = new DetailTiles(this.gl, this.nativeDetail, invalidate, {
      compact: this.compact, capacity: this.compact ? 12 : 16, concurrency: this.compact ? 2 : 4, native: true,
    });
    this.orbitStarted = performance.now();
    // 紧凑设备不再为装饰月球常驻第二个 WebGL 上下文；霜月入口保留在地图菜单。
    if (!this.compact) {
      try {
        this.moonRenderer = initialize(satellite, fragment);
      } catch (error) {
        console.warn('霜月轨道渲染不可用', error);
      }
    }
    this.context = signals.getContext('2d');
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.lon = 0;
    this.lat = 0;
    this.zoom = 1;
    this.zoomTarget = 1;
    this.lastFrame = 0;
    this.spinAfter = 0;
    this.lockTime = -Infinity;
    this.raise = 0;
    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.bindInput();
    this.resize();
  }

  setWorld(world, image, zones) {
    const fromMoon = this.world?.id === 'MoonCanon';
    const toMoon = world.id === 'MoonCanon';
    this.stopLunarTransition();
    const departure = this.world && fromMoon !== toMoon && !this.reducedMotion.matches
      ? this.captureLunarFrame() : null;
    uploadAtlas(this, image);
    if (world.safety && this.moonSafety !== world.safety) {
      const {gl, moonStencil} = this;
      const {width, height, pixels} = world.safety;
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, moonStencil);
      const texels = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels);
      gl.activeTexture(gl.TEXTURE0);
      this.moonSafety = world.safety;
    }
    this.world = world;
    this.syncGroundPatch();
    this.sphereState = null;
    this.zones = zones;
    this.boundaryGeometry = null;
    this.boundaryRevealedAt = null;
    this.selected = null;
    this.raise = 0;
    this.raiseStarted = null;
    this.flight = null;
    this.velocity = null;
    [this.lon, this.lat] = world.home;
    this.center = null;
    this.zoom = this.zoomTarget = 1;
    this.spinTime = null;
    this.spinAfter = 0;
    this.labelFor = new Map();
    this.labelPlacement = new Map();
    this.labels.replaceChildren();
    this.orbitTime = null;
    if (departure) this.animateLunarChange(departure, toMoon);
    this.requestFrame();
  }

  captureLunarFrame() {
    const snapshot = this.lunarLayer;
    snapshot.width = this.canvas.width;
    snapshot.height = this.canvas.height;
    snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
    return {x: this.cx, y: this.cy, radius: this.radius * this.zoom,
      moon: this.moonLink.hidden ? null : this.moonPose};
  }

  stopLunarTransition() {
    for (const animation of this.lunarAnimations ?? []) animation.cancel();
    this.lunarAnimations = null;
    this.orbitResumeAt = null;
    this.lunarLayer.hidden = true;
    this.lunarLayer.width = this.lunarLayer.height = 1;
  }

  animateLunarChange(departure, toMoon) {
    const snapshot = this.lunarLayer;
    const timing = {duration: LUNAR_TRANSITION_DURATION, easing: 'cubic-bezier(.25,.67,.27,1)'};
    const dock = {x: this.width * .74, y: this.height * .57, radius: this.radius * .135};
    const fadeIn = [{opacity: 0}, {opacity: 1}];
    snapshot.hidden = false;

    if (toMoon) {
      const moon = departure.moon ?? dock;
      this.center = [moon.x / this.width, moon.y / this.height];
      this.zoom = moon.radius / this.radius;
      this.flyTo(...this.world.home, 1);
      this.flight.duration = LUNAR_TRANSITION_DURATION;
      this.lunarAnimations = [snapshot.animate([{opacity: 1}, {opacity: 0}], timing)];
    } else {
      const hasSatellite = this.world.id === 'Teyvat' && Boolean(this.moon);
      if (hasSatellite) {
        const angle = this.lastVisibleMoonAngle ?? this.orbitHomeAngle;
        const [x, y, depth] = this.orbitPoint(angle, this.radius);
        Object.assign(dock, {x, y, radius: this.moonRadius(this.radius, depth)});
        this.orbitResumeAt = performance.now() + timing.duration;
        this.orbitStarted = this.orbitResumeAt - (angle - this.orbitHomeAngle) * 8300;
      }
      const origin = `${departure.x}px ${departure.y}px`;
      const movement = `translate(${dock.x - departure.x}px, ${dock.y - departure.y}px)`;
      const scale = dock.radius / departure.radius;
      const start = {transformOrigin: origin, transform: 'translate(0, 0) scale(1)', opacity: 1};
      const docked = {transformOrigin: origin, transform: `${movement} scale(${scale})`};
      const dockOffset = .77;
      const retreat = snapshot.animate(hasSatellite ? [
        {...start, easing: timing.easing},
        {...docked, opacity: 1, offset: dockOffset},
        {...docked, opacity: 0},
      ] : [start, {...docked, opacity: 0}], hasSatellite ? {duration: timing.duration} : timing);
      this.lunarAnimations = [retreat, ...[this.canvas, this.labels, this.signals].map((element) =>
        element.animate(fadeIn, timing))];
      if (hasSatellite) {
        // Reveal the satellite underneath the snapshot once both occupy the same disk.
        this.lunarAnimations.push(this.satellite.animate([
          {opacity: 0, easing: 'steps(1, end)'}, {opacity: 1, offset: dockOffset}, {opacity: 1},
        ], {duration: timing.duration}));
      }
    }
    this.lunarAnimations[0].onfinish = () => this.stopLunarTransition();
  }

  setZones(zones) {
    this.zones = zones;
    this.boundaryGeometry = null;
    this.selected = zones.find((marker) => marker.zone.key === this.selected?.zone.key) ?? null;
    this.requestFrame();
  }

  setBoundarySmoothing(enabled) {
    this.smoothBoundaries = enabled;
    this.boundaryGeometry = null;
    this.requestFrame();
  }

  setMoon(image) {
    if (!this.moonRenderer) return;
    const thumbnail = document.createElement('canvas');
    thumbnail.width = 768;
    thumbnail.height = Math.round(768 * image.naturalHeight / image.naturalWidth);
    thumbnail.getContext('2d').drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
    uploadAtlas(this.moonRenderer, thumbnail, true);
    this.moon = {span: fullSpan, sea: [0, 0, 0], projection: 0, naturalMoon: true};
    this.requestFrame();
  }

  setGroundPatch(image, patch) {
    this.groundPatches ??= new Map();
    this.groundPatches.set(patch.map, {image, patch});
    this.syncGroundPatch();
  }

  syncGroundPatch() {
    const entry = this.groundPatches?.get(this.world?.id);
    if (!entry || entry.patch === this.groundPatch) return;
    const {image, patch} = entry;
    const {gl} = this;
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.patchTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE0);
    this.groundPatch = patch;
    this.sphereState = null;
    this.requestFrame();
  }

  resize() {
    const {width, height} = this.canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio, 1.45);
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    const phone = width <= 650;
    this.homeCenter = [phone ? .46 : width <= 900 ? .362 : .374, phone ? .305 : .485];
    this.radius = Math.min(width * (phone ? .428 : .326), height * (phone ? .25 : .368));
    for (const canvas of [this.canvas, this.satellite, this.signals, this.stars]) {
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
    }
    sky(this.stars, width, height, ratio);
    this.sphereState = null;
    this.orbitTime = null;
    this.requestFrame();
  }

  get cx() { return this.width * (this.center ?? this.homeCenter)[0]; }
  get cy() { return this.height * (this.center ?? this.homeCenter)[1]; }
  get magnified() { return Math.max(this.zoom, this.zoomTarget) > 1.01; }
  get orbitHomeAngle() { return this.cx > this.radius * 1.51 ? 2.58 : -.82; }

  select(zone) {
    if (zone !== this.selected) {
      this.raise = 0;
      this.raiseStarted = null;
    }
    this.selected = zone;
    this.lockTime = performance.now();
    this.requestFrame();
  }

  frameSelection() {
    if (!this.selected || !this.radius) return;
    const {width, height, radius} = this;
    this.flyTo(...frameZone(this.world, this.selected, {width, height, radius,
      obstacles: this.labelObstacles(), minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM}));
  }

  flyTo(lon, lat, zoom, center = null) {
    this.velocity = null;
    this.flight = null;
    this.spinAfter = performance.now() + 3100;
    const route = cameraRoute(this.lon, this.lat, lon, lat);
    this.zoomTarget = zoom;
    if (this.reducedMotion.matches) {
      this.lon = lon;
      this.lat = lat;
      this.zoom = zoom;
      this.center = center;
    } else {
      const from = Math.log(this.zoom);
      const to = Math.log(zoom);
      this.flight = {time: performance.now(), route, duration: 640 + 650 * route.distance / Math.PI,
        from, to, center, startCenter: this.center ?? this.homeCenter};
    }
    this.requestFrame();
  }

  setPlaying(playing) {
    this.playing = playing;
    this.requestFrame();
  }

  zoomBy(factor, anchor) {
    this.flight = null;
    this.spinAfter = performance.now() + 1700;
    const next = clamp(this.zoomTarget * factor, MIN_ZOOM, MAX_ZOOM);
    if (anchor && factor > 1 && next > this.zoomTarget) {
      const x = (anchor[0] - this.cx) / (this.radius * this.zoom);
      const y = (this.cy - anchor[1]) / (this.radius * this.zoom);
      if (x * x + y * y < .94) {
        const basis = cameraBasis(this.lon, this.lat);
        const remaining = this.zoom / next;
        if (chartFlattening(this.world, next) === 1) {
          const [[u, v]] = viewAtlasPoints(this.world, basis, this.zoom, x, y);
          const [sx, sy] = chartScale(this.world);
          this.lon = wrap((u - x * remaining * sx - .5) * this.world.span[0]);
          this.lat = clamp((.5 - v - y * remaining * sy) * this.world.span[1], -Math.PI / 2, Math.PI / 2);
        } else {
          const current = surfaceRay(x, y, basis);
          const later = surfaceRay(x * remaining, y * remaining, basis);
          this.lon = wrap(this.lon + Math.atan2(current[0], current[2]) - Math.atan2(later[0], later[2]));
          this.lat = clamp(this.lat + Math.asin(clamp(current[1], -1, 1)) - Math.asin(clamp(later[1], -1, 1)), -Math.PI / 2, Math.PI / 2);
        }
      }
    }
    this.zoomTarget = next;
    this.requestFrame();
  }

  reset() {
    if (!this.world || (this.world.id === 'MoonCanon' && this.flight && this.zoomTarget === 1)) return;
    this.flyTo(...this.world.home, 1);
  }

  requestFrame() {
    if (!this.disposed && !this.frame) this.frame = requestAnimationFrame((time) => this.draw(time));
  }

  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.stopLunarTransition();
    this.tiles.reset(null, 0);
    this.nativeTiles.reset(null, 0);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.moonRenderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  advance(time, elapsed) {
    const ease = this.reducedMotion.matches ? 1 : 1 - Math.exp(-elapsed / 84);
    if (this.flight) {
      const {route, duration, from, to, center, startCenter} = this.flight;
      const progress = clamp((time - this.flight.time) / duration, 0, 1);
      const t = progress * progress * (3 - 2 * progress);
      [this.lon, this.lat] = route.at(t);
      const base = interpolate(from, to, t);
      const retreat = Math.sin(Math.PI * t) ** 2
        * Math.min(route.distance * .62, Math.max(0, base - Math.log(MIN_ZOOM)));
      this.zoom = Math.exp(base - retreat);
      this.center = startCenter.map((value, axis) => interpolate(value, (center ?? this.homeCenter)[axis], t));
      if (progress === 1) {
        this.zoom = this.zoomTarget;
        this.center = center;
        this.flight = null;
      }
    } else {
      this.zoom = interpolate(this.zoom, this.zoomTarget, ease);
      if (Math.abs(this.zoom - this.zoomTarget) < .001) this.zoom = this.zoomTarget;
      if (this.velocity) {
        this.rotate(this.velocity.x * elapsed, this.velocity.y * elapsed);
        const decay = Math.exp(-elapsed / 190);
        this.velocity.x *= decay;
        this.velocity.y *= decay;
        if (Math.abs(this.velocity.x) + Math.abs(this.velocity.y) < .01) this.velocity = null;
      }
    }
  }

  draw(time) {
    this.frame = 0;
    if (!this.world) return;
    this.advance(time, clamp(time - this.lastFrame, 1, 34));
    this.lastFrame = time;
    const overview = this.world.id === 'Teyvat' && this.zoom <= 1.5;
    const autoSpin = overview && !this.selected && this.zoom >= 1 && this.zoomTarget >= 1 && this.zoomTarget <= 1.5
      && !this.compact && !this.reducedMotion.matches;
    if (autoSpin && time >= this.spinAfter && !this.pointer && !this.flight && !this.velocity) {
      this.spinTime ??= time;
      if (time - this.spinTime >= 32) {
        this.lon = wrap(this.lon - Math.min(80, time - this.spinTime) * SPIN_RATE);
        this.spinTime = time;
      }
    } else {
      this.spinTime = null;
    }
    const {ratio, cx, cy, width, height} = this;
    const radius = this.radius * this.zoom;
    // 双指事件在一帧内可能连发多次：这里统一聚合应用一次，锚点始终是手势
    // 开始时固定的地图坐标；跨球面/平面混合过渡同样由 cameraAtAnchor 保持。
    this.applyPinch();
    const basis = cameraBasis(this.lon, this.lat);
    const moving = Boolean(this.flight || this.velocity || this.pointer?.moved || this.pinch || this.zoom !== this.zoomTarget);
    const settled = this.cameraMoving && !moving;
    const worldChanged = this.lastTileWorld !== this.world;
    const focused = Boolean(this.selected);
    const detailFocusChanged = this.lastTileFocus !== focused;
    this.cameraMoving = moving;
    const pose = [this.lon, this.lat, radius, cx, cy, ratio];
    const changed = !this.sphereState || pose.some((value, index) => value !== this.sphereState[index]);
    // 拖动中密集重算可见瓦片会不断中止在途请求（弱网浪费且打断解码），
    // 紧凑设备在移动期间放宽到飞行航拍的同一节奏，静止后照常补齐。
    // 捏合期间 zoom 逐帧变化会反复整层重置瓦片，直接暂停更新，抬指后由
    // settled 一次性补齐（2048 原生层照常在静止后进入）。
    const tileInterval = this.flight || (this.compact && moving) ? 200 : 110;
    if (!this.pinch
      && (worldChanged || settled || detailFocusChanged || (changed && time - (this.tileUpdateAt ?? -Infinity) >= tileInterval))) {
      const detailView = {cx, cy, width, height, radius, ratio, basis, focused, zoom: this.zoom, lon: this.lon, lat: this.lat};
      this.tiles.update(this.world, detailView);
      this.nativeTiles.update(this.world, detailView);
      this.tileUpdateAt = time;
      this.lastTileWorld = this.world;
      this.lastTileFocus = focused;
    }
    if (changed || settled || detailFocusChanged) {
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
      if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
      renderSphere(this, this.canvas, {
        cx, cy, ratio, radius, world: this.world, basis,
        zoom: this.zoom, detailSize: this.tiles.size, nativeSize: this.nativeTiles.size,
        patchRect: this.patchInAtlas(),
      });
      this.sphereState = pose;
      // The player captures and refracts this raster. Refresh at a settled pose,
      // rather than re-encoding a succession of transient camera frames.
      if (settled || worldChanged || (!moving && time - (this.backdropAt ?? -Infinity) >= 400)) {
        this.backdropAt = time;
        this.onFrame?.(this.canvas);
      }
    }
    const orbit = this.moon && overview;
    this.drawSatellite(time, radius, orbit);
    const lockVisible = this.drawSignals(time, radius, basis, orbit);
    this.onView?.(this.zoomTarget < MAX_ZOOM, this.zoomTarget > MIN_ZOOM, this.magnified);
    // 紧凑设备上播放中的锁定光环不再常驻脉冲（那会让静止画面持续整帧
    // 重绘）；选中后的入场脉冲与移动、标签动画保留。
    const pulse = lockVisible
      && (this.compact ? time - this.lockTime < 1750 : (this.playing || time - this.lockTime < 1750))
      && !this.reducedMotion.matches;
    if (this.flight || this.velocity || this.zoom !== this.zoomTarget || pulse
      || (this.selected && this.raiseStarted != null && this.raise < 1)
      || autoSpin || (orbit && !this.reducedMotion.matches)) {
      this.requestFrame();
    }
  }

  // 捏合的每帧聚合结果只在 draw()（或手势结束）里消费一次。
  applyPinch() {
    const latest = this.pinchLatest;
    if (!this.pinch || !latest) return;
    this.pinchLatest = null;
    const zoom = clamp(this.pinch.zoom * latest.distance / this.pinch.distance, MIN_ZOOM, MAX_ZOOM);
    this.zoom = this.zoomTarget = zoom;
    if (this.pinch.anchored && this.world === this.pinch.world) {
      const x = (latest.center[0] - this.cx) / (this.radius * zoom);
      const y = (this.cy - latest.center[1]) / (this.radius * zoom);
      if (x * x + y * y < 1.1) {
        [this.lon, this.lat] = cameraAtAnchor(this.world, zoom, x, y, this.pinch.anchored, this.lon, this.lat);
      }
    }
    this.spinAfter = performance.now() + 2150;
  }

  orbitPoint(angle, radius) {
    const radial = orbitDirection(angle);
    const extent = radius * ORBIT_RADIUS;
    return [
      this.cx + radial[0] * extent,
      this.cy - radial[1] * extent,
      -radial[2],
      radial,
    ];
  }

  moonRadius(radius, depth) {
    return Math.max(12, radius * (.132 - depth * .012));
  }

  patchInAtlas() {
    const patch = this.groundPatch;
    if (!patch || patch.map !== this.world.id) return;
    const {imageWidth, imageHeight} = this.world.pyramid;
    return [patch.left * 4 / imageWidth, patch.top * 4 / imageHeight,
      patch.width * 4 / imageWidth, patch.height * 4 / imageHeight];
  }

  drawSatellite(time, radius, active) {
    this.satellite.hidden = !active;
    if (!active) {
      this.moonLink.hidden = true;
      this.orbitTime = null;
      this.moonPose = null;
      return;
    }
    if (this.orbitTime !== null && time - this.orbitTime < 32) return;
    if (this.moonRenderer?.gl.isContextLost()) {
      this.satellite.hidden = true;
      this.moonLink.hidden = true;
      return;
    }
    this.orbitTime = time;
    const orbitClock = Math.max(time, this.orbitResumeAt ?? time);
    const phase = this.reducedMotion.matches ? 0 : (orbitClock - this.orbitStarted) / 8300;
    const angle = this.orbitHomeAngle + phase;
    const {ratio} = this;
    const [cx, cy, depth, radial] = this.orbitPoint(angle, radius);
    const size = this.moonRadius(radius, depth);
    this.moonPose = {x: cx, y: cy, radius: size};
    const distance = Math.hypot(cx - this.cx, cy - this.cy);
    renderSphere(this.moonRenderer, this.satellite, {
      cx, cy, ratio, radius: size, world: this.moon,
      basis: lockedMoonBasis(radial),
      occluder: depth > 0 ? [this.cx * ratio, this.satellite.height - this.cy * ratio, radius * ratio] : [0, 0, 0],
    });
    const masked = depth > 0 && distance < radius + size * .32;
    this.moonLink.hidden = masked || cx < size || cx > this.width - size * .5 || cy < 55 || cy > this.height - 68;
    if (!this.moonLink.hidden) {
      this.lastVisibleMoonAngle = angle;
      this.moonLink.style.left = cx + 'px';
      this.moonLink.style.top = cy + 'px';
      this.moonLink.style.setProperty('--moon-size', Math.max(28, size * 2) + 'px');
    }
  }

  drawOrbit(radius) {
    const {context: ctx, cx, cy, ratio} = this;
    const major = radius * ORBIT_RADIUS;
    const minor = major * orbitAspect;
    ctx.save();
    if (this.moonPose) {
      const moon = this.moonPose;
      ctx.beginPath();
      ctx.rect(0, 0, this.width, this.height);
      ctx.moveTo(moon.x + moon.radius, moon.y);
      ctx.arc(moon.x, moon.y, moon.radius, 0, TAU);
      ctx.clip('evenodd');
    }
    ctx.lineWidth = 1 / ratio;
    ctx.strokeStyle = 'rgba(216,225,222,.35)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, major, minor, orbitRoll, Math.PI, TAU);
    ctx.stroke();

    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.moveTo(cx + radius, cy);
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.clip('evenodd');
    ctx.strokeStyle = 'rgba(216,225,222,.24)';
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, major, minor, orbitRoll, 0, Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  drawSignals(time, radius, basis, orbit) {
    const {context: ctx, ratio, cx, cy} = this;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (orbit) this.drawOrbit(radius);
    drawGlobeBoundaries(this, time, radius, basis);
    const lift = this.drawRaisedRegion(radius, basis, time);
    const visible = [];
    for (const region of this.world.regions) {
      const [px, py, depth] = projectAtlas(this.world, basis, this.zoom, region.uv, region.vector);
      if (depth < .16) continue;
      const x = cx + px * radius;
      const y = cy - py * radius;
      if (x < 6 || x > this.width - 6) continue;
      visible.push({region, x, y, depth});
    }
    let active;
    if (this.selected) {
      const {uv, vector} = this.selected;
      const [px, py, depth] = projectAtlas(this.world, basis, this.zoom, uv, vector);
      const x = cx + px * radius;
      const y = cy - py * radius - lift;
      const visibleDepth = this.labelFor.has(this.selected) ? .10 : .16;
      if (depth >= visibleDepth && x >= 0 && x <= this.width && y >= 0 && y <= this.height) {
        active = {region: this.selected, x, y, depth, active: true};
        visible.push(active);
      }
    }
    ctx.fillStyle = '#cbf1cf';
    for (const {x, y, depth, active} of this.drawLabels(visible)) {
      if (active) continue;
      ctx.globalAlpha = clamp(depth, .42, .88);
      ctx.beginPath();
      ctx.arc(x, y, 2.1, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (active && !lift) {
      this.drawLock(time, active.x, active.y);
      return true;
    }
    return false;
  }

  drawRaisedRegion(radius, basis, time) {
    if (!this.selected) return 0;
    const zone = this.selected;
    const {context: ctx, cx, cy} = this;
    const cached = this.elevationGeometry;
    const rings = cached?.zone === zone && cached.pose === this.sphereState
      ? cached.rings : zone.outlines.flatMap((ring) => {
      const visible = projectVisibleOutline(this.world, basis, this.zoom, ring);
      return visible.length >= 3
        ? [roundElevationRing(visible.map(([x, y]) => [cx + x * radius, cy - y * radius]))] : [];
    });
    this.elevationGeometry = {zone, pose: this.sphereState, rings};
    if (!rings.length) return 0;
    this.raiseStarted ??= time;
    const progress = this.reducedMotion.matches ? 1 : clamp((time - this.raiseStarted) / 460, 0, 1);
    this.raise = 1 - (1 - progress) ** 3;
    const lift = this.raise * clamp(4 + zone.angularSize * radius * .09, 6, 16);
    if (lift < .2) return 0;

    const footprint = new Path2D();
    const top = new Path2D();
    const sides = new Path2D();
    let left = Infinity, right = -Infinity, topY = Infinity, bottom = -Infinity;
    for (const ring of rings) {
      footprint.moveTo(...ring[0]);
      top.moveTo(ring[0][0], ring[0][1] - lift);
      for (const [index, [x, y]] of ring.entries()) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        topY = Math.min(topY, y);
        bottom = Math.max(bottom, y);
        const [ax, ay] = ring.at(index - 1);
        footprint.lineTo(x, y);
        top.lineTo(x, y - lift);
        sides.moveTo(ax, ay - lift);
        sides.lineTo(x, y - lift);
        sides.lineTo(x, y);
        sides.lineTo(ax, ay);
        sides.closePath();
      }
      footprint.closePath();
      top.closePath();
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.raise * 2);
    ctx.shadowBlur = 5 + lift * .65;
    ctx.shadowOffsetY = 2;
    ctx.shadowColor = '#020b13a6';
    ctx.fillStyle = '#08162170';
    ctx.fill(footprint, 'evenodd');
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#274750';
    ctx.fill(sides);
    ctx.save();
    ctx.clip(top, 'evenodd');
    // Crop to the lifted area so each elevation frame samples only its own map pixels.
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(topY));
    const width = Math.min(this.width, Math.ceil(right)) - x;
    const height = Math.min(this.height, Math.ceil(bottom)) - y;
    if (width > 0 && height > 0) {
      const scaleX = this.canvas.width / this.width;
      const scaleY = this.canvas.height / this.height;
      ctx.drawImage(this.canvas, x * scaleX, y * scaleY, width * scaleX, height * scaleY,
        x, y - lift, width, height);
      ctx.fillStyle = '#cfefe118';
      ctx.fillRect(x, y - lift, width, height);
    }
    ctx.restore();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#e2f9e7d8';
    ctx.stroke(top);
    ctx.restore();
    return lift;
  }

  drawLock(time, x, y) {
    const ctx = this.context;
    const elapsed = time - this.lockTime;
    if (!this.reducedMotion.matches && (elapsed < 1750 || this.playing)) {
      const fraction = (Math.max(0, elapsed) % 1750) / 1750;
      ctx.strokeStyle = 'rgba(255,151,109,' + (.49 * (1 - fraction)) + ')';
      ctx.beginPath();
      ctx.arc(x, y, 13 + 31 * fraction, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffd4a7d9';
    ctx.lineWidth = 1.2;
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const angle = quarter * Math.PI / 2;
      ctx.beginPath();
      ctx.arc(x, y, 11, angle + .22, angle + 1.32);
      ctx.stroke();
    }
    ctx.shadowBlur = 14;
    ctx.shadowColor = '#ff845a';
    ctx.fillStyle = '#ff9c70';
    ctx.beginPath();
    ctx.arc(x, y, 3.25, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  drawLabels(visible) {
    const font = this.width <= 650 ? 12 : 14;
    const height = Math.ceil(font * 1.2) + 12;
    const focus = document.activeElement;
    const priority = ({region, active}) => active ? 3
      : (this.labelFor.get(region) === focus ? 2 : Number(this.labelFor.has(region)));
    const choices = visible.sort((a, b) => priority(b) - priority(a));
    const placed = choices.length ? this.labelObstacles() : [];
    const retained = new Set();
    const displayed = [];
    for (const item of choices) {
      const {region, x, y, active} = item;
      const name = active ? region.zone.name : region.name;
      const span = Math.ceil(name.length * font * 1.04) + 22;
      const top = y - height / 2;
      const offset = active ? 12 : 2;
      const alternatives = [0, 14, 30, 50, 62, 78, 94].flatMap((gap) => [x + offset + gap, x - span - offset - gap]
        .map((left, index) => ({left, right: left + span, top, bottom: top + height, onLeft: index === 1, gap})));
      if (active) {
        const left = clamp(x - span / 2, 7, this.width - span - 7);
        const labelTop = y - height - 12;
        alternatives.splice(2, 0, {left, right: left + span, top: labelTop,
          bottom: labelTop + height, above: true, gap: 0});
      }
      const previous = this.labelPlacement.get(region);
      const preferred = previous && alternatives.find((option) =>
        option.onLeft === previous.onLeft && option.above === previous.above && option.gap === previous.gap);
      const fits = (bounds) => bounds.left >= 7 && bounds.right <= this.width - 7
        && bounds.top >= 7 && bounds.bottom <= this.height - 7;
      const unobstructed = (bounds) => fits(bounds) && !placed.some((other) => overlaps(bounds, other, 5));
      // Keep visible labels attached to their map anchors throughout camera movement.
      const keepPlacement = preferred && (active || (this.cameraMoving
        ? fits(preferred) : unobstructed(preferred)));
      let box = keepPlacement ? preferred : alternatives.find(unobstructed);
      if (active && (!box || !fits(box))) {
        const nearest = box ?? preferred ?? alternatives[2];
        const left = clamp(nearest.left, 7, Math.max(7, this.width - span - 7));
        const top = clamp(nearest.top, 7, Math.max(7, this.height - height - 7));
        box = {...nearest, left, right: left + span, top, bottom: top + height};
      }
      if (!box) continue;
      let label = this.labelFor.get(region);
      if (!label) {
        label = document.createElement(active ? 'span' : 'button');
        label.className = active ? 'active-zone-label' : 'place';
        label.textContent = name;
        if (!active) {
          label.type = 'button';
          label.addEventListener('click', () => this.flyTo(region.lon, region.lat, 2.15));
        }
        this.labels.append(label);
        this.labelFor.set(region, label);
      }
      label.classList.toggle('label-left', Boolean(box.onLeft));
      label.classList.toggle('label-above', Boolean(box.above));
      label.style.transform = `translate(${box.left}px,${box.top}px)`;
      label.style.setProperty('--region-label-gap', `${box.gap}px`);
      if (box.above) label.style.setProperty('--label-anchor-x', `${x - box.left}px`);
      this.labelPlacement.set(region, box);
      placed.push(box);
      retained.add(region);
      displayed.push(item);
    }
    for (const [region, label] of this.labelFor) {
      if (retained.has(region)) continue;
      label.remove();
      this.labelFor.delete(region);
      this.labelPlacement.delete(region);
    }
    return displayed;
  }

  zoneAt(x, y) {
    if (!this.world) return null;
    const radius = this.radius * this.zoom;
    const px = (x - this.cx) / radius, py = (this.cy - y) / radius;
    if (px * px + py * py >= .99) return null;
    const coordinates = viewAtlasPoints(this.world, cameraBasis(this.lon, this.lat), this.zoom, px, py);
    if (this.world.id === 'MoonCanon') {
      // The fog uses the visible lunar chart at the seam, as does picking.
      const [[u, v]] = coordinates;
      if (!moonCanonReachable(this.world.safety, u, v)) return null;
      return this.zones.find(({contains}) => contains(u, v)) ?? null;
    }
    return this.zones.find(({contains}) => coordinates.some(([u, v]) => contains(u, v))) ?? null;
  }

  rotate(x, y) {
    if (!this.world) return;
    this.spinAfter = performance.now() + 2150;
    const size = Math.max(150, this.radius * this.zoom);
    const flatten = chartFlattening(this.world, this.zoom);
    const vertical = flatten ? chartScale(this.world)[1] * this.world.span[1] : 1.55;
    this.lon = wrap(this.lon - x * interpolate(1.55, 1, flatten) / size);
    this.lat = clamp(this.lat + y * interpolate(1.55, vertical, flatten) / size, -Math.PI / 2, Math.PI / 2);
  }

  bindInput() {
    const canvas = this.canvas;
    const surface = canvas.parentElement;
    const fingers = new Map();
    const coordinates = (event) => {
      const box = canvas.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    function touchSpan() {
      const [[ax, ay], [bx, by]] = fingers.values();
      return {distance: Math.hypot(ax - bx, ay - by), center: [(ax + bx) / 2, (ay + by) / 2]};
    }
    surface.addEventListener('pointerdown', (event) => {
      const onCanvas = event.target === canvas;
      if (event.pointerType === 'touch') {
        if (!onCanvas && !this.labels.contains(event.target)) return;
        if (!this.world) return;
        if (fingers.size >= 2) return;
        fingers.set(event.pointerId, coordinates(event));
        if (fingers.size === 2) {
          const span = touchSpan();
          // 从当前 zoom 起拍并冻结缩放动画；锚点取双指中点对应的地图角坐标。
          this.zoomTarget = this.zoom;
          const x = (span.center[0] - this.cx) / (this.radius * this.zoom);
          const y = (this.cy - span.center[1]) / (this.radius * this.zoom);
          this.pinch = {
            distance: span.distance || 1,
            zoom: this.zoom,
            anchored: x * x + y * y < .9
              ? viewportAngles(this.world, cameraBasis(this.lon, this.lat), this.zoom, x, y)
              : null,
            world: this.world,
          };
          this.pinchLatest = null;
          for (const id of fingers.keys()) canvas.setPointerCapture(id);
          this.pointer = null;
          this.flight = null;
          this.velocity = null;
          this.requestFrame();
          return;
        }
      }
      if (!onCanvas || !event.isPrimary || event.button !== 0) return;
      this.flight = null;
      this.velocity = null;
      this.spinAfter = performance.now() + 2150;
      this.pointer = {id: event.pointerId, start: coordinates(event), last: coordinates(event), time: performance.now(), moved: false};
      canvas.setPointerCapture(event.pointerId);
      this.requestFrame();
    });
    surface.addEventListener('pointermove', (event) => {
      const [x, y] = coordinates(event);
      if (fingers.has(event.pointerId)) {
        fingers.set(event.pointerId, [x, y]);
        if (this.pinch && fingers.size === 2) {
          // 只记录最新跨度/中点，实际相机更新在下一帧 applyPinch 里做一次。
          const span = touchSpan();
          if (span.distance > 0) this.pinchLatest = span;
          this.requestFrame();
          return;
        }
      }
      if (event.target !== canvas) return;
      const p = this.pointer;
      if (p?.id === event.pointerId) {
        if (!p.moved && Math.hypot(x - p.start[0], y - p.start[1]) < 4) return;
        const time = performance.now();
        const elapsed = Math.max(10, time - p.time);
        const dx = x - p.last[0];
        const dy = y - p.last[1];
        p.motion = {x: dx / elapsed, y: dy / elapsed};
        p.last = [x, y];
        p.time = time;
        p.moved = true;
        this.rotate(dx, dy);
      } else {
        canvas.classList.toggle('target', Boolean(this.zoneAt(x, y)));
        return;
      }
      this.requestFrame();
    });
    surface.addEventListener('pointerup', (event) => {
      const trackedTouch = fingers.delete(event.pointerId);
      if (this.pinch && trackedTouch) {
        // 先消费最后一帧未应用的跨度，再收尾捏合。
        this.applyPinch();
        this.pinch = null;
        this.pinchLatest = null;
        if (fingers.size === 1) {
          // 放开一指：剩余手指直接接续拖动，且已视为移动，不会再触发点选。
          const [id] = fingers.keys();
          const [x, y] = fingers.get(id);
          this.pointer = {id, start: [x, y], last: [x, y], time: performance.now(), moved: true};
          this.spinAfter = performance.now() + 2150;
        }
        this.requestFrame();
        return;
      }
      const p = this.pointer;
      if (p?.id !== event.pointerId) return;
      if (!p.moved) {
        const target = this.zoneAt(...coordinates(event));
        if (target) this.onSelect(target);
      } else if (performance.now() - p.time < 65 && !this.reducedMotion.matches) {
        this.velocity = p.motion;
      }
      this.pointer = null;
      this.requestFrame();
    });
    surface.addEventListener('pointercancel', (event) => {
      const trackedTouch = fingers.delete(event.pointerId);
      if (this.pinch && trackedTouch) {
        this.pinch = null;
        this.pinchLatest = null;
        this.requestFrame();
      }
      if (this.pointer?.id === event.pointerId) {
        this.pointer = null;
        this.requestFrame();
      }
    });
    canvas.addEventListener('pointerleave', () => {
      canvas.classList.remove('target');
    });
    canvas.addEventListener('wheel', (event) => {
      if (!this.world) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
      this.zoomBy(Math.exp(-clamp(delta, -150, 150) * .0045), coordinates(event));
    }, {passive: false});
    canvas.addEventListener('keydown', (event) => {
      const arrows = {ArrowLeft: [-25, 0], ArrowRight: [25, 0], ArrowUp: [0, -25], ArrowDown: [0, 25]};
      if (Object.hasOwn(arrows, event.key)) {
        this.flight = null;
        this.rotate(...arrows[event.key]);
        this.requestFrame();
      } else if (event.key === '+' || event.key === '=') this.zoomBy(1.16);
      else if (event.key === '-') this.zoomBy(1 / 1.16);
      else if (event.key === 'Enter') {
        const target = this.zoneAt(this.cx, this.cy);
        if (target) this.onSelect(target);
      } else return;
      event.preventDefault();
    });
  }
}
