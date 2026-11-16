import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDatasetCatalog, resolveDatasetAsset} from '../../teyvat-map-editor/src/datasetRegistry.js';
import {
  COMPACT_FORMAT, CompactInstanceLoader, PRODUCTION_COMPACT_FORMAT, ProductionCompactLoader,
} from '../../teyvat-map-editor/src/compactInstances.js';
import {PrototypeCache} from '../../teyvat-map-editor/src/prototypeCache.js';
import {decodeTerrainHeight} from '../../teyvat-map-editor/src/terrainHeightfield.js';
import {sampleTerrainReliefHeight} from '../../teyvat-map-editor/src/terrainRelief.js';
import {readExactJson} from '../../../tools/scripts/common/exact_json.mjs';
import {readSurfaceTerrain} from './bgm-surface-terrain.mjs';

const editor = new URL('../../teyvat-map-editor/', import.meta.url);
const dataRoot = fileURLToPath(new URL('public/data/', editor));
const {BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, Raycaster, Vector3} =
  createRequire(new URL('package.json', editor))('three');
const surfaceKinds = new Set([
  'streamgen_city_visual', 'streamgen_visual', 'streamgen_rock_visual', 'streamgen_mlod_visual',
  'terrain_lod0_source', 'nk_hlod_rock', 'zdc_city_hlod',
]);
const structuralKinds = new Set(['streamgen_city_visual', 'streamgen_rock_visual', 'nk_hlod_rock', 'zdc_city_hlod']);
const interiorDatasets = new Set(['zdc-station-interior-visual', 'zdc-lower-rock-visual', 'hns-lower-cave-city-visual']);
const binSize = 256;
export function containsWorldPoint(rings, x, z) {
  let inside = false;
  for (const ring of rings) {
    let [ax, az] = ring.at(-1);
    for (const [bx, bz] of ring) {
      if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
      ax = bx;
      az = bz;
    }
  }
  return inside;
}
const isPlant = (name) => typeof name === 'string'
  && /(?:^|[_.\/\s-])(?:trees?|grass|bush|shrub|foliage|plant|vegetation|leaf|vine|flower|reeds?|broadleaf|willow|straw|conifer)(?:[_.\/\s\d-]|$)/i.test(name);

function plantBinding(binding) {
  const part = binding.nativePart;
  const geometry = binding.nativeGeometryDescription;
  const names = [binding.materialRole, binding.name, binding.manifestSource?.source?.meshName,
    binding.manifestSource?.source?.objectName, part?.name, part?.meshName, part?.renderer?.name,
    ...(geometry?.parts ?? []).flatMap((item) => [item.meshName, item.nodeName])];
  return names.some(isPlant);
}

function sourcePath(url) {
  const logical = new URL(url, 'http://editor.local');
  if (logical.origin !== 'http://editor.local' || !logical.pathname.startsWith('/data/')) throw new Error(`非本地编辑器资源 ${url}`);
  const file = path.resolve(dataRoot, decodeURIComponent(logical.pathname.slice(6)));
  if (!file.startsWith(dataRoot)) throw new Error(`编辑器资源路径越界 ${url}`);
  return file;
}

