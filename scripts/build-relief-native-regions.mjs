import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {reliefBlockBytes} from '../src/features/map/reliefFormat.js';
import {reliefFileNames} from './asset-layout.mjs';
import {containsWorldPoint, sampleEditorModels} from './editor-relief-models.mjs';
import {loadReliefElevation, modeledFootprint} from './relief-elevation.mjs';

const {values} = parseArgs({options: {base: {type: 'string'}, out: {type: 'string'}}});
if (!values.base || !values.out) throw new Error('需要 --base 地表点阵目录和 --out 输出目录');
const readJson = async (name) => JSON.parse(await readFile(name, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bgm = await readJson(new URL('../../../dist/genshin-region-bgm.json', import.meta.url));
const index = await readJson(path.join(values.base, 'index.json'));
reliefFileNames(index, bgm);
if (index.modelSources.snezhnaya || index.modelSources.silo) throw new Error('专项原生模型已经合入输入点阵');
const base = await readFile(path.join(values.base, index.file));
if (base.length !== index.bytes || sha256(base) !== index.sha256) throw new Error('输入点阵指纹不符');

function regionBounds({id, rings}) {
  const vertices = rings.flat();
  const xs = vertices.map(([x]) => x), zs = vertices.map(([, z]) => z);
  return {id, rings, sideElevation: [-Infinity, Infinity],
    bounds: {minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs)}};
}
const regions = bgm.zones.filter(({state}) => state.startsWith('State_Zone_v72_ZD_')).map(regionBounds);
const siloRegions = bgm.zones.filter(({state}) =>
  /^State_Zone_v67_NDKL_(?:GuLongFaSheJiDi_One|FaSheJiDiBenTi_Two)$/.test(state)).map(regionBounds);
// The physical silo shaft spans both silo music zones: the pit zone's inner
// rings are music-boundary holes, not structure limits. Model sampling uses
// the outer ring only, so the published shaft stays one continuous body
// while every zone keeps its original ground geometry.
for (const region of siloRegions) region.modelRings = [region.rings[0]];
if (!regions.length || siloRegions.length !== 2) throw new Error('音乐清单缺少至冬 7.2 或杜南纳的地表分区');
const clientSha256 = bgm.source.clientExecutableSha256;
const elevation = await loadReliefElevation(clientSha256, [...regions, ...siloRegions]);
const source = await sampleEditorModels(regions, {
  sides: true,
  nativeClientSha256: clientSha256,
  contains: containsWorldPoint,
  surfaceHeight(x, z) {
    const y = elevation(x, z);
    return Number.isFinite(y) ? y : null;
  },
});
if (!source.assets || !source.points || source.skipped) throw new Error('原生至冬几何读取不完整');
const siloSource = await sampleEditorModels(siloRegions, {
  sides: true,
  contains: containsWorldPoint,
  // Only these original exposed shaft meshes may cross below the surrounding heightfield.
  exposedModel: {datasetId: 'terrain-lod0-surface-supplement',
    assetName: /BigWorld_5_8_TerrainMesh_GLFSJD_F[123]_.*_Lod0$/, spacing: 2},
});
if (!siloSource.assets || !siloSource.points || siloSource.skipped) throw new Error('杜南纳井体几何读取不完整');

function footprint(points) {
  const sorted = points.map(([x, , z]) => [x, z]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const outline = (ordered) => {
    const boundary = [];
    for (const [x, z] of ordered) {
      while (boundary.length >= 2) {
        const [ax, az] = boundary.at(-2), [bx, bz] = boundary.at(-1);
        if ((bx - ax) * (z - az) - (bz - az) * (x - ax) > 0) break;
        boundary.pop();
      }
      boundary.push([x, z]);
    }
    boundary.pop();
    return boundary;
  };
  return [...outline(sorted), ...outline(sorted.reverse())];
}

const sampled = new Map(regions.map((region) => [String(region.id), region]));
const openings = new Map(siloRegions.map((region) => {
  const depth = [...region.model.values()].filter(([x, y, z]) => y < elevation(x, z) - 9);
  const boundary = footprint(depth);
  if (boundary.length < 3) throw new Error(`原始井体不能证明开口 ${region.id}`);
  return [String(region.id), {region, depth: depth.length, boundary}];
}));
const zones = Object.create(null);
const blocks = [];
let offset = 0, added = 0, removed = 0, lowered = 0;
const regionCounts = {};
const siloCounts = {};
for (const [id, original] of Object.entries(index.zones).sort((a, b) => a[1].offset - b[1].offset)) {
  const entry = {...original, offset};
  const gridBytes = original.grid ? original.grid.columns * original.grid.rows * 4 : 0;
  const open = openings.get(id);
  const region = open?.region ?? sampled.get(id);
  const segment = base.subarray(original.offset, original.offset + reliefBlockBytes(original));
  const chunk = region ? Buffer.from(segment) : segment;
  let cut = 0;
  if (region?.model.size && gridBytes && !open) {
    const {originX, originZ, spacing, columns} = original.grid;
    const covered = modeledFootprint(region.model.values(), original.grid, elevation);
    let changed = 0;
    for (let i = 0; i < covered.length; i++) {
      if (!covered[i]) continue;
      const height = chunk.readFloatLE(i * 4);
      const ground = elevation(originX + i % columns * spacing, originZ + Math.floor(i / columns) * spacing);
      if (!Number.isFinite(ground) || !Number.isFinite(height) || height <= ground + .4) continue;
      chunk.writeFloatLE(ground, i * 4);
      changed++;
    }
    entry.modelCount = Math.max(0, entry.modelCount - changed);
    lowered += changed;
  }
  if (open && gridBytes) {
    const {originX, originZ, spacing, columns} = original.grid;
    for (let i = 0; i < gridBytes / 4; i++) {
      const height = chunk.readFloatLE(i * 4);
      if (!Number.isFinite(height)) continue;
      const x = originX + i % columns * spacing, z = originZ + Math.floor(i / columns) * spacing;
      if (!containsWorldPoint([open.boundary], x, z) || height < elevation(x, z) - 9) continue;
      chunk.writeFloatLE(NaN, i * 4);
      cut++;
    }
    if (!cut) throw new Error(`杜南纳盖板范围与音乐区脱节 ${id}`);
    entry.count -= cut;
    entry.modelCount = Math.min(entry.modelCount, entry.count);
    removed += cut;
  }
  blocks.push(chunk);
  offset += chunk.length;
  if (region?.model.size && gridBytes) {
    const spacing = open ? 2 : Math.max(1, Math.min(3.5, original.grid.spacing * .65));
    const cell = (x, y, z) => `${Math.floor(x / spacing)}/${Math.floor(y / spacing)}/${Math.floor(z / spacing)}`;
    const occupied = new Set();
    for (let i = gridBytes; i < chunk.length; i += 12) {
      occupied.add(cell(chunk.readFloatLE(i), chunk.readFloatLE(i + 4), chunk.readFloatLE(i + 8)));
    }
    const candidates = [...region.model.values()];
    const size = Math.min(open ? 28000 : 12000, candidates.length);
    const extra = Buffer.alloc(size * 12);
    let count = 0;
    for (let i = 0; i < size; i++) {
      const [x, y, z] = candidates[Math.floor(i * candidates.length / size)];
      const key = cell(x, y, z);
      if (occupied.has(key)) continue;
      occupied.add(key);
      extra.writeFloatLE(x, count * 12);
      extra.writeFloatLE(y, count * 12 + 4);
      extra.writeFloatLE(z, count * 12 + 8);
      count++;
    }
    entry.sideCount = (entry.sideCount ?? 0) + count;
    blocks.push(extra.subarray(0, count * 12));
    offset += count * 12;
    if (open) siloCounts[id] = {points: count, deepSamples: open.depth, removedGroundCells: cut};
    else regionCounts[id] = count;
    added += count;
  }
  zones[id] = entry;
}
if (!Object.keys(regionCounts).length || Object.keys(siloCounts).length !== openings.size) {
  throw new Error('专项分区缺少可追加的原生模型点');
}
const pack = Buffer.concat(blocks, offset);
const digest = sha256(pack);
const next = {...index, bytes: pack.length, sha256: digest, file: `points-${digest.slice(0, 16)}.f32`, zones,
  uniform: {...index.uniform, totalPoints: index.uniform.totalPoints + added - removed,
    sidePoints: index.uniform.sidePoints + added},
  modelSources: {...index.modelSources, snezhnaya: {...source, clientSha256, regionCounts, lowered},
    silo: {...siloSource, clientSha256, regionCounts: siloCounts}}};
reliefFileNames(next, bgm);
await mkdir(values.out);
await writeFile(path.join(values.out, next.file), pack, {flag: 'wx'});
await writeFile(path.join(values.out, 'index.json'), JSON.stringify(next) + '\n', {flag: 'wx'});
console.log(JSON.stringify({added, removed, lowered, regionCounts, siloCounts, bytes: pack.length, file: next.file}));
