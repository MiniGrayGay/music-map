import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {reliefFileNames} from './asset-layout.mjs';
import {containsWorldPoint, sampleEditorModels} from './editor-relief-models.mjs';
import {loadReliefElevation, modeledFootprint} from './relief-elevation.mjs';

const {values} = parseArgs({options: {input: {type: 'string'}, out: {type: 'string'}, 'mesh-sides': {type: 'boolean'}}});
if (!values.input || !values.out) throw new Error('需要 --input 原始模型点阵目录和 --out 生成目录');
const input = path.resolve(values.input), output = path.resolve(values.out);
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const bgm = await readJson(new URL('../../../dist/genshin-region-bgm.json', import.meta.url));
const seed = await readJson(path.join(input, 'index.json'));
reliefFileNames(seed, bgm);
if (Object.values(seed.zones).some(({grid}) => grid)) throw new Error('输入必须是原始模型点阵，不能重复重采样');
const seedBytes = await readFile(path.join(input, seed.file));
if (createHash('sha256').update(seedBytes).digest('hex') !== seed.sha256) throw new Error('原始模型点阵摘要不符');

const sourceElevation = await loadReliefElevation(bgm.source.clientExecutableSha256);

function gridFor(rings) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const ring of rings) for (const [x, z] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const spacing = Math.max(.5, Math.max(maxX - minX, maxZ - minZ) / 224);
  return {spacing, originX: minX + spacing / 2, originZ: minZ + spacing / 2,
    columns: Math.max(1, Math.ceil((maxX - minX) / spacing)), rows: Math.max(1, Math.ceil((maxZ - minZ) / spacing))};
}

function cellsInRegion(rings, {columns, rows, spacing, originX, originZ}) {
  const area = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    const z = originZ + row * spacing;
    const crossings = [];
    for (const ring of rings) {
      let [ax, az] = ring.at(-1);
      for (const [bx, bz] of ring) {
        if ((az > z) !== (bz > z)) crossings.push(ax + (bx - ax) * (z - az) / (bz - az));
        ax = bx;
        az = bz;
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 1; i < crossings.length; i += 2) {
      const start = Math.max(0, Math.ceil((crossings[i - 1] - originX) / spacing));
      const end = Math.min(columns, Math.ceil((crossings[i] - originX) / spacing));
      if (end > start) area.fill(1, row * columns + start, row * columns + end);
    }
  }
  return area;
}

function sourcePoints(entry) {
  const original = [];
  for (let i = 0; i < entry.count; i++) {
    const offset = entry.offset + i * 12;
    const [x, y, z] = [0, 4, 8].map((axis) => seedBytes.readFloatLE(offset + axis));
    if (![x, y, z].every(Number.isFinite)) throw new Error('原始分区点阵含有无效位置');
    const isModel = i >= entry.count - entry.modelCount;
    const height = isModel ? sourceElevation(x, z) : NaN;
    if (!Number.isFinite(height) || y >= height - 9) original.push({x, y, z, isModel, ground: height});
  }
  return original;
}

function atCell(point, {originX, originZ, spacing, columns, rows}) {
  const col = Math.round((point.x - originX) / spacing), row = Math.round((point.z - originZ) / spacing);
  return col >= 0 && col < columns && row >= 0 && row < rows ? row * columns + col : -1;
}

function closestModel(buckets, grid, row, col, x, z) {
  const {columns, rows, spacing} = grid;
  let bestDistance = (spacing * 2.55) ** 2;
  let height = NaN;
  for (let iz = Math.max(0, row - 3); iz <= Math.min(rows - 1, row + 3); iz++) {
    for (let ix = Math.max(0, col - 3); ix <= Math.min(columns - 1, col + 3); ix++) {
      const point = buckets[iz * columns + ix];
      if (!point) continue;
      const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      height = point.y;
    }
  }
  return height;
}

function sideSamples(originals, heights, grid, meshSamples) {
  const samples = new Map();
  const spacing = Math.max(.65, Math.min(3.5, grid.spacing * .65));
  const clearance = Math.max(.55, spacing * .36);
  for (const point of originals) {
    if (!point.isModel) continue;
    const {x, y, z, ground} = point;
    const cell = atCell(point, grid);
    const top = heights[cell];
    if (!Number.isFinite(top) || top - y < clearance) continue;
    if (Number.isFinite(ground) && y < ground - 1.5) continue;
    const key = [x, y, z].map((coordinate) => Math.floor(coordinate / spacing)).join('/');
    if (!samples.has(key)) samples.set(key, point);
  }
  if (meshSamples?.size) {
    const points = [...meshSamples.values()];
    const maxPoints = Math.min(14500, points.length);
    for (let i = 0; i < maxPoints; i++) {
      const [x, y, z] = points[Math.floor(i * points.length / maxPoints)];
      const top = heights[atCell({x, z}, grid)];
      if (Number.isFinite(top) && Math.abs(top - y) < clearance) continue;
      const key = [x, y, z].map((coordinate) => Math.floor(coordinate / spacing)).join('/');
      if (!samples.has(key)) samples.set(key, {x, y, z});
    }
  }
  return [...samples.values()];
}

function writePoints(bytes, points, offset = 0) {
  points.forEach(({x, y, z}, i) => {
    bytes.writeFloatLE(x, offset + i * 12);
    bytes.writeFloatLE(y, offset + i * 12 + 4);
    bytes.writeFloatLE(z, offset + i * 12 + 8);
  });
}