async function getBuffer(url, range) {
  const file = sourcePath(url);
  if (!range) {
    const bytes = await readFile(file);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const handle = await open(file, 'r');
  try {
    const size = range.end - range.start + 1;
    const bytes = new Uint8Array(size);
    const {bytesRead} = await handle.read(bytes, 0, size, range.start);
    if (bytesRead !== size) throw new Error(`编辑器实例分块读取不完整 ${url}`);
    return bytes.buffer;
  } finally {
    await handle.close();
  }
}

function rangesFor(geometry, material) {
  if (Array.isArray(material)) return geometry.groups.filter(({materialIndex}) => material[materialIndex]?.visible !== false);
  if (material.visible === false) return [];
  const limit = geometry.index?.count ?? geometry.attributes.position.count;
  const start = geometry.drawRange.start;
  return [{start, count: Math.min(limit - start, geometry.drawRange.count)}];
}

function sampleVertices(positions, indices, ranges, limit) {
  const count = ranges.reduce((sum, range) => sum + range.count, 0);
  const stride = Math.max(1, Math.ceil(count / limit));
  const seen = new Set();
  const selected = [];
  for (const {start, count: length} of ranges) {
    for (let i = start; i < start + length; i += stride) {
      const index = indices ? indices[i] : i;
      if (seen.has(index)) continue;
      seen.add(index);
      const offset = index * 3;
      selected.push(positions[offset], positions[offset + 1], positions[offset + 2]);
    }
  }
  return selected;
}

// Sample the original mesh on the lattice best aligned with each face. XZ covers
// roofs, XY and ZY cover walls and cliffs. Adjacent triangles share the same lattice.
function sampleModelSurfaces(positions, indices, ranges, matrix, regions, put) {
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const ab = new Vector3(), ac = new Vector3(), normal = new Vector3();
  for (const {start, count} of ranges) {
    for (let i = start; i + 2 < start + count; i += 3) {
      a.fromBufferAttribute(positions, indices ? indices[i] : i).applyMatrix4(matrix);
      b.fromBufferAttribute(positions, indices ? indices[i + 1] : i + 1).applyMatrix4(matrix);
      c.fromBufferAttribute(positions, indices ? indices[i + 2] : i + 2).applyMatrix4(matrix);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      normal.crossVectors(ab, ac);
      const nx = Math.abs(normal.x), ny = Math.abs(normal.y), nz = Math.abs(normal.z);
      if (Math.max(nx, ny, nz) < .01) continue;
      const uAxis = nx >= Math.max(ny, nz) ? 'z' : 'x';
      const vAxis = ny > nx && ny >= nz ? 'z' : 'y';
      const u0 = Math.min(a[uAxis], b[uAxis], c[uAxis]);
      const u1 = Math.max(a[uAxis], b[uAxis], c[uAxis]);
      const v0 = Math.min(a[vAxis], b[vAxis], c[vAxis]);
      const v1 = Math.max(a[vAxis], b[vAxis], c[vAxis]);
      const abU = ab[uAxis], acU = ac[uAxis];
      const abV = ab[vAxis], acV = ac[vAxis];
      const determinant = abU * acV - acU * abV;
      const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
      const z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
      for (const region of regions) {
        const {minX, maxX, minZ, maxZ} = region.bounds;
        if (x1 < minX || x0 > maxX || z1 < minZ || z0 > maxZ) continue;
        const spacing = region.spacing;
        if (u1 - u0 < spacing * .2 || v1 - v0 < spacing * .2) continue;
        const lower = Math.max(u0, uAxis === 'x' ? minX : minZ);
        const upper = Math.min(u1, uAxis === 'x' ? maxX : maxZ);
        const vStart = Math.max(v0, vAxis === 'y' ? region.sideElevation[0] : minZ);
        const vEnd = Math.min(v1, vAxis === 'y' ? region.sideElevation[1] : maxZ);
        for (let row = Math.ceil(vStart / spacing); row * spacing <= vEnd; row++) {
          const v = row * spacing;
          for (let col = Math.ceil(lower / spacing); col * spacing <= upper; col++) {
            const u = col * spacing;
            const beta = ((u - a[uAxis]) * acV - (v - a[vAxis]) * acU) / determinant;
            const gamma = (abU * (v - a[vAxis]) - abV * (u - a[uAxis])) / determinant;
            if (beta < -1e-5 || gamma < -1e-5 || beta + gamma > 1.00001) continue;
            const x = a.x + beta * ab.x + gamma * ac.x;
            const y = a.y + beta * ab.y + gamma * ac.y;
            const z = a.z + beta * ab.z + gamma * ac.z;
            if (y < region.sideElevation[0] || y > region.sideElevation[1]) continue;
            put(x, y, z, region);
          }
        }
      }
    }
  }
}

export async function sampleEditorModels(regions, {
  contains, surfaceHeight, part = 0, parts = 1, sides = false, nativeClientSha256, exposedModel,
}) {
  const native = Boolean(nativeClientSha256);
  const registryUrl = native ? '/data/native_world_prototypes/registry.json' : '/data/datasets/registry.json';
  const registryBytes = await readFile(sourcePath(registryUrl));
  const registry = JSON.parse(registryBytes);
  const datasets = registry.datasets.filter((dataset) => {
    if (native) return dataset.layerKind === 'streamgen_native_prototypes' && dataset.compactRole === 'lod0';
    if (exposedModel) return dataset.id === exposedModel.datasetId;
    return dataset.defaultVisible && !interiorDatasets.has(dataset.id)
    && !isPlant(dataset.id) && dataset.budgetCategory !== 'vegetation'
    && (sides
      ? structuralKinds.has(dataset.layerKind) || /(?:sgm|expanded)-building$/.test(dataset.id)
      : surfaceKinds.has(dataset.layerKind) || dataset.layerKind === 'typed_water_surface' || dataset.layerKind === 'typed_water_sea');
  });
  let manifestSha256;
  if (native) {
    if (datasets.length !== 1) throw new Error('原生世界 LOD0 数据集无效');
    const manifest = await readFile(sourcePath(datasets[0].manifestUrl));
    if (JSON.parse(manifest).sources?.client?.executableSha256 !== nativeClientSha256) {
      throw new Error('原生世界 LOD0 与音乐地图的客户端指纹不一致');
    }
    manifestSha256 = createHash('sha256').update(manifest).digest('hex');
  }
  const selectedRegistry = JSON.stringify({...registry, datasets});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url) === registryUrl
    ? new Response(selectedRegistry) : new Response(await readFile(sourcePath(url)));

  const bins = new Map();
  for (const region of regions) {
    region.model = new Map();
    const {minX, maxX, minZ, maxZ} = region.bounds;
    const span = Math.max(maxX - minX, maxZ - minZ);
    region.spacing = exposedModel?.spacing ?? (sides ? Math.max(1.3, span / 170) : Math.max(1, span / 84));
    if (sides) continue;
    for (let x = Math.floor(minX / binSize); x <= Math.floor(maxX / binSize); x++) {
      for (let z = Math.floor(minZ / binSize); z <= Math.floor(maxZ / binSize); z++) {
        const key = `${x}/${z}`;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push(region);
      }
    }
  }

  let points = 0;
  function keep(x, y, z, regionHint) {
    const candidates = regionHint ? [regionHint] : bins.get(`${Math.floor(x / binSize)}/${Math.floor(z / binSize)}`);
    if (!candidates || ![x, y, z].every(Number.isFinite)) return;
    let checkedHeight = false;
    for (const region of candidates) {
      const {minX, maxX, minZ, maxZ} = region.bounds;
      // modelRings lets a zone sample a structure that physically spans a
      // sibling music-zone hole (the Dunan'na silo shaft) without changing
      // the published ground geometry of any zone.
      if (x < minX || x > maxX || z < minZ || z > maxZ || !contains(region.modelRings ?? region.rings, x, z)) continue;
      const spacing = region.spacing;
      const key = `${Math.floor(x / spacing)}/${Math.floor(y / spacing)}/${Math.floor(z / spacing)}`;
      if (region.model.has(key)) continue;
      if (!exposedModel && !checkedHeight) {
        const ground = surfaceHeight(x, z);
        if (ground !== null && y < ground - (sides ? 1.5 : 9)) return;
        checkedHeight = true;
      }
      region.model.set(key, [x, y, z]);
      points++;
    }
  }

  function intersectingRegions(asset) {
    if (!asset.bounds) return regions;
    const {min, max} = asset.bounds;
    return regions.filter(({bounds}) => min[0] <= bounds.maxX && max[0] >= bounds.minX
      && min[2] <= bounds.maxZ && max[2] >= bounds.minZ);
  }

  const prototypeCache = new PrototypeCache({maxEntries: 1100, maxBytes: 512 * 1024 * 1024});
  const material = new MeshBasicMaterial({side: DoubleSide});
  const hiddenMaterial = new MeshBasicMaterial({visible: false, side: DoubleSide});
  const getJson = async (url) => readExactJson(new Response(await readFile(sourcePath(url))));
  const config = {prototypeCache, getJson, materialForRole: (role, binding) => plantBinding(binding) ? hiddenMaterial : material};
  const compact = new CompactInstanceLoader(config);
  const production = new ProductionCompactLoader(config);
  const geometrySamples = new WeakMap();
  const matrix = new Matrix4();
  const position = new Vector3();
  function sampleObject(object, candidates) {
    object.updateMatrixWorld(true);
    object.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.visible || mesh.material === hiddenMaterial) return;
      const geometry = mesh.geometry;
      if ((!sides || native || exposedModel) && !geometrySamples.has(geometry)) {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
        const limit = Math.round(Math.min(460, Math.max(22, span * 2.4)));
        geometrySamples.set(geometry, sampleVertices(geometry.attributes.position.array, geometry.index?.array,
          rangesFor(geometry, mesh.material), limit));
      }
      const source = geometrySamples.get(geometry);
      const count = mesh.isInstancedMesh ? mesh.count : 1;
      for (let instance = 0; instance < count; instance++) {
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(instance, matrix);
          matrix.premultiply(mesh.matrixWorld);
        } else matrix.copy(mesh.matrixWorld);
        if (sides) {
          sampleModelSurfaces(geometry.attributes.position, geometry.index?.array,
            rangesFor(geometry, mesh.material), matrix, candidates, keep);
        }
        for (let i = 0; i < (source?.length ?? 0); i += 3) {
          position.fromArray(source, i).applyMatrix4(matrix);
          if (sides) {
            for (const region of candidates) keep(position.x, position.y, position.z, region);
          } else keep(position.x, position.y, position.z);
        }
      }
    });
  }

  const usedDatasets = new Set();
  let assetsSampled = 0;
  const failures = [];
  try {
    const catalog = await loadDatasetCatalog(registryUrl);
    failures.push(...catalog.errors.map(({datasetId, message}) => `${datasetId}: ${message}`));
    const allAssets = catalog.assets.filter((asset) => intersectingRegions(asset).length
      && (!exposedModel || exposedModel.assetName.test(asset.id))
      && ![asset.id, asset.name, asset.source?.name, asset.source?.meshName].some(isPlant))
      .sort((a, b) => a.datasetId.localeCompare(b.datasetId) || a.id.localeCompare(b.id));
    const assets = allAssets.filter((_, index) => index % parts === part);
    const planSha256 = createHash('sha256').update(JSON.stringify(allAssets.map(({datasetId, id, contentVersion}) =>
      [datasetId, id, contentVersion ?? null]))).digest('hex');
    console.log(`第 ${part + 1}/${parts} 批：${assets.length}/${allAssets.length} 个模型分块，${datasets.length} 个来源`);
    for (const asset of assets) {
      if (!surfaceKinds.has(asset.kind) && !(native && asset.kind === 'streamgen_native_prototypes')) continue;
      const candidates = sides ? intersectingRegions(asset) : null;
      try {
        if (asset.format === COMPACT_FORMAT || asset.format === PRODUCTION_COMPACT_FORMAT) {
          const loader = asset.format === COMPACT_FORMAT ? compact : production;
          const object = await loader.createObject(asset, getBuffer);
          try { sampleObject(object, candidates); } finally { object.userData.disposeResources?.(); }
        } else {
          const resolved = await resolveDatasetAsset(asset);
          const [positions, indices] = await Promise.all([getBuffer(resolved.positionsUrl), getBuffer(resolved.indicesUrl)]);
          const vertices = new Float32Array(positions);
          const order = new Uint32Array(indices);
          const ranges = [{start: 0, count: order.length}];
          if (sides) {
            sampleModelSurfaces(new BufferAttribute(vertices, 3), order, ranges, matrix.identity(), candidates, keep);
          }
          if (!sides || exposedModel) {
            const sampled = sampleVertices(vertices, order, ranges, 11000);
            for (let i = 0; i < sampled.length; i += 3) {
              if (sides) {
                for (const region of candidates) keep(sampled[i], sampled[i + 1], sampled[i + 2], region);
              } else keep(sampled[i], sampled[i + 1], sampled[i + 2]);
            }
          }
        }
        usedDatasets.add(asset.datasetId);
        assetsSampled++;
      } catch (error) {
        failures.push(`${asset.datasetId}/${asset.id}: ${error.message}`);
      }
      if ((assetsSampled + failures.length) % 500 === 0) console.log(`已读取 ${assetsSampled} 个模型分块`);
    }

    // A thin region may cross an authored triangle with no model vertex in it.
    // Resolve those fragments against the original triangles, including real water surfaces.
    const gaps = sides ? [] : regions.filter((region) => !region.model.size && !region.ground.length);
    const targets = gaps.flatMap((region) => {
      const {minX, maxX, minZ, maxZ} = region.bounds;
      const samples = [];
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
        const x = minX + (maxX - minX) * (i + .5) / 12;
        const z = minZ + (maxZ - minZ) * (j + .5) / 12;
        if (contains(region.rings, x, z)) samples.push({x, z, height: -Infinity, region, source: null});
      }
      return samples;
    });
    console.log(`三角面补验 ${gaps.length} 个缺口分区`);
    const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
    function searchTriangles(object, samples, datasetId) {
      object.updateMatrixWorld(true);
      for (const target of samples) {
        ray.ray.origin.set(target.x, 18000, target.z);
        const hit = ray.intersectObject(object, true).find((entry) => {
          const faceMaterial = Array.isArray(entry.object.material) ? entry.object.material[entry.face?.materialIndex] : entry.object.material;
          return faceMaterial?.visible !== false;
        });
        if (hit && hit.point.y > target.height) {
          const ground = surfaceHeight(target.x, target.z);
          if (ground !== null && hit.point.y < ground - 9) continue;
          target.height = hit.point.y;
          target.source = datasetId;
        }
      }
    }
    for (const asset of assets) {
      if (!targets.length) break;
      const {min, max} = asset.bounds ?? {};
      if (!min || !max) continue;
      const samples = targets.filter(({x, z}) => min[0] <= x && x <= max[0] && min[2] <= z && z <= max[2]);
      if (!samples.length) continue;
      try {
        if (asset.format === COMPACT_FORMAT || asset.format === PRODUCTION_COMPACT_FORMAT) {
          const loader = asset.format === COMPACT_FORMAT ? compact : production;
          const object = await loader.createObject(asset, getBuffer);
          try { searchTriangles(object, samples, asset.datasetId); } finally { object.userData.disposeResources?.(); }
        } else {
          const resolved = await resolveDatasetAsset(asset);
          const [vertices, indices] = await Promise.all([getBuffer(resolved.positionsUrl), getBuffer(resolved.indicesUrl)]);
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
          geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
          try { searchTriangles(new Mesh(geometry, material), samples, asset.datasetId); } finally { geometry.dispose(); }
        }
      } catch (error) {
        failures.push(`三角面 ${asset.datasetId}/${asset.id}: ${error.message}`);
      }
    }
    for (const [index, target] of targets.entries()) {
      if (!target.source) continue;
      target.region.model.set(`surface/${index}`, [target.x, target.height, target.z]);
      usedDatasets.add(target.source);
      points++;
    }
    if (failures.length) console.warn(`点阵有 ${failures.length} 个未读取的模型：${failures.slice(0, 4).join(' / ')}`);
    return {registrySha256: createHash('sha256').update(registryBytes).digest('hex'), manifestSha256,
      planSha256, part, parts, assigned: assets.length, total: allAssets.length,
      datasets: [...usedDatasets].sort(), assets: assetsSampled, points, skipped: failures.length};
  } finally {
    globalThis.fetch = originalFetch;
    material.dispose();
    hiddenMaterial.dispose();
  }
}

