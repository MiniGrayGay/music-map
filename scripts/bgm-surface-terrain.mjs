import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {decodeTerrainHeight} from '../../teyvat-map-editor/src/terrainHeightfield.js';
import {
  covers, geometryMark, intersection, intersects, pointsFromLine, polygonRings, rectangle,
  releaseGeometries, union,
} from './bgm-geometry.mjs';

const terrainRoot = path.resolve(import.meta.dirname, '../../teyvat-map-editor/public/data');
const additionsRoot = path.resolve(terrainRoot,
  '../../../../research/world/pipelines/proto-material-pipeline/exact/streamgen-7.2');
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));

export async function readSurfaceTerrain(executableSha256) {
  const [manifest, additions] = await Promise.all([
    read(path.join(terrainRoot, 'full_terrain/manifest.json')),
    read(path.join(additionsRoot, 'terrain-tiles.json')),
  ]);
  if (manifest.schema !== 'genshin-terraindata-diagnostic-mesh/v3') throw new Error('地形高度清单版本不符');
  if (additions.clientExecutableSha256 !== executableSha256) throw new Error('新增地形的客户端指纹不一致');
  const tiles = manifest.tiles.map((tile) => {
    const {min: [x0, , z0], max: [x1, , z1]} = tile.bounds;
    return {...tile, x0, x1, z0, z1, shape: rectangle(x0, x1, z0, z1),
      file: path.join(terrainRoot, tile.heights), yOffset: tile.worldYOffset ?? manifest.range.worldYOffset};
  });
  const occupied = new Set(manifest.tiles.map(({tile}) => tile.join(':')));
  for (const tile of additions.tiles) {
    if (occupied.has(tile.tile.join(':'))) continue;
    const [x0, yOffset, z0] = tile.source.position;
    const [column, row] = tile.tile;
    const name = tile.assets.heights.path;
    if (x0 !== column * 1024 || z0 !== row * 1024 || tile.heightResolution !== 513
      || !/^terrain-[\d_-]+-heights\.u16$/.test(name)) throw new Error(`新增地形契约不符 ${tile.sector}`);
    const x1 = x0 + 1024;
    const z1 = z0 + 1024;
    tiles.push({...tile, x0, x1, z0, z1, yOffset, shape: rectangle(x0, x1, z0, z1),
      file: path.join(additionsRoot, name), sha256: tile.assets.heights.sha256});
  }
  const coverage = union(tiles.map(({shape}) => shape));
  const reads = new Map();
  async function samples(tile) {
    if (!reads.has(tile.file)) {
      if (tile.heights && !/^full_terrain\/[\w.-]+\.u16$/.test(tile.heights)) throw new Error(`非法地形样本 ${tile.heights}`);
      reads.set(tile.file, readFile(tile.file).then((bytes) => {
        if (tile.sha256 && createHash('sha256').update(bytes).digest('hex') !== tile.sha256) {
          throw new Error(`新增地形高度指纹不一致 ${tile.file}`);
        }
        return bytes;
      }));
    }
    const bytes = await reads.get(tile.file);
    if (bytes.length !== tile.heightResolution ** 2 * 2 || !Number.isFinite(tile.yOffset)) {
      throw new Error(`地形高度样本不完整 ${tile.file}`);
    }
    return bytes;
  }

  // Both the original triangle interpolation and any interpolation along its
  // edges stay within their vertex extrema. Expand the sampled rectangle to
  // whole cells, including on both sides of a tile seam.
  async function heightRange(shape) {
    if (!covers(coverage, shape)) return null;
    const mark = geometryMark();
    try {
      let minimum = Infinity;
      let maximum = -Infinity;
      for (const tile of tiles) {
        if (!intersects(shape, tile.shape)) continue;
        const rings = polygonRings(intersection(shape, tile.shape));
        if (!rings.length) continue;
        const {x0, x1, z0, z1, heightResolution: size} = tile;
        const points = rings.flatMap((ring) => pointsFromLine(ring));
        const x = points.map(([value]) => (value - x0) * (size - 1) / (x1 - x0));
        const z = points.map(([, value]) => (value - z0) * (size - 1) / (z1 - z0));
        const starts = [x, z].map((values) => Math.max(0, Math.floor(Math.min(...values))));
        const ends = [x, z].map((values) => Math.min(size - 1, Math.ceil(Math.max(...values))));
        const bytes = await samples(tile);
        let low = Infinity;
        let high = -Infinity;
        for (let j = starts[1]; j <= ends[1]; j += 1) {
          for (let i = starts[0]; i <= ends[0]; i += 1) {
            const sample = bytes.readUInt16LE((j * size + i) * 2);
            low = Math.min(low, sample);
            high = Math.max(high, sample);
          }
        }
        minimum = Math.min(minimum, decodeTerrainHeight(low) + tile.yOffset);
        maximum = Math.max(maximum, decodeTerrainHeight(high) + tile.yOffset);
      }
      return Number.isFinite(minimum) && Number.isFinite(maximum) ? [minimum, maximum] : null;
    } finally {
      releaseGeometries(mark);
    }
  }
  async function holes(tile) {
    const asset = tile.assets?.holes;
    const name = asset?.path ?? tile.holes;
    const expectedPath = asset ? /^terrain-[\d_-]+-holes\.u8$/ : /^full_terrain\/[\w.-]+\.u8$/;
    if (!expectedPath.test(name ?? '')) throw new Error(`非法地形遮罩 ${name}`);
    const bytes = await readFile(path.join(asset ? additionsRoot : terrainRoot, name));
    if (bytes.length !== (tile.heightResolution - 1) ** 2
      || (asset && createHash('sha256').update(bytes).digest('hex') !== asset.sha256)) {
      throw new Error(`地形遮罩不符 ${name}`);
    }
    return bytes;
  }

  return {heightRange, tiles, samples, holes};
}
