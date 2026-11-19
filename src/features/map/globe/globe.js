import {DetailTiles, detailTextures} from './detail-tiles.js';
import {drawGlobeBoundaries} from './boundaries.js';
import {frameZone, placeReliefCard, reliefCardSize} from './framing.js';
import {lockedMoonBasis, orbitDirection, ORBIT_RADIUS} from './lunar-orbit.js';
import {moonCanonReachable} from '../mooncanonSafety.js';
import {mapRasterScale} from '../mapRasterScale.js';
import {retireReliefDock} from '../reliefDockMotion.js';
import {
  atlasAngles, cameraAtAnchor, cameraBasis, cameraRoute, chartFlattening, chartScale, clamp, direction, dot, fullSpan,
  projectAtlas, projectVisibleOutline, surfaceRay, viewAtlasPoints, viewportAngles, wrap,
} from './projection.js';

const TAU = 2 * Math.PI;
const interpolate = (a, b, factor) => a + (b - a) * factor;
const MIN_ZOOM = .53;
const MAX_ZOOM = 18;
const ORBIT_MAX_ZOOM = 1.5;
const ATMOSPHERE_EXTENT = 1.092;
const MOON_PAINT_INTERVAL = 32;
const BASE_RASTER_SCALE = 1.45;
const LUNAR_TRANSITION_DURATION = 820;
const SPIN_RATE = TAU / 165000;
const COMPACT_SPIN_INTERVAL = 50;
const centeredHome = [.5, .5];
const orbitMajor = orbitDirection(0);
const orbitMinor = orbitDirection(Math.PI / 2);
const orbitRoll = Math.atan2(-orbitMajor[1], orbitMajor[0]);
const orbitAspect = Math.hypot(orbitMinor[0], orbitMinor[1]);

function overlaps(a, b, padding = 0) {
  return a.left < b.right + padding && a.right > b.left - padding
    && a.top < b.bottom + padding && a.bottom > b.top - padding;
}

