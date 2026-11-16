import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {decodeTerrainHeight} from '../../teyvat-map-editor/src/terrainHeightfield.js';
import {readSurfaceTerrain} from './bgm-surface-terrain.mjs';
import {reliefFileNames, reliefZoneSignature} from './asset-layout.mjs';
import {containsWorldPoint as contains, sampleEditorModels} from './editor-relief-models.mjs';

const {values} = parseArgs({options: {out: {type: 'string'}, part: {type: 'string'}, parts: {type: 'string'}}});
if (!values.out) throw new Error('需要 --out 指定已登记的生成目录');
const part = Number(values.part ?? 0), parts = Number(values.parts ?? 1);
if (![part, parts].every(Number.isSafeInteger) || parts < 1 || part < 0 || part >= parts) throw new Error('点阵批次编号无效');
const output = path.resolve(values.out);
await mkdir(output);
const bgm = JSON.parse(await readFile(new URL('../../../dist/genshin-region-bgm.json', import.meta.url), 'utf8'));
if (bgm.sceneId !== 3 || bgm.clientVersion !== '7.2.0' || !Array.isArray(bgm.zones)) {
  throw new Error('需要当前主世界地表音乐分区');
}
const terrain = await readSurfaceTerrain(bgm.source.clientExecutableSha256);
const pointSources = terrain.tiles.map((tile) => ({
  ...tile, read: () => Promise.all([terrain.samples(tile), terrain.holes(tile)]),
}));

// The editor's exact geometry entry loads this verified tile alongside the catalog.
const supplement = new URL('../../../research/world/pipelines/proto-material-pipeline/exact/streamgen-7.2/', import.meta.url);
const scene = JSON.parse(await readFile(new URL('scene.json', supplement), 'utf8'));
if (scene.schema !== 'streamgen-geometry-review/v1' || scene.heightResolution !== 513
  || scene.origin[0] !== scene.tile[0] * 1024 || scene.origin[2] !== scene.tile[1] * 1024) {
  throw new Error('编辑器补充地形契约不符');
}
if (!pointSources.some(({tile}) => tile.join('/') === scene.tile.join('/'))) {
  const [x0, yOffset, z0] = scene.origin;
  pointSources.push({tile: scene.tile, heightResolution: scene.heightResolution,
    x0, z0, x1: x0 + 1024, z1: z0 + 1024, yOffset,
    async read() {
      return Promise.all(['heights', 'holes'].map(async (name) => {
        const asset = scene.assets[name];
        if (!/^[\w.-]+$/.test(asset.path)) throw new Error('补充地形路径不符');
        const bytes = await readFile(new URL(asset.path, supplement));
        if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('补充地形摘要不符');
        return bytes;
      }));
    }});
}

const resources = new Map();
function hasSurface(holes, cells, x, z) {
  for (let row = Math.max(0, z - 1); row <= Math.min(z, cells - 1); row++) {
    for (let col = Math.max(0, x - 1); col <= Math.min(x, cells - 1); col++) {
      if (holes[row * cells + col] !== 255) return true;
    }
  }
  return false;
}

async function sample(rings, bounds, tiles, stride) {
  const selected = [];
  const seen = new Set();
  for (const tile of tiles) {
    const cells = tile.heightResolution - 1;
    const gridStep = (tile.x1 - tile.x0) / cells;
    const start = (value, origin) => Math.max(0, Math.ceil((value - origin) / (gridStep * stride)) * stride);
    const end = (value, origin) => Math.min(cells, Math.floor((value - origin) / gridStep));
    if (!resources.has(tile)) resources.set(tile, tile.read());
    const [heights, holes] = await resources.get(tile);
    if (heights.length !== tile.heightResolution ** 2 * 2 || holes.length !== cells ** 2
      || !Number.isFinite(tile.yOffset)) throw new Error(`高程数据不完整 ${tile.tile}`);
    for (let z = start(bounds.minZ, tile.z0); z <= end(bounds.maxZ, tile.z0); z += stride) {
      const worldZ = tile.z0 + z * gridStep;
      for (let x = start(bounds.minX, tile.x0); x <= end(bounds.maxX, tile.x0); x += stride) {
        const worldX = tile.x0 + x * gridStep;
        const key = `${worldX}/${worldZ}`;
        if (seen.has(key) || !contains(rings, worldX, worldZ) || !hasSurface(holes, cells, x, z)) continue;
        seen.add(key);
        const height = decodeTerrainHeight(heights.readUInt16LE(2 * (z * tile.heightResolution + x))) + tile.yOffset;
        selected.push(worldX, height, worldZ);
      }
    }
  }
  return selected;
}

