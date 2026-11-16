import {buildRegionLinework} from '../regionLinework.js';
import {atlasAngles, atlasPoints, chartScale, clamp, direction, projectAtlas} from './projection.js';

const REVEAL_ZOOM = 3.8;

function lunarSegments(regions, world) {
  const {imageWidth, imageHeight} = world.pyramid;
  const projectPoint = ([x, y]) => {
    const uv = [4 * x / imageWidth, 4 * y / imageHeight];
    if (uv.some((coordinate) => coordinate < 0 || coordinate > 1)) return null;
    return {uv, vector: direction(...atlasAngles(world, ...uv))};
  };
  const segments = new Map();
  for (const {rings, lines} of regions) {
    for (const line of lines ?? rings.map((ring) => [...ring, ring[0]])) {
      for (let i = 1; i < line.length; i += 1) {
        const [a, b] = [line[i - 1], line[i]];
        const key = [a.join(','), b.join(',')].sort().join('/');
        if (segments.has(key)) continue;
        const start = projectPoint(a), end = projectPoint(b);
        if (start && end) segments.set(key, [start, end]);
      }
    }
  }
  return [...segments.values()];
}

export function drawGlobeBoundaries(globe, time, radius, basis) {
  const zoomOpacity = clamp((globe.zoom - REVEAL_ZOOM) / 1.4, 0, 1);
  if (!zoomOpacity) {
    globe.boundaryRevealedAt = null;
    return;
  }
  if (!globe.zones.length || (!globe.boundaryGeometry && globe.cameraMoving)) return;
  const {world, context: ctx, cx, cy} = globe;
  const lunar = world.projection === 2;
  if (!globe.boundaryGeometry) {
    const regions = globe.zones.map(({zone}) => ({id1: zone.key, rings: zone.pixelRings, lines: zone.pixelLines}));
    const segments = lunar ? null : buildRegionLinework(regions, globe.smoothBoundaries).segments;
    globe.boundaryGeometry = lunar ? lunarSegments(regions, world) : new Path2D(segments.map(({path}) => path).join(''));
  }
  globe.boundaryRevealedAt ??= time;
  const reveal = globe.reducedMotion.matches ? 1 : clamp((time - globe.boundaryRevealedAt) / 180, 0, 1);
  if (reveal < 1) globe.requestFrame();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = .48 * zoomOpacity * reveal;
  ctx.strokeStyle = '#e6f4ef';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (lunar) {
    ctx.lineWidth = .85;
    ctx.beginPath();
    for (const [a, b] of globe.boundaryGeometry) {
      const start = projectAtlas(world, basis, globe.zoom, a.uv, a.vector);
      const end = projectAtlas(world, basis, globe.zoom, b.uv, b.vector);
      if (start[2] <= .15 || end[2] <= .15) continue;
      ctx.moveTo(cx + radius * start[0], cy - radius * start[1]);
      ctx.lineTo(cx + radius * end[0], cy - radius * end[1]);
    }
    ctx.stroke();
  } else {
    const [u, v] = atlasPoints(world, basis.front)[0];
    const {imageWidth, imageHeight} = world.pyramid;
    const [sx, sy] = chartScale(world);
    const scaleX = radius * 4 / (sx * imageWidth);
    const scaleY = radius * 4 / (sy * imageHeight);
    ctx.translate(cx - u * radius / sx, cy - v * radius / sy);
    ctx.scale(scaleX, scaleY);
    ctx.beginPath();
    ctx.rect(0, 0, imageWidth / 4, imageHeight / 4);
    ctx.clip();
    ctx.lineWidth = .85 / scaleX;
    ctx.stroke(globe.boundaryGeometry);
  }
  ctx.restore();
}
