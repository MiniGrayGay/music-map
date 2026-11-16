import {atlasAngles, cameraBasis, outlineDepth, projectAtlas, projectVisibleOutline} from './projection.js';

function unobstructedFrame(width, height, obstacles) {
  const margin = 16;
  let frame = {left: margin, top: margin, right: width - margin, bottom: height - margin};
  const area = ({left, top, right, bottom}) => Math.max(0, right - left) * Math.max(0, bottom - top);
  for (const obstacle of obstacles) {
    if (obstacle.left >= frame.right || obstacle.right <= frame.left
      || obstacle.top >= frame.bottom || obstacle.bottom <= frame.top) continue;
    const candidates = [
      {...frame, right: obstacle.left - margin},
      {...frame, left: obstacle.right + margin},
      {...frame, bottom: obstacle.top - margin},
      {...frame, top: obstacle.bottom + margin},
    ];
    const largest = candidates.reduce((best, candidate) => area(candidate) > area(best) ? candidate : best);
    if (area(largest) > 0) frame = largest;
  }
  return frame;
}

export function frameZone(world, zone, {width, height, radius, obstacles, minZoom, maxZoom}) {
  const [left, top, right, bottom] = zone.bounds;
  const [lon, lat] = world.projection === 2 ? [zone.lon, zone.lat]
    : atlasAngles(world, (left + right) / 2, (top + bottom) / 2);
  const basis = cameraBasis(lon, lat);
  const outline = zone.outlines.flat();
  const lunarOutline = world.projection === 2 ? zone.outlines.flatMap((ring) =>
    projectVisibleOutline(world, basis, 1, ring)) : [];
  const frame = unobstructedFrame(width, height, obstacles);
  const usableWidth = (frame.right - frame.left) * .78;
  const usableHeight = (frame.bottom - frame.top) * .72;

  function measure(zoom) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let inFront = true;
    const scale = radius * zoom;
    const projected = lunarOutline.length ? lunarOutline
      : outline.map(({uv, vector}) => projectAtlas(world, basis, zoom, uv, vector));
    for (const [x, y, depth = outlineDepth] of projected) {
      minX = Math.min(minX, x * scale);
      maxX = Math.max(maxX, x * scale);
      minY = Math.min(minY, -y * scale);
      maxY = Math.max(maxY, -y * scale);
      inFront &&= depth >= outlineDepth;
    }
    return {zoom, minX, minY, maxX, maxY, fits: inFront
      && maxX - minX <= usableWidth && maxY - minY <= usableHeight};
  }

  let pose = measure(maxZoom);
  if (!pose.fits) {
    pose = measure(minZoom);
    let limit = maxZoom;
    for (let step = 0; step < 12; step += 1) {
      const candidate = measure((pose.zoom + limit) / 2);
      if (candidate.fits) pose = candidate;
      else limit = candidate.zoom;
    }
  }
  const center = [
    (frame.left + frame.right - pose.minX - pose.maxX) / (2 * width),
    (frame.top + frame.bottom - pose.minY - pose.maxY) / (2 * height),
  ];
  return [lon, lat, pose.zoom, center];
}