function completeCoverage(heights, area, grid, originals) {
  const {columns, rows} = grid;
  const queue = new Int32Array(area.length);
  const nearest = new Int32Array(area.length).fill(-1);
  let count = 0;
  function seed(index) {
    nearest[index] = index;
    queue[count++] = index;
  }
  for (let i = 0; i < heights.length; i++) if (Number.isFinite(heights[i])) seed(i);
  if (!count) {
    for (const source of originals) {
      const i = atCell(source, grid);
      if (i < 0 || nearest[i] !== -1) continue;
      heights[i] = source.y;
      seed(i);
    }
  }
  if (!count) return 0;

  function visit(next, from) {
    if (nearest[next] !== -1) return;
    nearest[next] = nearest[from];
    queue[count++] = next;
  }
  for (let head = 0; head < count; head++) {
    const i = queue[head];
    const col = i % columns, row = Math.floor(i / columns);
    if (col > 0) visit(i - 1, i);
    if (col < columns - 1) visit(i + 1, i);
    if (row > 0) visit(i - columns, i);
    if (row < rows - 1) visit(i + columns, i);
  }
  let filled = 0;
  for (let i = 0; i < area.length; i++) if (area[i] && !Number.isFinite(heights[i])) {
    heights[i] = heights[nearest[i]];
    filled++;
  }
  for (let i = 0; i < area.length; i++) if (!area[i]) heights[i] = NaN;
  return filled;
}

const zones = Object.create(null);
const blocks = [];
let offset = 0;
let regular = 0, narrow = 0, totalPoints = 0, filledCells = 0, sidePoints = 0;
const structuredRegions = new Map();
let sideSources;
if (values['mesh-sides']) {
  for (const {id, rings} of bgm.zones) {
    const grid = gridFor(rings);
    const source = sourcePoints(seed.zones[String(id)]);
    if (!source.length) continue;
    const ys = source.map(({y}) => y).sort((a, b) => a - b);
    const lower = ys[Math.floor(ys.length * .015)];
    const upper = ys[Math.floor(ys.length * .99)];
    const {originX, originZ, spacing, columns, rows} = grid;
    const minX = originX - spacing / 2, minZ = originZ - spacing / 2;
    structuredRegions.set(String(id), {id, rings, sideElevation: [lower - 7, upper + 45],
      bounds: {minX, minZ, maxX: minX + columns * spacing, maxZ: minZ + rows * spacing}});
  }
  sideSources = await sampleEditorModels([...structuredRegions.values()], {
    contains: containsWorldPoint,
    surfaceHeight(x, z) {
      const y = sourceElevation(x, z);
      return Number.isFinite(y) ? y : null;
    },
    sides: true,
  });
}
for (const {id, rings} of bgm.zones) {
  const key = String(id);
  const entry = seed.zones[key];
  if (!entry) throw new Error(`分区缺少原始数据 ${id}`);
  const originals = sourcePoints(entry);
  const grid = gridFor(rings);
  const area = cellsInRegion(rings, grid);
  const count = area.reduce((sum, value) => sum + value, 0);
  if (!count) {
    if (!originals.length) throw new Error(`极窄分区缺少地表高度 ${id}`);
    const original = Buffer.alloc(originals.length * 12);
    writePoints(original, originals);
    zones[key] = {offset, count: originals.length, modelCount: originals.filter(({isModel}) => isModel).length};
    offset += original.length;
    blocks.push(original);
    totalPoints += originals.length;
    narrow++;
    continue;
  }

  const {columns, rows, spacing, originX, originZ} = grid;
  const meshSamples = structuredRegions.get(key)?.model;
  const meshFootprint = meshSamples?.size ? modeledFootprint(meshSamples.values(), grid, sourceElevation) : null;
  const models = new Array(area.length);
  for (const point of originals) {
    if (!point.isModel) continue;
    const i = atCell(point, grid);
    if (i >= 0 && (!models[i] || point.y > models[i].y)) models[i] = point;
  }
  const heights = new Float32Array(area.length).fill(NaN);
  let modelCount = 0;
  for (let i = 0; i < area.length; i++) {
    if (!area[i]) continue;
    const col = i % columns, row = Math.floor(i / columns);
    const x = originX + col * spacing, z = originZ + row * spacing;
    const ground = sourceElevation(x, z);
    const model = closestModel(models, grid, row, col, x, z);
    if (Number.isFinite(model) && (!Number.isFinite(ground) || (!meshFootprint?.[i] && model > ground + .4))) {
      heights[i] = model;
      modelCount++;
    } else heights[i] = ground;
  }
  filledCells += completeCoverage(heights, area, grid, originals);
  if (heights.reduce((sum, value) => sum + Number(Number.isFinite(value)), 0) !== count) {
    throw new Error(`未覆盖的分区网格 ${id}`);
  }
  const sides = sideSamples(originals, heights, grid, meshSamples);
  const bytes = Buffer.alloc(heights.byteLength + sides.length * 12);
  heights.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  writePoints(bytes, sides, heights.byteLength);
  zones[key] = {offset, count, modelCount, grid, sideCount: sides.length};
  blocks.push(bytes);
  offset += bytes.length;
  sidePoints += sides.length;
  totalPoints += count + sides.length;
  regular++;
}

const bytes = Buffer.concat(blocks, offset);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const index = {...seed, sha256, file: `points-${sha256.slice(0, 16)}.f32`, bytes: bytes.length,
  modelSources: sideSources ? {...seed.modelSources, sides: sideSources} : seed.modelSources,
  zones, uniform: {sourceSha256: seed.sha256, regular, narrow, filledCells, totalPoints, sidePoints}};
reliefFileNames(index, bgm);
await mkdir(output);
await writeFile(path.join(output, index.file), bytes, {flag: 'wx'});
await writeFile(path.join(output, 'index.json'), JSON.stringify(index) + '\n', {flag: 'wx'});
console.log(JSON.stringify({zones: Object.keys(zones).length, bytes: bytes.length, ...index.uniform}));