function fragmentSamples(rings) {
  const coordinates = rings.flat();
  const ranges = [0, 1].map((axis) => {
    const values = coordinates.map((point) => point[axis]);
    return [Math.min(...values), Math.max(...values)];
  });
  const axis = ranges[0][1] - ranges[0][0] >= ranges[1][1] - ranges[1][0] ? 0 : 1;
  const cross = 1 - axis;
  const [min, max] = ranges[axis];
  const samples = [];
  // Use interior midpoints of scanline intersections so millimeter-wide projection fragments get samples.
  for (let i = 0; i < 108; i++) {
    const at = min + (max - min) * (i + .5) / 108;
    const crossings = [];
    for (const ring of rings) {
      let from = ring.at(-1);
      for (const to of ring) {
        if ((from[axis] > at) !== (to[axis] > at)) {
          const fraction = (at - from[axis]) / (to[axis] - from[axis]);
          crossings.push(from[cross] + fraction * (to[cross] - from[cross]));
        }
        from = to;
      }
    }
    crossings.sort((a, b) => a - b);
    for (let j = 1; j < crossings.length; j += 2) {
      if (crossings[j] <= crossings[j - 1]) continue;
      const middle = (crossings[j] + crossings[j - 1]) / 2;
      const [x, z] = (axis ? [middle, at] : [at, middle]).map(Math.fround);
      if (containsWorldPoint(rings, x, z)) samples.push({x, z, y: -Infinity});
    }
  }
  return samples;
}

