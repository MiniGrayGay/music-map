const PI = Math.PI;
const TAU = 2 * PI;

// The extracted lunar atlas contains two differently sized circular charts.
const nearMoon = [.708, .510, .274, .466];
const farMoon = [.264, .510, .259, .466];

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function direction(lon, lat) {
  const projected = Math.cos(lat);
  return [Math.sin(lon) * projected, Math.sin(lat), Math.cos(lon) * projected];
}

export function cameraBasis(lon, lat) {
  return {
    front: direction(lon, lat),
    right: direction(lon + PI / 2, 0),
    up: [-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon)],
  };
}

export function surfaceRay(x, y, {right, up, front}) {
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return front.map((value, index) => right[index] * x + up[index] * y + value * z);
}

function lunarRadius(angle) {
  const edge = clamp((angle - .8) / .2, 0, 1);
  return angle - .053 * edge * edge * (3 - 2 * edge);
}

function lunarPoint(normal, side) {
  const [u, v, rx, ry] = side === 1 ? nearMoon : farMoon;
  const distance = Math.hypot(normal[0], normal[1]);
  const angle = Math.min(1, 2 * Math.acos(clamp(side * normal[2], -1, 1)) / PI);
  const scale = distance < 1e-8 ? 0 : lunarRadius(angle) / distance;
  return [u + side * normal[0] * scale * rx, v - normal[1] * scale * ry];
}

export function atlasPoints(world, normal) {
  if (world.projection === 2) {
    const side = normal[2] >= 0 ? 1 : -1;
    return Math.abs(normal[2]) < .23 ? [lunarPoint(normal, side), lunarPoint(normal, -side)] : [lunarPoint(normal, side)];
  }
  return [[
    Math.atan2(normal[0], normal[2]) / world.span[0] + .5,
    .5 - Math.asin(clamp(normal[1], -1, 1)) / world.span[1],
  ]];
}

