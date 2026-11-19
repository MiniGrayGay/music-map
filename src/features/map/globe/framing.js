import {atlasAngles, cameraBasis, clamp, outlineDepth, projectAtlas, projectVisibleOutline} from './projection.js';

const reliefMaxGap = 56;
const frameMargin = 16;

export function reliefCardSize({width, height}) {
  const cardWidth = Math.min(490, width * .37, height * .65);
  return {width: cardWidth, height: cardWidth / 1.65};
}

function reliefConnections(zone, panel, points) {
  const middle = (zone.top + zone.bottom) / 2;
  const padding = Math.min(18, panel.height * .12);
  const min = panel.top + padding;
  const max = panel.top + panel.height - padding;
  const best = [null, null];

  for (const [x, y] of points) {
    const normalDistance = panel.left - x;
    const index = y <= middle ? 0 : 1;
    const side = index === 0 ? -1 : 1;
    // The two leads flare outward as they meet the left edge of the card.
    const minimumOffset = Math.max(8, normalDistance * .46);
    const low = side > 0 ? Math.max(min, y + minimumOffset) : min;
    const high = side < 0 ? Math.min(max, y - minimumOffset) : max;
    if (low > high) continue;
    const desiredOffset = clamp(normalDistance * .82, 18, 68);
    const attach = clamp(y + side * desiredOffset, low, high);
    const distance = Math.hypot(normalDistance, attach - y);
    if (!best[index] || distance < best[index].distance) {
      best[index] = {x, y, attach, to: [panel.left, attach], distance};
    }
  }
  return best.every(Boolean) ? best : null;
}

export function placeReliefCard(zone, {width, height}, points) {
  const gap = clamp(Math.min(zone.right - zone.left, zone.bottom - zone.top) * .17, 34, reliefMaxGap);
  const left = zone.right + gap;
  const top = (zone.top + zone.bottom - height) / 2;
  // The viewport clips the card as the selected area moves with the map.
  const panel = {left, top, width, height};
  return {...panel, leads: reliefConnections(zone, panel, points)};
}

function unobstructedFrame(width, height, obstacles) {
  const margin = frameMargin;
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

export function frameZone(world, zone, {width, height, radius, obstacles, minZoom, maxZoom, withRelief = false}) {
  const [left, top, right, bottom] = zone.bounds;
  const [lon, lat] = world.projection === 2 ? [zone.lon, zone.lat]
    : atlasAngles(world, (left + right) / 2, (top + bottom) / 2);
  const basis = cameraBasis(lon, lat);
  const outline = zone.outlines.flat();
  const lunarOutline = world.projection === 2 ? zone.outlines.flatMap((ring) =>
    projectVisibleOutline(world, basis, 1, ring)) : [];
  const frame = unobstructedFrame(width, height, obstacles);
  const rightLimit = withRelief ? width - reliefCardSize({width, height}).width - reliefMaxGap - frameMargin : width;
  const usableWidth = Math.min((frame.right - frame.left) * .78, Math.max(1, rightLimit - frame.left));
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
  const initialX = (frame.left + frame.right - pose.minX - pose.maxX) / 2;
  const centerX = withRelief ? Math.max(frame.left - pose.minX, Math.min(initialX, rightLimit - pose.maxX)) : initialX;
  const center = [
    centerX / width,
    (frame.top + frame.bottom - pose.minY - pose.maxY) / (2 * height),
  ];
  return [lon, lat, pose.zoom, center];
}