export async function sampleOriginalTerrainGaps(regions, executableSha256) {
  const points = new Map();
  const sources = new Set();
  if (!regions.length) return {points, sources};
  const targets = regions.map(({id, rings}) => ({id: String(id), samples: fragmentSamples(rings)}));
  const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
  const material = new MeshBasicMaterial({side: DoubleSide});
  const catalogs = [
    ['full_terrain_lod0_v1', 'genshin-full-typed-terrain-lod0/v1', 'tiles'],
    ['full_terrain_mesh_colliders_v2', 'genshin-full-typed-terrain-meshcolliders/v1', 'tiles'],
    ['full_bigworld_collision', 'genshin-current-bigworld-collider-roots/v1', 'assets'],
  ];
  try {
    for (const [directory, schema, collection] of catalogs) {
      const pending = targets.filter(({id}) => !points.has(id));
      if (!pending.length) break;
      const manifest = await readExactJson(new Response(await readFile(sourcePath(`/data/${directory}/manifest.json`))));
      if (manifest.schema !== schema) throw new Error(`地形补片契约不符 ${directory}`);
      const samples = pending.flatMap(({samples}) => samples);
      for (const asset of manifest[collection]) {
        if (!asset.bounds || [asset.id, asset.Name, asset.sourceName].some(isPlant)) continue;
        const {min, max} = asset.bounds;
        const inside = samples.filter(({x, z, y}) => x >= min[0] && x <= max[0] && z >= min[2] && z <= max[2] && y < max[1]);
        if (!inside.length) continue;
        const [vertices, indices] = await Promise.all([asset.positions, asset.indices].map((file) => getBuffer(`/data/${directory}/${file}`)));
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
        geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
        const mesh = new Mesh(geometry, material);
        try {
          for (const sample of inside) {
            ray.ray.origin.set(sample.x, max[1] + 1, sample.z);
            const hit = ray.intersectObject(mesh, false)[0];
            if (hit && hit.point.y > sample.y) sample.y = hit.point.y;
          }
        } finally {
          geometry.dispose();
        }
      }
      for (const {id, samples} of pending) {
        const visible = samples.filter(({y}) => Number.isFinite(y)).map(({x, y, z}) => [x, y, z]);
        if (visible.length) {
          points.set(id, visible);
          sources.add(directory);
        }
      }
    }
  } finally {
    material.dispose();
  }
  const residual = targets.filter(({id}) => !points.has(id));
  if (residual.length) {
    const ground = await readSurfaceTerrain(executableSha256);
    const masks = new Map();
    for (const {id, samples} of residual) {
      const visible = [];
      for (const {x, z} of samples) {
        const tile = ground.tiles.find((row) => x >= row.x0 && x < row.x1 && z >= row.z0 && z < row.z1);
        if (!tile) continue;
        const u = (x - tile.x0) / 2, v = (z - tile.z0) / 2;
        const col = Math.floor(u), row = Math.floor(v);
        const width = tile.heightResolution;
        if (!masks.has(tile)) masks.set(tile, ground.holes(tile));
        if ((await masks.get(tile))[row * (width - 1) + col] === 255) continue;
        const elevation = await ground.samples(tile);
        const corner = (i, j) => decodeTerrainHeight(elevation.readUInt16LE(2 * (j * width + i))) + tile.yOffset;
        const heights = [corner(col, row), corner(col + 1, row), corner(col, row + 1), corner(col + 1, row + 1)];
        const y = sampleTerrainReliefHeight(heights, 2, 2, u - col, v - row);
        visible.push([x, y, z]);
      }
      if (visible.length) {
        points.set(id, visible);
        sources.add('native-terrain-triangles');
      }
    }
  }
  return {points, sources};
}