function inverseLunarRadius(radius) {
  if (radius <= .8) return radius;
  let low = .8;
  let high = 1;
  for (let step = 0; step < 14; step += 1) {
    const middle = (low + high) / 2;
    if (lunarRadius(middle) < radius) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function atlasAngles(world, u, v) {
  if (world.projection !== 2) {
    return [(u - .5) * world.span[0], (.5 - v) * world.span[1]];
  }
  const [nx, ny] = [(u - nearMoon[0]) / nearMoon[2], (v - nearMoon[1]) / nearMoon[3]];
  const [fx, fy] = [(u - farMoon[0]) / farMoon[2], (v - farMoon[1]) / farMoon[3]];
  const near = Math.hypot(nx, ny) < Math.hypot(fx, fy);
  const [x, y, side] = near ? [nx, ny, 1] : [fx, fy, -1];
  const r = Math.hypot(x, y);
  const a = inverseLunarRadius(r) * PI / 2;
  const scale = r < 1e-8 ? 0 : Math.sin(a) / r;
  return [Math.atan2(side * x * scale, side * Math.cos(a)), Math.asin(clamp(-y * scale, -1, 1))];
}

export const fullSpan = [TAU, PI];

export function chartFlattening(world, zoom) {
  if (world.projection === 2 || world.naturalMoon) return 0;
  const t = clamp((zoom - 1.55) / 2.25, 0, 1);
  return t * t * (3 - 2 * t);
}

export function chartScale(world) {
  const {imageWidth, imageHeight} = world.pyramid;
  return [1 / world.span[0], imageWidth / imageHeight / world.span[0]];
}

function chartUV(world, normal) {
  return atlasPoints(world, normal)[0];
}

export function viewAtlasPoints(world, basis, zoom, x, y) {
  const blend = chartFlattening(world, zoom);
  if (!blend) return atlasPoints(world, surfaceRay(x, y, basis));
  const [u, v] = chartUV(world, basis.front);
  const [sx, sy] = chartScale(world);
  const chart = [u + x * sx, v - y * sy];
  if (blend === 1) return [chart];
  const globe = chartUV(world, surfaceRay(x, y, basis));
  return [chart.map((value, index) => globe[index] * (1 - blend) + value * blend)];
}

// Use angular coordinates through the globe-to-chart blend, and use the
// physical ray on the Moon so an atlas seam does not move the pinch anchor.
export function viewportAngles(world, basis, zoom, x, y) {
  if (chartFlattening(world, zoom)) {
    return atlasAngles(world, ...viewAtlasPoints(world, basis, zoom, x, y)[0]);
  }
  const [nx, ny, nz] = surfaceRay(x, y, basis);
  return [Math.atan2(nx, nz), Math.asin(clamp(ny, -1, 1))];
}

export function cameraAtAnchor(world, zoom, x, y, anchor, lon, lat) {
  const limit = PI / 2 - .001;
  lat = clamp(lat, -limit, limit);
  const step = .0001;
  const sample = (azimuth, elevation) =>
    viewportAngles(world, cameraBasis(azimuth, elevation), zoom, x, y);
  for (let i = 0; i < 7; i += 1) {
    const current = sample(lon, lat);
    const dx = wrap(anchor[0] - current[0]);
    const dy = anchor[1] - current[1];
    if (Math.abs(dx) + Math.abs(dy) < .00001) break;
    const side = sample(lon + step, lat);
    const vertical = sample(lon, lat + step);
    const a = wrap(side[0] - current[0]) / step;
    const b = wrap(vertical[0] - current[0]) / step;
    const c = (side[1] - current[1]) / step;
    const d = (vertical[1] - current[1]) / step;
    const det = a * d - b * c;
    if (Math.abs(det) < .00001) break;
    lon = wrap(lon + clamp((d * dx - b * dy) / det, -.6, .6));
    lat = clamp(lat + clamp((a * dy - c * dx) / det, -.6, .6), -limit, limit);
  }
  return [lon, lat];
}

// Invert the same blended texture lookup used by the fragment shader. This
// keeps the labels, hit areas and block outline attached to the atlas pixels.
export function projectAtlas(world, basis, zoom, uv, normal) {
  const depth = dot(normal, basis.front);
  const blend = chartFlattening(world, zoom);
  let x = dot(normal, basis.right);
  let y = dot(normal, basis.up);
  if (!blend) return [x, y, depth];
  const [u, v] = chartUV(world, basis.front);
  const [sx, sy] = chartScale(world);
  const flatX = (uv[0] - u) / sx;
  const flatY = (v - uv[1]) / sy;
  if (blend === 1) return [flatX, flatY, 1 - Math.hypot(flatX, flatY) ** 2];
  if (depth <= 0) return [x, y, depth];
  x += (flatX - x) * blend;
  y += (flatY - y) * blend;
  const step = .0001;
  for (let i = 0; i < 5; i += 1) {
    if (Math.hypot(x, y) >= .995) return [x, y, 0];
    const [p] = viewAtlasPoints(world, basis, zoom, x, y);
    const du = uv[0] - p[0];
    const dv = uv[1] - p[1];
    if (Math.abs(du) + Math.abs(dv) < .000001) break;
    const [px] = viewAtlasPoints(world, basis, zoom, x + step, y);
    const [py] = viewAtlasPoints(world, basis, zoom, x, y + step);
    const a = px[0] - p[0], b = py[0] - p[0];
    const c = px[1] - p[1], d = py[1] - p[1];
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-12) break;
    x += step * (d * du - b * dv) / determinant;
    y += step * (a * dv - c * du) / determinant;
  }
  return [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
}

export function clipAtlasRing(ring) {
  if (ring.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1)) return ring;
  let points = ring;
  for (const [axis, edge, sign] of [[0, 0, 1], [0, 1, -1], [1, 0, 1], [1, 1, -1]]) {
    const inside = (point) => (point[axis] - edge) * sign >= 0;
    points = points.flatMap((end, index) => {
      const start = points.at(index - 1);
      const startInside = inside(start);
      const endInside = inside(end);
      if (startInside === endInside) return endInside ? [end] : [];
      const fraction = (edge - start[axis]) / (end[axis] - start[axis]);
      const crossing = start.map((value, i) => i === axis ? edge : value + (end[i] - value) * fraction);
      return endInside ? [crossing, end] : [crossing];
    });
  }
  return points;
}

export const outlineDepth = .10;

export function projectVisibleOutline(world, basis, zoom, ring) {
  const projected = ring.map(({uv, vector}) => projectAtlas(world, basis, zoom, uv, vector));
  const visible = [];
  for (const [index, end] of projected.entries()) {
    const start = projected.at(index - 1);
    if ((start[2] >= outlineDepth) !== (end[2] >= outlineDepth)) {
      const fraction = (outlineDepth - start[2]) / (end[2] - start[2]);
      visible.push([start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction]);
    }
    if (end[2] >= outlineDepth) visible.push(end);
  }
  return visible;
}

export function cameraRoute(fromLon, fromLat, toLon, toLat) {
  const from = direction(fromLon, fromLat);
  const to = direction(toLon, toLat);
  const cosine = clamp(dot(from, to), -1, 1);
  const distance = Math.acos(cosine);
  const offset = to.map((value, i) => value - from[i] * cosine);
  const length = Math.hypot(...offset);
  const tangent = length > 1e-8 ? offset.map((value) => value / length) : cameraBasis(fromLon, fromLat).right;
  return {distance, at(t) {
    if (t >= 1) return [toLon, toLat];
    const angle = distance * t;
    const point = from.map((value, i) => value * Math.cos(angle) + tangent[i] * Math.sin(angle));
    return [Math.atan2(point[0], point[2]), Math.asin(clamp(point[1], -1, 1))];
  }};
}
