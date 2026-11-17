import {buildRegionLinework} from '../regionLinework.js';
import {atlasAngles, atlasPoints, chartScale, clamp, direction, projectAtlas} from './projection.js';

const REVEAL_ZOOM = 3.8;
// 粗裁剪网格：path（chart 像素）空间 512px 单元，每个单元存相交段的原始下标。
const GRID_CELL = 512;
// 可视框向外补的 CSS 像素余量：线宽、round cap/join 外沿与投影抖动的保守合计。
const CULL_PAD_CSS = 3;
// 候选 Path2D 缓存上限：同一镜头连续帧命中同一候选序列时零重建成本。
const CANDIDATE_CACHE_LIMIT = 8;
const NUMBER = /-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g;

// 每段独立子路径（M 开头），取路径里所有数字（Q/C 控制点全部在曲线包络内）
// 两两配对即保守 bbox：过滤整段子路径与原全量 stroke 严格等价。
function segmentBoxes(segments) {
  return segments.map(({path}) => {
    const numbers = path.match(NUMBER);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < numbers.length; i += 2) {
      const x = +numbers[i];
      const y = +numbers[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {path, box: [minX, minY, maxX, maxY]};
  });
}

function buildGrid(boxes) {
  const grid = new Map();
  boxes.forEach(({box: [minX, minY, maxX, maxY]}, index) => {
    for (let y = Math.floor(minY / GRID_CELL); y <= Math.floor(maxY / GRID_CELL); y += 1) {
      for (let x = Math.floor(minX / GRID_CELL); x <= Math.floor(maxX / GRID_CELL); x += 1) {
        const key = `${x},${y}`;
        const cell = grid.get(key);
        if (cell) cell.push(index);
        else grid.set(key, [index]);
      }
    }
  });
  return grid;
}

// 去重靠代际戳：每帧查询递增 id，段按原始下标去重后升序，保持原始段序。
function visibleBoxes(grid, boxes, stamps, queryId, box) {
  const [minX, minY, maxX, maxY] = box;
  const hits = [];
  for (let y = Math.floor(minY / GRID_CELL); y <= Math.floor(maxY / GRID_CELL); y += 1) {
    for (let x = Math.floor(minX / GRID_CELL); x <= Math.floor(maxX / GRID_CELL); x += 1) {
      for (const index of grid.get(`${x},${y}`) ?? []) {
        if (stamps[index] === queryId) continue;
        stamps[index] = queryId;
        const [ax, ay, bx, by] = boxes[index].box;
        if (ax <= maxX && bx >= minX && ay <= maxY && by >= minY) hits.push(index);
      }
    }
  }
  hits.sort((a, b) => a - b);
  return hits;
}

// 候选序列一致时复用同一 Path2D；插入序淘汰最旧条目。
function candidatePath(cache, hits, boxes) {
  const key = hits.join(',');
  let entry = cache.get(key);
  if (!entry) {
    entry = new Path2D(hits.length ? hits.map((index) => boxes[index].path).join('') : '');
    if (cache.size >= CANDIDATE_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, entry);
  } else {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

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
    if (lunar) {
      globe.boundaryGeometry = lunarSegments(regions, world);
    } else {
      const segments = buildRegionLinework(regions, globe.smoothBoundaries).segments;
      const boxes = segmentBoxes(segments);
      globe.boundaryGeometry = segments;
      globe.boundaryBoxes = boxes;
      globe.boundaryGrid = buildGrid(boxes);
      globe.boundaryStamps = new Array(boxes.length).fill(0);
      globe.boundaryQueries = 0;
      globe.boundaryCache = new Map();
    }
  }
  globe.boundaryRevealedAt ??= time;
  const reveal = globe.reducedMotion.matches ? 1 : clamp((time - globe.boundaryRevealedAt) / 180, 0, 1);
  if (reveal < 1) globe.requestFrame();

  ctx.save();
  ctx.beginPath();
  // 极窄视口下球体直径可不足 2px，radius - 1 会变负使 arc 抛 IndexSizeError；退化时收到 0。
  ctx.arc(cx, cy, Math.max(0, radius - 1), 0, Math.PI * 2);
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
    const translateX = cx - u * radius / sx;
    const translateY = cy - v * radius / sy;
    ctx.translate(translateX, translateY);
    ctx.scale(scaleX, scaleY);
    ctx.beginPath();
    ctx.rect(0, 0, imageWidth / 4, imageHeight / 4);
    ctx.clip();
    ctx.lineWidth = .85 / scaleX;
    // 可视范围（屏幕视口 ∩ 盘面圆）逆投影到 path 空间，向外补保守余量后
    // 查网格取整段；一次 stroke 送同一 Path2D，段序/线宽/裁剪与全量等价。
    const padX = CULL_PAD_CSS / scaleX;
    const padY = CULL_PAD_CSS / scaleY;
    const left = Math.max(0, cx - radius) - translateX;
    const top = Math.max(0, cy - radius) - translateY;
    const right = Math.min(globe.width, cx + radius) - translateX;
    const bottom = Math.min(globe.height, cy + radius) - translateY;
    const box = [
      left / scaleX - padX,
      top / scaleY - padY,
      right / scaleX + padX,
      bottom / scaleY + padY,
    ];
    globe.boundaryQueries += 1;
    const hits = visibleBoxes(globe.boundaryGrid, globe.boundaryBoxes, globe.boundaryStamps, globe.boundaryQueries, box);
    ctx.stroke(candidatePath(globe.boundaryCache, hits, globe.boundaryBoxes));
  }
  ctx.restore();
}