const regions = bgm.zones.map(({id, rings}) => {
  const positions = rings.flat();
  const x = positions.map(([x]) => x), z = positions.map(([, z]) => z);
  const bounds = {minX: Math.min(...x), maxX: Math.max(...x), minZ: Math.min(...z), maxZ: Math.max(...z)};
  const tiles = pointSources.filter((tile) => tile.x0 <= bounds.maxX && tile.x1 >= bounds.minX
    && tile.z0 <= bounds.maxZ && tile.z1 >= bounds.minZ);
  return {id, rings, bounds, tiles};
});

const surfaceTiles = new Map();
for (const tile of new Set(regions.flatMap(({tiles}) => tiles))) {
  const task = tile.read();
  resources.set(tile, task);
  const [heights, holes] = await task;
  const cells = tile.heightResolution - 1;
  if (heights.length !== tile.heightResolution ** 2 * 2 || holes.length !== cells ** 2) throw new Error('原生地形长度不符');
  surfaceTiles.set(tile.tile.join('/'), {tile, heights, holes, cells});
}
function surfaceHeight(x, z) {
  const source = surfaceTiles.get(`${Math.floor(x / 1024)}/${Math.floor(z / 1024)}`);
  if (!source) return null;
  const {tile, heights, cells} = source;
  const u = (x - tile.x0) / 2, v = (z - tile.z0) / 2;
  const col = Math.floor(u), row = Math.floor(v);
  if (col < 0 || col >= cells || row < 0 || row >= cells) return null;
  // The stored surface remains an altitude reference over an authored hole.
  // The ground sampler still excludes holes, so this reference adds no points.
  const width = tile.heightResolution;
  const first = (row * width + col) * 2;
  const a = heights.readUInt16LE(first), b = heights.readUInt16LE(first + 2);
  const c = heights.readUInt16LE(first + width * 2), d = heights.readUInt16LE(first + width * 2 + 2);
  const du = u - col, dv = v - row;
  const height = du >= dv ? a + du * (b - a) + dv * (d - b) : a + dv * (c - a) + du * (d - c);
  return decodeTerrainHeight(height) + tile.yOffset;
}
for (const region of regions) {
  const {rings, bounds, tiles} = region;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  let stride = 2 ** Math.max(0, Math.ceil(Math.log2(span / 225)));
  let points = await sample(rings, bounds, tiles, stride);
  while (points.length < 18 && stride > 1) {
    stride /= 2;
    points = await sample(rings, bounds, tiles, stride);
  }
  region.ground = points;
}
const modelSources = await sampleEditorModels(regions, {contains, surfaceHeight, part, parts});

const zones = Object.create(null);
const buffers = [];
let offset = 0;
for (const {id, model, ground} of regions) {
  const points = part === 0 ? ground : [];
  if (!points.length && !model.size) continue;
  const modelCount = Math.min(9400, model.size);
  const originals = [...model.values()];
  for (let index = 0; index < modelCount; index++) {
    points.push(...originals[Math.floor(index * originals.length / modelCount)]);
  }
  const bytes = Buffer.alloc(points.length * 4);
  points.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  zones[String(id)] = {offset, count: points.length / 3, modelCount};
  buffers.push(bytes);
  offset += bytes.length;
}

const bytes = Buffer.concat(buffers, offset);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const index = {schema: 1, version: bgm.clientVersion, zoneSignature: reliefZoneSignature(bgm.zones),
  sha256, file: `points-${sha256.slice(0, 16)}.f32`, bytes: bytes.length, modelSources, zones};
reliefFileNames(index, bgm);
await writeFile(path.join(output, index.file), bytes, {flag: 'wx'});
await writeFile(path.join(output, 'index.json'), JSON.stringify(index) + '\n', {flag: 'wx'});
console.log(`分区点阵覆盖 ${Object.keys(zones).length}/${bgm.zones.length} 个地表分区，共 ${offset / 12} 点`);