function roundElevationRing(points) {
  const outline = [];
  for (const [index, point] of points.entries()) {
    const [x, y] = point;
    const [ax, ay] = points.at(index - 1);
    const [bx, by] = points[(index + 1) % points.length];
    const a = Math.hypot(ax - x, ay - y);
    const b = Math.hypot(bx - x, by - y);
    if (!a || !b) {
      outline.push(point);
      continue;
    }
    const ux = (ax - x) / a;
    const uy = (ay - y) / a;
    const vx = (bx - x) / b;
    const vy = (by - y) / b;
    const angle = ux * vx + uy * vy;
    const trim = Math.min(9, a * .25, b * .25);
    // Preserve straight runs, fine bends and narrow tips.
    if (angle < -.995 || trim < .5 || angle > .5) {
      outline.push(point);
      continue;
    }
    for (const t of [0, .25, .5, .75, 1]) {
      const before = (1 - t) ** 2 * trim;
      const after = t ** 2 * trim;
      outline.push([x + before * ux + after * vx, y + before * uy + after * vy]);
    }
  }
  return outline;
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

function installCloudField(gl) {
  const size = 32;
  const density = new Uint8Array(size ** 3);
  // Repeatable 3D noise keeps the cloud field continuous at the poles and map seam.
  let seed = 0x7231c49d;
  for (let index = 0; index < density.length; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    density[index] = seed >>> 24;
  }
  gl.activeTexture(gl.TEXTURE8);
  gl.bindTexture(gl.TEXTURE_3D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, density);
  gl.activeTexture(gl.TEXTURE0);
}

function initialize(canvas, fragment) {
  const gl = canvas.getContext('webgl2', {
    alpha: true, antialias: false, depth: false, premultipliedAlpha: true, preserveDrawingBuffer: true,
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
    ['center', 'radius', 'right', 'up', 'front', 'sea', 'span', 'zoom', 'flatten', 'chartScale',
      'projection', 'oceanRelief', 'naturalMoon', 'cleanFontaine', 'detailSize', 'nativeSize',
      'patchRect', 'fontaineSeaRect', 'occluder', 'orbitLook', 'orbitalMipSpread', 'cloudRotation',
      'lunarPreviewBasis', 'hasLunarPreview', 'lunarMapBlend'].map(
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
  const fontaineSeaTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE7);
  gl.bindTexture(gl.TEXTURE_2D, fontaineSeaTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.uniform1i(gl.getUniformLocation(program, 'u_fontaineSea'), 7);
  installCloudField(gl);
  gl.uniform1i(gl.getUniformLocation(program, 'u_cloudField'), 8);
  return {gl, uniforms, texture, patchTexture, moonStencil, fontaineSeaTexture,
    detail: detailTextures(gl), nativeDetail: detailTextures(gl, 3, 4)};
}

function uploadAtlas({gl, texture}, image) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
}

function renderSphere(renderer, canvas, view) {
  const {gl, uniforms} = renderer;
  const {cx, cy, radius, ratio, world, basis, zoom = 1, detailSize = [0, 0],
    nativeSize = [0, 0], patchRect = [0, 0, 0, 0], fontaineSeaRect = [0, 0, 0, 0],
    occluder = [0, 0, 0], cloudAngle = 0, lunarMapBlend = 1, lunarPreviewBasis} = view;
  // Fade the distant lighting as the map zooms in and terrain needs to be readable.
  const hasOrbitLook = world.id === 'Teyvat' || world.naturalMoon || world.projection === 2;
  const close = hasOrbitLook ? clamp((zoom - 1.12) / 1.12, 0, 1) : 1;
  const orbitLook = 1 - close * close * (3 - 2 * close);
  const hasAtmosphere = world.projection === 2 ? lunarPreviewBasis && lunarMapBlend < 1 : orbitLook > 0;
  const extent = radius * (hasAtmosphere ? ATMOSPHERE_EXTENT : 1.002);
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
  gl.uniform4fv(uniforms.fontaineSeaRect, fontaineSeaRect);
  gl.uniform3fv(uniforms.occluder, occluder);
  gl.uniform1f(uniforms.orbitLook, orbitLook);
  gl.uniform1f(uniforms.orbitalMipSpread, renderer.mobileDevice ? .25 : .65);
  gl.uniform2f(uniforms.cloudRotation, Math.cos(cloudAngle), Math.sin(cloudAngle));
  gl.uniform1f(uniforms.lunarMapBlend, lunarMapBlend);
  gl.uniform1i(uniforms.hasLunarPreview, Number(Boolean(lunarPreviewBasis)));
  if (lunarPreviewBasis) gl.uniformMatrix3fv(uniforms.lunarPreviewBasis, false, lunarPreviewBasis);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST);
}

export class Globe {
  constructor({canvas, satellite, moonLink, lunarLayer, signals, stars, labels, fragment, mobileDevice,
    labelObstacles, reliefEnabled, reliefTarget, onReliefReveal, onSelect, onView, onFrame, onContextLost}) {
    Object.assign(this, {canvas, satellite, moonLink, lunarLayer, signals, stars, labels, mobileDevice,
      labelObstacles, reliefEnabled, reliefTarget, onReliefReveal, onSelect, onView, onFrame, onContextLost});
    Object.assign(this, initialize(canvas, fragment));
    this.compact = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 680;
    // 资源紧张时浏览器直接收走上下文：交给上层切换到 2D 平面地图，而不是停在白屏。
    this.onContextLoss = () => {
      this.onContextLost?.();
    };
    canvas.addEventListener('webglcontextlost', this.onContextLoss);
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
    this.onVisibility = () => {
      if (document.hidden) {
        clearTimeout(this.spinWake);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
      } else {
        this.requestFrame();
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.bindInput();
    this.resize();
  }

  setWorld(world, image, zones) {
    const fromMoon = this.world?.id === 'MoonCanon';
    const toMoon = world.id === 'MoonCanon';
    // 先抓当前 2D 合成（旧星球＋信号层），再停掉在途过渡：中途快切不丢快照。
    const departure = this.world && fromMoon !== toMoon && !this.reducedMotion.matches
      ? this.captureLunarFrame() : null;
    this.stopLunarTransition(Boolean(departure));
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
    this.select(null);
    this.flight = null;
    this.velocity = null;
    [this.lon, this.lat] = world.home;
    this.center = null;
    this.zoom = this.zoomTarget = 1;
    this.lunarArrival = null;
    if (departure && toMoon) {
      // 首帧起点直接落在离场卡位大小，避免先画满屏再缩小；真正的飞往 home
      // 延到首帧 draw 末尾由 pending 消费触发。
      const moon = departure.moon ?? this.lunarDock;
      this.center = [moon.x / this.width, moon.y / this.height];
      this.zoom = this.zoomTarget = moon.radius / this.radius;
      this.lunarArrival = {basis: moon.basis, firstFrame: null};
      this.signals.style.opacity = this.labels.style.opacity = '0';
    }
    this.pendingLunarChange = departure ? {departure, toMoon} : null;
    this.spinTime = null;
    this.spinAfter = 0;
    this.clearSelectionLabel();
    this.moonPaintAt = null;
    this.requestFrame();
  }

  captureLunarFrame() {
    const snapshot = this.lunarLayer;
    const {cx: x, cy: y, ratio} = this;
    const radius = this.radius * this.zoom;
    const {width, height} = this.canvas;
    // The returning moon carries only the visible lunar disk, not the whole viewport.
    const crop = this.world.id === 'MoonCanon';
    const pad = radius + 2;
    const left = crop ? clamp(Math.floor((x - pad) * ratio), 0, width - 1) : 0;
    const top = crop ? clamp(Math.floor((y - pad) * ratio), 0, height - 1) : 0;
    const right = crop ? clamp(Math.ceil((x + pad) * ratio), left + 1, width) : width;
    const bottom = crop ? clamp(Math.ceil((y + pad) * ratio), top + 1, height) : height;
    snapshot.width = right - left;
    snapshot.height = bottom - top;
    const frame = {left: left / ratio, top: top / ratio};
    Object.assign(snapshot.style, {
      left: `${frame.left}px`, top: `${frame.top}px`,
      width: `${snapshot.width / ratio}px`, height: `${snapshot.height / ratio}px`,
    });
    const context = snapshot.getContext('2d');
    const region = [left, top, snapshot.width, snapshot.height, 0, 0, snapshot.width, snapshot.height];
    context.drawImage(this.canvas, ...region);
    context.drawImage(this.signals, ...region);
    return {...frame, x, y, radius,
      moon: this.moonPose?.visible ? this.moonPose : null};
  }

  get lunarDock() {
    return {x: this.width * (this.compact ? .76 : .74), y: this.height * (this.compact ? .61 : .57),
      radius: this.radius * .135 * (this.compact ? 1.22 : 1)};
  }

  stopLunarTransition(keepSnapshot = false) {
    for (const animation of this.lunarAnimations ?? []) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.lunarAnimations = null;
    this.pendingLunarChange = null;
    this.orbitResumeAt = null;
    // 只取消本次过渡自己的飞行，不碰用户或选区触发的飞行。
    if (this.flight?.lunar) this.flight = null;
    this.signals.style.opacity = '';
    this.labels.style.opacity = '';
    if (keepSnapshot) return;
    this.lunarLayer.hidden = true;
    this.lunarLayer.width = this.lunarLayer.height = 1;
  }

  animateLunarChange(departure, toMoon) {
    const snapshot = this.lunarLayer;
    const timing = {duration: LUNAR_TRANSITION_DURATION, easing: 'cubic-bezier(.22,1,.36,1)'};
    const dock = this.lunarDock;
    const fadeIn = [{opacity: 0}, {opacity: 1}];
    snapshot.hidden = false;

    if (toMoon) {
      this.flyTo(...this.world.home, 1);
      this.flight.duration = LUNAR_TRANSITION_DURATION;
      this.flight.lunar = true;
      // 信号层与标签从首帧起保持透明，延迟约两成时长后淡入；
      // 时长相应扣除延迟，保证与快照同一时刻结束，避免收尾跳变。
      const revealDelay = Math.round(LUNAR_TRANSITION_DURATION * .22);
      const reveal = {...timing, duration: timing.duration - revealDelay, delay: revealDelay, fill: 'backwards'};
      this.lunarAnimations = [snapshot.animate([{opacity: 1}, {opacity: 0}], timing),
        ...[this.signals, this.labels].map((element) => {
          element.style.opacity = '';
          return element.animate(fadeIn, reveal);
        })];
    } else {
      const hasSatellite = this.world.id === 'Teyvat' && Boolean(this.moon)
        && !this.moonRenderer.gl.isContextLost();
      if (hasSatellite) {
        const angle = this.lastVisibleMoonAngle ?? this.orbitHomeAngle;
        const [x, y, depth] = this.orbitPoint(angle, this.radius);
        Object.assign(dock, {x, y, radius: this.moonRadius(this.radius, depth)});
        this.orbitResumeAt = performance.now() + timing.duration;
        this.orbitStarted = this.orbitResumeAt - (angle - this.orbitHomeAngle) * 8300;
        this.moonPaintAt = null;
        this.drawSatellite(performance.now(), this.radius, true);
      }
      const origin = `${departure.x - departure.left}px ${departure.y - departure.top}px`;
      const movement = `translate(${dock.x - departure.x}px, ${dock.y - departure.y}px)`;
      const scale = dock.radius / departure.radius;
      const start = {transformOrigin: origin, transform: 'translate(0, 0) scale(1)'};
      const docked = {transformOrigin: origin, transform: `${movement} scale(${scale})`};
      const dockOffset = .77;
      const retreat = snapshot.animate(hasSatellite ? [
        {...start, easing: timing.easing},
        {...docked, offset: dockOffset}, docked,
      ] : [{...start, opacity: 1}, {...docked, opacity: 0}],
      hasSatellite ? {duration: timing.duration, fill: 'both'} : {...timing, fill: 'both'});
      this.lunarAnimations = [retreat, ...[this.canvas, this.labels, this.signals].map((element) =>
        element.animate(fadeIn, timing))];
      if (hasSatellite) {
        // Both disks share the same position and radius throughout the retreat.
        // Fade the chart over the orbit texture while the moon is shrinking.
        const localCenter = this.satellite.width / (2 * this.ratio);
        const dockOrigin = `${localCenter}px ${localCenter}px`;
        const inverse = `translate(${departure.x - dock.x}px, ${departure.y - dock.y}px) scale(${1 / scale})`;
        const rest = {transformOrigin: dockOrigin, transform: 'translate(0, 0) scale(1)'};
        this.lunarAnimations.push(snapshot.animate([
          {opacity: 1}, {opacity: 1, offset: .24, easing: 'ease-in-out'},
          {opacity: 0, offset: dockOffset}, {opacity: 0},
        ], {duration: timing.duration, fill: 'both'}), this.satellite.animate([
          {transformOrigin: dockOrigin, transform: inverse, easing: timing.easing},
          {...rest, offset: dockOffset}, rest,
        ], {duration: timing.duration, fill: 'both'}));
      }
    }
    // 收尾只清自己这一组动画：期间被取消/重建的旧 onfinish 不得误杀新过渡。
    const animations = this.lunarAnimations;
    animations[0].onfinish = () => {
      if (this.lunarAnimations !== animations) return;
      this.stopLunarTransition();
      this.requestFrame();
    };
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
    thumbnail.width = 1024;
    thumbnail.height = Math.round(thumbnail.width * image.naturalHeight / image.naturalWidth);
    thumbnail.getContext('2d').drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
    uploadAtlas(this.moonRenderer, thumbnail);
    this.moon = {span: fullSpan, sea: [0, 0, 0], projection: 0, naturalMoon: true};
    this.requestFrame();
  }

  setGroundPatch(image, patch) {
    this.groundPatches ??= new Map();
    this.groundPatches.set(patch.map, {image, patch});
    this.syncGroundPatch();
  }

  setFontaineSeaPatch(image, rect) {
    const {gl} = this;
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.fontaineSeaTexture);
    // 海域贴片依赖半透明叠加，上传时预乘避免过滤时 RGB 泄漏。
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE0);
    this.fontaineSeaRect = rect;
    this.sphereState = null;
    this.requestFrame();
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
    const ratio = mapRasterScale(width, height, BASE_RASTER_SCALE, this.mobileDevice);
    if (!width || !height || (width === this.width && height === this.height && ratio === this.ratio)) return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    const phone = width <= 650;
    this.otherHomeCenter = this.mobileDevice || phone ? centeredHome : [width <= 900 ? .362 : .374, .485];
    // This is the fit at zoom 1; overview and close-up gates still use camera zoom.
    this.chartRadius = Math.min(width * (phone ? .475 : .36), height * (phone ? .286 : .43));
    this.teyvatRadius = Math.min(width, height) / 2;
    this.canvas.parentElement.style.setProperty('--overview-diameter', `${this.teyvatRadius * 2}px`);
    for (const canvas of [this.canvas, this.signals]) {
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
    }
    const starRatio = Math.min(ratio, BASE_RASTER_SCALE);
    this.stars.width = Math.max(1, Math.round(width * starRatio));
    this.stars.height = Math.max(1, Math.round(height * starRatio));
    // Allocate once per viewport, with room for the largest satellite in overview.
    if (this.moonRenderer) {
      const moonSide = 4 + 2 * this.moonRadius(this.teyvatRadius * ORBIT_MAX_ZOOM, -1) * ATMOSPHERE_EXTENT;
      const pixels = Math.ceil(moonSide * ratio);
      this.satellite.width = this.satellite.height = pixels;
      this.satellite.style.width = this.satellite.style.height = `${pixels / ratio}px`;
    }
    sky(this.stars, width, height, starRatio);
    this.sphereState = null;
    this.moonPaintAt = null;
    this.moonPose = null;
    this.idleOverview = false;
    this.requestFrame();
  }

  get radius() { return this.world?.id === 'Teyvat' ? this.teyvatRadius : this.chartRadius; }
  get homeCenter() { return this.world?.id === 'Teyvat' ? centeredHome : this.otherHomeCenter; }
  get cx() { return this.width * (this.center ?? this.homeCenter)[0]; }
  get cy() { return this.height * (this.center ?? this.homeCenter)[1]; }
  get magnified() { return Math.max(this.zoom, this.zoomTarget) > 1.01; }
  get orbitHomeAngle() { return this.cx > this.radius * 1.51 ? 2.58 : -.82; }

  select(zone) {
    if (zone?.zone.key !== this.selected?.zone.key) {
      this.hideReliefCard();
      this.raise = 0;
      this.raiseStarted = null;
      this.reliefLeadStarted = null;
      this.reliefOpeningAt = null;
      this.reliefRevealed = false;
    }
    this.selected = zone;
    this.reliefSuppressed = false;
    this.lockTime = performance.now();
    this.requestFrame();
  }

  frameSelection() {
    if (!this.selected || !this.radius) return;
    const {width, height, radius} = this;
    this.flyTo(...frameZone(this.world, this.selected, {width, height, radius,
      withRelief: this.world.id === 'Teyvat' && this.reliefEnabled?.(),
      obstacles: this.labelObstacles(), minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM}), true);
  }

  viewportRect(canvas) {
    if (!this.world || !this.radius) return null;
    const radius = this.radius * this.zoom;
    const {cx, cy, width, height} = this;
    const basis = cameraBasis(this.lon, this.lat);
    const left = Math.max(-1, -cx / radius);
    const right = Math.min(1, (width - cx) / radius);
    const top = Math.min(1, cy / radius);
    const bottom = Math.max(-1, (cy - height) / radius);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let row = 0; row <= 8; row++) {
      const y = interpolate(top, bottom, row / 8);
      for (let column = 0; column <= 8; column++) {
        const x = interpolate(left, right, column / 8);
        if (x * x + y * y > 1) continue;
        for (const [u, v] of viewAtlasPoints(this.world, basis, this.zoom, x, y)) {
          minU = Math.min(minU, u);
          maxU = Math.max(maxU, u);
          minV = Math.min(minV, v);
          maxV = Math.max(maxV, v);
        }
      }
    }
    if (maxU <= minU || maxV <= minV) return null;
    return {
      x: minU * canvas.width,
      y: minV * canvas.height,
      width: (maxU - minU) * canvas.width,
      height: (maxV - minV) * canvas.height,
    };
  }

  alignViewport(rect, canvas, animate, onSettled) {
    if (!this.world || !this.radius || !rect?.width) return false;
    const [lon, lat] = atlasAngles(this.world,
      (rect.x + rect.width / 2) / canvas.width,
      (rect.y + rect.height / 2) / canvas.height);
    const zoom = Math.max(3.8, this.width * canvas.width * chartScale(this.world)[0]
      / (rect.width * this.radius));
    if (animate) this.flyTo(lon, lat, zoom, [.5, .5]);
    else {
      this.lon = lon;
      this.lat = lat;
      this.zoom = this.zoomTarget = zoom;
      this.center = [.5, .5];
      this.velocity = this.flight = null;
      this.spinAfter = performance.now() + 3100;
      this.requestFrame();
    }
    this.viewportAligned = onSettled;
    this.handoffDeadline = !animate && onSettled ? performance.now() + 650 : 0;
    return true;
  }

  cancelViewportAlignment() {
    if (!this.viewportAligned) return;
    this.viewportAligned = null;
    if (this.flight) {
      this.flight = null;
      this.zoomTarget = this.zoom;
    }
  }

  flyTo(lon, lat, zoom, center = null, revealSelection = false) {
    this.hideReliefCard();
    this.reliefLeadStarted = null;
    this.reliefOpeningAt = null;
    this.reliefRevealed = false;
    this.reliefSuppressed = !revealSelection;
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
      const travel = route.distance / Math.PI;
      // 长跳先拉远到有界高度（受 MIN_ZOOM 兜底），短跳几乎不拉高；末段
      // 仍精确降回调用方（如 frameZone）给定的取景上。
      const room = Math.max(0, Math.min(from, to) - Math.log(MIN_ZOOM));
      const retreat = Math.min(room, Math.log(1 + travel * 2.6));
      this.flight = {time: performance.now(), route, duration: 640 + 650 * travel,
        from, to, retreat, travel, toLon: lon, toLat: lat,
        center, startCenter: this.center ?? this.homeCenter};
    }
    this.requestFrame();
  }

  setPlaying(playing) {
    this.playing = playing;
    this.requestFrame();
  }

  zoomBy(factor, anchor) {
    // 飞行中断改由当前真实倍率接管，旧的缩放目标不再继续推进。
    if (this.flight) this.zoomTarget = this.zoom;
    this.flight = null;
    this.spinAfter = performance.now() + 1700;
    const next = clamp(this.zoomTarget * factor, MIN_ZOOM, Math.max(MAX_ZOOM, this.zoomTarget));
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
    clearTimeout(this.spinWake);
    if (!this.disposed && !document.hidden && !this.frame) {
      this.frame = requestAnimationFrame((time) => this.draw(time));
    }
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLoss);
    this.observer.disconnect();
    clearTimeout(this.spinWake);
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
      const {route, duration, from, to, retreat, travel, toLon, toLat, center, startCenter} = this.flight;
      const progress = clamp((time - this.flight.time) / duration, 0, 1);
      // 长跳真实顺序：开头约 12%（短跳按比例更短）航线几乎不动，高度先以
      // 平滑缓动爬到回退峰值；随后横移 S 曲线并减速；回退鼓包在减速尾段前
      // 归零，与末段降回目标 log zoom 重叠，无剪切。头尾导数均为零。
      const hold = .12 * Math.min(1, travel * 1.6);
      const t = progress * progress * (3 - 2 * progress);
      const move = clamp((progress - hold) / (1 - hold), 0, 1);
      [this.lon, this.lat] = route.at(move * move * (3 - 2 * move));
      const base = interpolate(from, to, t);
      const rise = hold * .5;
      const bump = Math.sin(Math.PI * clamp((progress - rise) / (.58 - rise), 0, 1)) ** 2;
      this.zoom = Math.exp(base - retreat * bump);
      this.center = startCenter.map((value, axis) => interpolate(value, (center ?? this.homeCenter)[axis], move * move * (3 - 2 * move)));
      // 临近阶段小幅偏航与俯角弧：直接作为名义经纬上的连续偏置写入实际
      // 坐标（∂front/∂lon = cos(lat)·right、∂front/∂lat = up），头尾归零；
      // 中断或新跳转天然继承最后真实坐标，视觉倾斜不丢弃。
      const approach = Math.sin(Math.PI * clamp((progress - .45) / .55, 0, 1)) ** 2 * Math.min(1, travel * 2.2);
      if (approach > .001) {
        const toDir = direction(toLon, toLat);
        const {front, right, up} = cameraBasis(this.lon, this.lat);
        const forward = Math.max(.2, dot(toDir, front));
        this.lon = wrap(this.lon + clamp(Math.atan2(dot(toDir, right), forward) * .35, -.16, .16) * approach
          / Math.max(.35, Math.cos(this.lat)));
        this.lat = clamp(this.lat + clamp(Math.atan2(dot(toDir, up), forward) * .30, -.12, .12) * approach,
          -Math.PI / 2, Math.PI / 2);
      }
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
    if (!this.world || !this.width || !this.height) return;
    this.advance(time, clamp(time - this.lastFrame, 1, 34));
    this.lastFrame = time;
    const overview = this.world.id === 'Teyvat' && this.zoom <= ORBIT_MAX_ZOOM;
    const spinInterval = this.compact ? COMPACT_SPIN_INTERVAL : 32;
    const autoSpin = overview && !this.selected && this.zoom >= 1 && this.zoom === this.zoomTarget
      && !this.pointer && !this.pinch && !this.flight && !this.velocity
      && !this.lunarAnimations && !this.pendingLunarChange && !this.reducedMotion.matches;
    if (autoSpin && time >= this.spinAfter) {
      this.spinTime ??= time;
      if (time - this.spinTime >= spinInterval) {
        this.lon = wrap(this.lon - Math.min(80, time - this.spinTime) * SPIN_RATE);
        this.spinTime = time;
      }
    } else {
      this.spinTime = null;
    }
    // 双指事件在一帧内可能连发多次：这里统一聚合应用一次，锚点始终是手势
    // 开始时固定的地图坐标；跨球面/平面混合过渡同样由 cameraAtAnchor 保持。
    // 消费须在读取 radius/cx/cy 之前，保证同帧取景一致。
    this.applyPinch();
    const {ratio, cx, cy, width, height} = this;
    const radius = this.radius * this.zoom;
    const basis = cameraBasis(this.lon, this.lat);
    const moving = Boolean(this.flight || this.velocity || this.pointer?.moved || this.pinch || this.zoom !== this.zoomTarget);
    const settled = this.cameraMoving && !moving;
    const worldChanged = this.lastTileWorld !== this.world;
    const focused = Boolean(this.selected);
    const detailFocusChanged = this.lastTileFocus !== focused;
    this.cameraMoving = moving;
    const arrival = this.lunarArrival;
    let lunarMapBlend = 1;
    if (arrival && !this.reducedMotion.matches) {
      arrival.firstFrame ??= time;
      const t = clamp(((time - arrival.firstFrame) / LUNAR_TRANSITION_DURATION - .16) / .72, 0, 1);
      lunarMapBlend = t * t * (3 - 2 * t);
    }
    if (lunarMapBlend === 1) this.lunarArrival = null;
    const pose = [this.lon, this.lat, radius, cx, cy, ratio, lunarMapBlend];
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
    // 异步瓦片在上传后只标记 lookup 脏；渲染前统一合并为一次 texSubImage2D。
    const detailUpdated = this.tiles.flushLookup();
    const nativeUpdated = this.nativeTiles.flushLookup();
    if (changed || settled || detailFocusChanged || detailUpdated || nativeUpdated) {
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
      if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
      renderSphere(this, this.canvas, {
        cx, cy, ratio, radius, world: this.world, basis,
        zoom: this.zoom, detailSize: this.tiles.drawSize, nativeSize: this.nativeTiles.drawSize,
        patchRect: this.patchInAtlas(),
        fontaineSeaRect: this.world.id === 'Teyvat' ? this.fontaineSeaRect : undefined,
        cloudAngle: this.reducedMotion.matches ? 0 : (time * .000011) % TAU,
        lunarMapBlend, lunarPreviewBasis: arrival?.basis,
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
    const orbitView = orbit ? [cx, cy, radius, ratio] : null;
    const orbitChanged = orbitView
      ? !this.signalOrbitView || orbitView.some((value, index) => value !== this.signalOrbitView[index])
      : Boolean(this.signalOrbitView);
    // The moon is composited above the orbit line. It can move while the line
    // and the rest of the overview signal canvas stay in place.
    const idleOverview = overview && !focused && !moving && !this.reliefDock;
    let lockVisible = false;
    if (!idleOverview || !this.idleOverview || orbitChanged) {
      lockVisible = this.drawSignals(time, radius, basis, orbit);
      this.signalOrbitView = orbitView;
    }
    this.idleOverview = idleOverview;
    // 霜月切换在目标世界首帧绘制完成后才启动，保证起点取景已生效。
    if (this.pendingLunarChange) {
      const pending = this.pendingLunarChange;
      this.pendingLunarChange = null;
      this.animateLunarChange(pending.departure, pending.toMoon);
    }
    this.onView?.(this.zoomTarget < MAX_ZOOM, this.zoomTarget > MIN_ZOOM, this.magnified);
    if (!this.flight && this.viewportAligned) {
      const pending = this.handoffDeadline > time && !this.tiles.visibleSettled;
      if (pending) this.requestFrame();
      else {
        const ready = this.viewportAligned;
        this.viewportAligned = null;
        ready();
      }
    }
    // 紧凑设备上播放中的锁定光环不再常驻脉冲（那会让静止画面持续整帧
    // 重绘）；选中后的入场脉冲与移动、标签动画保留。
    const pulse = lockVisible
      && (this.compact ? time - this.lockTime < 1750 : (this.playing || time - this.lockTime < 1750))
      && !this.reducedMotion.matches;
    if (this.flight || this.velocity || this.zoom !== this.zoomTarget || pulse
      || (this.selected && this.raiseStarted != null && this.raise < 1)
      || this.lunarArrival || (orbit && !this.reducedMotion.matches)) {
      this.requestFrame();
    } else if (autoSpin && !this.frame) {
      // Wake only for the next overview update; touch input still requests a frame immediately.
      const nextSpin = (this.spinTime ?? time) + spinInterval;
      this.spinWake = setTimeout(() => this.requestFrame(),
        Math.max(0, Math.max(this.spinAfter, nextSpin) - performance.now()));
    }
  }

  // 捏合的每帧聚合结果只在 draw()（或手势结束）里消费一次。
  applyPinch() {
    const latest = this.pinchLatest;
    if (!this.pinch || !latest) return;
    this.pinchLatest = null;
    const zoom = clamp(this.pinch.zoom * latest.distance / this.pinch.distance,
      MIN_ZOOM, Math.max(MAX_ZOOM, this.pinch.zoom));
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
    if (!active) {
      this.satellite.hidden = true;
      if (this.moonLink) this.moonLink.hidden = true;
      this.moonPaintAt = null;
      this.moonPose = null;
      return;
    }
    if (this.moonRenderer?.gl.isContextLost()) {
      this.satellite.hidden = true;
      if (this.moonLink) this.moonLink.hidden = true;
      this.moonPaintAt = null;
      this.moonPose = null;
      return;
    }
    const orbitClock = Math.max(time, this.orbitResumeAt ?? time);
    const phase = this.reducedMotion.matches ? 0 : (orbitClock - this.orbitStarted) / 8300;
    const angle = this.orbitHomeAngle + phase;
    const {ratio} = this;
    const [cx, cy, depth, radial] = this.orbitPoint(angle, radius);
    const size = this.moonRadius(radius, depth);
    if (this.moonPaintAt !== null && this.moonPose?.angle === angle && this.moonPose.radius === size
      && this.moonPose.x === cx && this.moonPose.y === cy) return;
    const distance = Math.hypot(cx - this.cx, cy - this.cy);
    const masked = depth > 0 && distance < radius + size * .32;
    const visible = !masked && cx >= size && cx <= this.width - size * .5
      && cy >= 55 && cy <= this.height - 68;
    const basis = lockedMoonBasis(radial);
    this.moonPose = {x: cx, y: cy, radius: size, visible, angle,
      basis: [...basis.right, ...basis.up, ...basis.front]};
    const extent = size * ATMOSPHERE_EXTENT;
    const inView = cx + extent > 0 && cx - extent < this.width
      && cy + extent > 0 && cy - extent < this.height;
    this.satellite.hidden = !inView || (depth > 0 && distance + extent <= radius);
    if (this.moonLink) this.moonLink.hidden = !visible;
    if (this.satellite.hidden) {
      this.moonPaintAt = null;
      return;
    }
    const local = this.satellite.width / (2 * ratio);
    const left = cx - local;
    const top = cy - local;
    // Screen position follows each refresh. Reuse the last shaded disk while
    // its size and lighting are visually stable, except at an occlusion edge.
    this.satellite.style.translate = `${left}px ${top}px`;
    const clipped = depth > 0 && distance - extent < radius;
    if (this.moonPaintAt === null || time - this.moonPaintAt >= MOON_PAINT_INTERVAL
      || Math.abs(size - this.moonPaintRadius) * ratio >= .35 || clipped || this.moonPaintClipped) {
      renderSphere(this.moonRenderer, this.satellite, {
        cx: local, cy: local, ratio, radius: size, world: this.moon,
        basis,
        occluder: clipped ? [(this.cx - left) * ratio, this.satellite.height - (this.cy - top) * ratio,
          radius * ratio] : [0, 0, 0],
      });
      this.moonPaintAt = time;
      this.moonPaintRadius = size;
      this.moonPaintClipped = clipped;
    }
    if (visible && (depth <= 0 || distance >= radius + size)) this.lastVisibleMoonAngle = angle;
    if (this.moonLink && visible) {
      this.moonLink.style.translate = `${cx}px ${cy}px`;
      const diameter = Math.max(28, Math.round(size * 2));
      if (diameter !== this.moonLinkSize) {
        this.moonLink.style.setProperty('--moon-size', diameter + 'px');
        this.moonLinkSize = diameter;
      }
    }
  }

  drawOrbit(radius) {
    const {context: ctx, cx, cy, ratio} = this;
    const major = radius * ORBIT_RADIUS;
    const minor = major * orbitAspect;
    ctx.save();
    ctx.lineWidth = 1 / ratio;
    ctx.strokeStyle = 'rgba(216,225,240,.24)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, major, minor, orbitRoll, Math.PI, TAU);
    ctx.stroke();

    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.moveTo(cx + radius, cy);
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.clip('evenodd');
    ctx.strokeStyle = 'rgba(216,225,240,.15)';
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
    if (!lift) this.hideReliefCard();
    if (this.selected) {
      const {uv, vector} = this.selected;
      const [px, py, depth] = projectAtlas(this.world, basis, this.zoom, uv, vector);
      const x = cx + px * radius;
      const y = cy - py * radius - lift;
      const visibleDepth = this.selectionLabel?.marker === this.selected ? .10 : .16;
      if (depth >= visibleDepth && x >= 0 && x <= this.width && y >= 0 && y <= this.height) {
        this.drawSelectionLabel(x, y);
        if (!lift) this.drawLock(time, x, y);
        return !lift;
      }
    }
    this.clearSelectionLabel();
    return false;
  }

  drawRaisedRegion(radius, basis, time) {
    if (!this.selected) return 0;
    if (this.flight) {
      // Flights reproject the whole sphere every frame; the outline projection,
      // shadow fill and WebGL→2D pixel copy of the lifted region would each
      // invalidate per frame on top of that. Freeze the lift at 0 while the
      // flight is active — the region re-raises through its natural animation
      // on the first settled frame.
      this.raise = 0;
      this.raiseStarted = null;
      return 0;
    }
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
    if (this.world.id === 'Teyvat') {
      this.drawReliefLeads(rings, lift, time);
    }
    return lift;
  }

  drawReliefLeads(rings, lift, time) {
    // Match the map's regional-detail scale. Overview zooms leave room for
    // the map, while a closer view can reveal the selected region again.
    if (this.zoom < 1.85) {
      this.hideReliefCard();
      return;
    }
    if (this.reliefSuppressed || this.raise < .5) return;
    if (!this.reliefRevealed && this.cameraMoving) {
      this.reliefLeadStarted = null;
      return;
    }
    const key = this.selected.zone.key;
    const target = this.reliefTarget?.(key);
    if (!target) {
      this.hideReliefCard();
      return;
    }
    if (target.hasAttribute('data-relief-closing')) return;

    const points = rings.flatMap((ring) => ring.map(([x, y]) => [x, y - lift]));
    if (points.length < 2) {
      this.hideReliefCard();
      return;
    }
    const zone = {left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity};
    for (const [x, y] of points) {
      zone.left = Math.min(zone.left, x);
      zone.right = Math.max(zone.right, x);
      zone.top = Math.min(zone.top, y);
      zone.bottom = Math.max(zone.bottom, y);
    }
    const panel = placeReliefCard(zone, reliefCardSize(this), points);
    const {leads} = panel;
    const revealSpan = leads ? leads[1].attach - leads[0].attach : Math.min(28, panel.height);
    const revealStart = leads ? leads[0].attach - panel.top : (panel.height - revealSpan) / 2;

    if (leads) {
      this.reliefLeadStarted ??= time;
      const progress = this.reducedMotion.matches ? 1 : clamp((time - this.reliefLeadStarted) / 320, 0, 1);
      const reach = 1 - (1 - progress) ** 2;
      const {context: ctx} = this;
      ctx.save();
      ctx.strokeStyle = 'rgba(232, 249, 255, 0.68)';
      ctx.fillStyle = '#f0fbff';
      ctx.lineWidth = .85;
      ctx.lineCap = 'round';
      for (const {x, y, to: [endX, endY]} of leads) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(interpolate(x, endX, reach), interpolate(y, endY, reach));
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      if (progress < 1) {
        this.requestFrame();
        if (!this.reliefRevealed) return;
      }
    } else {
      this.reliefLeadStarted = null;
    }
    if (!target.querySelector(':scope > .liquid-glass.is-ready')) return;
    this.reliefOpeningAt ??= time;
    const elapsed = this.reducedMotion.matches ? 495 : time - this.reliefOpeningAt;
    const expanding = clamp(elapsed / 360, 0, 1);
    const eased = expanding * expanding * (3 - 2 * expanding);

    // Write the first glass frame before making the dock visible. Geometry and
    // content share this clock so the final-size backing cannot paint first.
    target.style.left = `${panel.left}px`;
    target.style.top = `${panel.top}px`;
    target.style.width = `${panel.width}px`;
    target.style.height = `${panel.height}px`;
    target.style.setProperty('--relief-glass-top', `${revealStart * (1 - eased)}px`);
    target.style.setProperty('--relief-glass-width', `${interpolate(12, panel.width, eased)}px`);
    target.style.setProperty('--relief-glass-height', `${interpolate(revealSpan, panel.height, eased)}px`);
    target.style.setProperty('--relief-glass-radius', `calc(6px + (var(--radius-card) - 6px) * ${eased})`);
    target.style.setProperty('--relief-content-opacity', String(clamp((elapsed - 255) / 240, 0, 1)));
    this.reliefDock = target;
    target.dataset.reliefEdge = 'left';
    target.dataset.reliefPlaced = '';
    if (!this.reliefRevealed) {
      this.reliefRevealed = true;
      this.onReliefReveal?.(key);
    }
    if (elapsed < 495) this.requestFrame();
  }

  hideReliefCard() {
    this.reliefLeadStarted = null;
    this.reliefOpeningAt = null;
    this.reliefRevealed = false;
    if (!this.reliefDock) return;
    const retiring = retireReliefDock(this.reliefDock);
    this.reliefDock = null;
    this.onReliefReveal?.(null);
    if (retiring) void retiring.then(() => this.requestFrame());
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

  clearSelectionLabel() {
    this.selectionLabel?.node.remove();
    this.selectionLabel = null;
  }

  drawSelectionLabel(x, y) {
    const marker = this.selected;
    if (this.selectionLabel?.marker !== marker) {
      this.clearSelectionLabel();
      const node = document.createElement('span');
      node.className = 'active-zone-label';
      node.textContent = marker.zone.name;
      this.labels.append(node);
      this.selectionLabel = {marker, node};
    }
    const {node, placement: previous} = this.selectionLabel;
    const font = this.width <= 650 ? 12 : 14;
    const height = Math.ceil(font * 1.2) + 12;
    const span = Math.ceil(marker.zone.name.length * font * 1.04) + 22;
    const top = y - height / 2;
    const alternatives = [0, 14, 30, 50, 62, 78, 94].flatMap((gap) =>
      [x + 12 + gap, x - span - 12 - gap].map((left, index) => ({
        left, right: left + span, top, bottom: top + height, onLeft: index === 1, gap,
      })));
    const labelTop = y - height - 12;
    const labelLeft = clamp(x - span / 2, 7, this.width - span - 7);
    const above = {left: labelLeft, right: labelLeft + span, top: labelTop,
      bottom: labelTop + height, above: true, gap: 0};
    alternatives.splice(2, 0, above);
    const fits = (bounds) => bounds.left >= 7 && bounds.right <= this.width - 7
      && bounds.top >= 7 && bounds.bottom <= this.height - 7;
    // Keep the anchor stable while the selected region follows camera movement.
    let box = previous && alternatives.find((option) =>
      option.onLeft === previous.onLeft && option.above === previous.above && option.gap === previous.gap);
    if (!box) {
      const obstacles = this.labelObstacles(true);
      box = alternatives.find(option => fits(option) && !obstacles.some(other => overlaps(option, other, 5)));
    }
    const placement = box ?? above;
    const left = clamp(placement.left, 7, Math.max(7, this.width - span - 7));
    const paintedTop = clamp(placement.top, 7, Math.max(7, this.height - height - 7));
    node.classList.toggle('label-left', Boolean(placement.onLeft));
    node.classList.toggle('label-above', Boolean(placement.above));
    node.style.transform = `translate(${left}px,${paintedTop}px)`;
    node.style.setProperty('--region-label-gap', `${placement.gap}px`);
    if (placement.above) node.style.setProperty('--label-anchor-x', `${x - left}px`);
    this.selectionLabel.placement = placement;
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
      // 用户接管即终止在途霜月过渡；自动帧不经过这里，不会误清。
      if (this.lunarAnimations || this.pendingLunarChange) this.stopLunarTransition();
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
      // 拖动接管飞行：从当前真实倍率继续，旧目标不再自动推进。
      if (this.flight) this.zoomTarget = this.zoom;
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
      if (this.lunarAnimations || this.pendingLunarChange) this.stopLunarTransition();
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
      this.zoomBy(Math.exp(-clamp(delta, -150, 150) * .0045), coordinates(event));
    }, {passive: false});
    canvas.addEventListener('keydown', (event) => {
      const arrows = {ArrowLeft: [-25, 0], ArrowRight: [25, 0], ArrowUp: [0, -25], ArrowDown: [0, 25]};
      if (Object.hasOwn(arrows, event.key)) {
        if (this.flight) this.zoomTarget = this.zoom;
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
