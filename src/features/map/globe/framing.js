import {atlasAngles, cameraBasis, clamp, outlineDepth, projectAtlas, projectVisibleOutline} from './projection.js';

function reliefConnections(zone, panel, points) {
  const {edge} = panel;
  const horizontal = edge === 'top' || edge === 'bottom';
  const start = horizontal ? panel.left : panel.top;
  const length = horizontal ? panel.width : panel.height;
  const middle = horizontal ? (zone.left + zone.right) / 2 : (zone.top + zone.bottom) / 2;
  const padding = Math.min(18, length * .12);
  const min = start + padding;
  const max = start + length - padding;
  const edgePosition = panel[edge];
  const best = [null, null];

  for (const [x, y] of points) {
    const along = horizontal ? x : y;
    const normalDistance = Math.abs((horizontal ? y : x) - edgePosition);
    const index = along <= middle ? 0 : 1;
    const side = index === 0 ? -1 : 1;
    // Both leads move outward along the edge by a fixed minimum angle,
    // even when the dock is offset to make room for a map label.
    const minimumOffset = Math.max(8, normalDistance * .46);
    const low = side > 0 ? Math.max(min, along + minimumOffset) : min;
    const high = side < 0 ? Math.min(max, along - minimumOffset) : max;
    if (low > high) continue;
    const desiredOffset = clamp(normalDistance * .82, 18, 68);
    const attach = clamp(along + side * desiredOffset, low, high);
    const distance = Math.hypot(normalDistance, attach - along);
    if (!best[index] || distance < best[index].distance) {
      best[index] = {x, y, attach, to: horizontal ? [attach, edgePosition] : [edgePosition, attach], distance};
    }
  }
  return best.every(Boolean) ? best : null;
}

export function placeReliefCard(zone, card, viewport, obstacles, previousEdge, points) {
  const margin = 16;
  const gap = clamp(Math.min(zone.right - zone.left, zone.bottom - zone.top) * .17, 34, 56);
  const compactZone = Math.max(zone.right - zone.left, zone.bottom - zone.top) < 120;
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const zoneDistance = Math.hypot((zone.left + zone.right) / 2 - centerX, (zone.top + zone.bottom) / 2 - centerY);
  let best = null;
  let linked = null;
  for (const scale of [1, .84, .7, .56]) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const vertical = edge === 'left' || edge === 'right';
      const width = card.width * scale;
      const height = card.height * scale;
      const fixed = {
        left: zone.right + gap,
        right: zone.left - gap - width,
        top: zone.bottom + gap,
        bottom: zone.top - gap - height,
      }[edge];
      const fixedSize = vertical ? width : height;
      const fixedLimit = (vertical ? viewport.width : viewport.height) - margin;
      if (fixed < margin || fixed + fixedSize > fixedLimit) continue;

      const size = vertical ? height : width;
      const start = vertical ? zone.top : zone.left;
      const end = vertical ? zone.bottom : zone.right;
      const center = (start + end) / 2;
      const limit = (vertical ? viewport.height : viewport.width) - size - margin;
      if (limit < margin) continue;
      const positions = [center - size / 2];
      for (const obstacle of obstacles) {
        const low = vertical ? obstacle.left : obstacle.top;
        const high = vertical ? obstacle.right : obstacle.bottom;
        if (fixed >= high + 10 || fixed + fixedSize <= low - 10) continue;
        positions.push((vertical ? obstacle.top : obstacle.left) - size - 10,
          (vertical ? obstacle.bottom : obstacle.right) + 10);
      }
      for (const position of positions) {
        const along = clamp(position, margin, limit);
        if (along + size < start - gap || along > end + gap) continue;
        const left = vertical ? fixed : along;
        const top = vertical ? along : fixed;
        const right = left + width;
        const bottom = top + height;
        if (obstacles.some(o => left < o.right + 10 && right > o.left - 10
          && top < o.bottom + 10 && bottom > o.top - 10)) continue;
        const cardDistance = Math.hypot(left + width / 2 - centerX, top + height / 2 - centerY);
        const inwardPenalty = compactZone ? Math.max(0, zoneDistance - cardDistance) * .55 : 0;
        const score = Math.abs(along + size / 2 - center) + inwardPenalty
          + (1 - scale) * 160 + (edge === previousEdge ? 0 : 26);
        const panel = {left, right, top, bottom, width, height, edge, score};
        if (!best || score < best.score) best = panel;
        if (!linked || score < linked.score) {
          const leads = reliefConnections(zone, panel, points);
          if (leads) linked = {...panel, leads};
        }
      }
    }
  }
  // Leader lines are optional. A clear position is enough to show the card.
  return linked ?? best;
}

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
