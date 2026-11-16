import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {
  compareSourceOrder, components, covers, difference, emptyPolygon, filledRings, intersection, intersects,
  lineFromPoints, pointAt, pointsFromLine, polygonFromRings, polygonRings, polygonsOnly, roundPositions,
  symmetricDifference, union, volumeKey,
} from './bgm-geometry.mjs';
import {readSurfaceTerrain} from './bgm-surface-terrain.mjs';

const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

function vector(value) {
  if (!isRecord(value)) return null;
  const axes = ['x', 'y', 'z'].map((axis) => value[`_${axis}`] ?? value[axis]);
  return axes.every(Number.isFinite) ? axes : null;
}

function group(records, identify) {
  const byKey = new Map();
  for (const record of records) {
    const key = identify(record);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(record);
  }
  return byKey;
}

function* pointRows(contents) {
  for (const [key, row] of Object.entries(contents)) {
    if (!isRecord(row)) continue;
    if (/^\d+$/.test(key)) yield [Number(key), row];
    else yield* pointRows(row);
  }
}

const positionMatches = (xyz, expected) => xyz.every((value, axis) =>
  Math.abs(value - expected[axis]) < 0.005);

function highestUnique(scores, column) {
  const values = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!values.length || values[0][1] === values[1]?.[1]) {
    throw new Error(`ScenePoint 无法唯一识别 ${column}`);
  }
  return values[0][0];
}

function pointColumns(rows, waypoints, layerIds) {
  const positions = new Map();
  const layerValues = new Map();
  for (const [pointId, row] of rows) {
    const expected = waypoints.get(pointId);
    for (const [key, value] of Object.entries(row)) {
      const position = expected && vector(value);
      if (position && positionMatches(position, expected)) {
        positions.set(key, (positions.get(key) ?? 0) + 1);
      }
      if (Number.isInteger(value) && layerIds.has(value)) {
        if (!layerValues.has(key)) layerValues.set(key, new Set());
        layerValues.get(key).add(value);
      }
    }
  }
  return {
    position: highestUnique(positions, '坐标字段'),
    floor: highestUnique(new Map([...layerValues].map(([key, assigned]) =>
      [key, assigned.size])), '楼层字段'),
  };
}

async function locatePoints(directory, guide, volumes, layers, layerFloor) {
  if (!Array.isArray(guide?.data)) throw new Error('传送点清单缺少场景数据');
  const guides = new Map(guide.data.map(({sceneId, points}) => [sceneId, new Map(points
    .filter(({type}) => ['Goddess', 'TeleportWaypoint'].includes(type))
    .map(({id, position}) => [id, position]))]));
  const layerIds = new Map([...group(layers, (layer) => layer.sceneId)]
    .map(([id, rows]) => [id, new Set(rows.map(({layerId}) => layerId))]));
  const ground = new Map();
  const floorAssignments = new Map();
  const floorAnchors = {};
  for (const file of (await readdir(directory)).sort()) {
    const match = /^scene(\d+)_point\.json$/.exec(file);
    if (!match) continue;
    const scene = Number(match[1]);
    const waypoints = guides.get(scene);
    const ids = layerIds.get(scene);
    if (!waypoints?.size || !ids?.size) continue;
    const rows = [...pointRows(await read(path.join(directory, file)))];
    const {position, floor} = pointColumns(rows, waypoints, ids);
    const zones = volumes.get(scene) ?? [];
    const parents = zones.filter((zone) => !zone.areaId2);
    const children = group(zones.filter((zone) => zone.areaId2), (zone) => zone.areaId1);
    for (const [pointId, row] of rows) {
      const xyz = vector(row[position]);
      const layerId = row[floor];
      if (!xyz || (layerId !== 0 && !ids.has(layerId))) continue;
      const [x, height, z] = xyz;
      const point = pointAt(x, z);
      const parent = parents.find(({shape}) => covers(shape, point));
      if (!parent) continue;
      const child = children.get(parent.areaId1)?.find(({yRange, shape}) =>
        (!yRange || height >= yRange[0] && height <= yRange[1]) && covers(shape, point));
      const expected = waypoints.get(pointId);
      const verified = expected && positionMatches(xyz, expected);
      const floorKey = layerFloor[layerId];
      if (floorKey && layerId && verified) {
        const area = child ?? parent;
        (floorAnchors[floorKey] ??= []).push({
          pointId, layerId, position: xyz, areaId: area.id, state: area.state, volume: volumeKey(area),
        });
      }
      if (!child) continue;
      const key = volumeKey(child);
      if (layerId) {
        if (!floorAssignments.has(key)) floorAssignments.set(key, new Set());
        floorAssignments.get(key).add(layerId);
      } else if (verified) {
        if (!ground.has(key)) ground.set(key, []);
        ground.get(key).push(point);
      }
    }
  }
  return {ground, floorAssignments, floorAnchors};
}

async function layerPolygons(directory, layers) {
  const shapes = [];
  for (const [groupId, members] of group(layers, (layer) => layer.groupId)) {
    const ids = new Map(members.map(({layerId, sceneId}) => [layerId, sceneId]));
    const config = await read(path.join(directory, `${groupId}.json`)).catch((error) => {
      if (error.code === 'ENOENT') return {};
      throw error;
    });
    for (const table of Object.values(config).filter(Array.isArray)) {
      for (const row of table.filter(isRecord)) {
        const values = Object.values(row);
        const keys = values.filter((id) => Number.isInteger(id) && ids.has(id));
        if (keys.length !== 1) continue;
        const [layerId] = keys;
        for (const record of values.filter(Array.isArray).flat().filter(isRecord)) {
          const fields = Object.values(record);
          if (!fields.includes('POLYGON_AREA_TYPE_INSIDE')) continue;
          const rings = fields.filter((value) => Array.isArray(value) && value.length >= 3)
            .map((ring) => ring.map(vector)).filter((ring) => ring.every(Boolean));
          const bounds = fields.map(vector).filter(Boolean).map((position) => position[1]);
          if (rings.length !== 1 || bounds.length !== 2) continue;
          shapes.push({
            sceneId: ids.get(layerId), layerId, bounds: bounds.sort((a, b) => a - b),
            shape: polygonFromRings([rings[0].map(([x, , z]) => [x, z])]),
          });
        }
      }
    }
  }
  return group(shapes, ({sceneId}) => sceneId);
}

async function findUndergroundVolumes(volumes, terrain, ground) {
  const result = new Set();
  for (const volume of volumes) {
    if (!volume.areaId2 || !volume.yRange || ground.has(volumeKey(volume))) continue;
    const range = await terrain.heightRange(volume.shape);
    if (range && range[0] > volume.yRange[1]) result.add(volume);
  }
  return result;
}

async function projectSurface(volumes, excluded, underground, terrain, ground) {
  const visible = [];
  const conflicts = [];
  const uncertainAreas = [];
  let occupiedParents = emptyPolygon();
  for (const zones of group(volumes, (zone) => zone.areaId1).values()) {
    const parent = zones.find((zone) => !zone.areaId2);
    const parentShape = parent && difference(parent.shape, occupiedParents);
    const candidates = [];
    for (const zone of zones) {
      if (excluded.has(volumeKey(zone)) || underground.has(zone)) continue;
      let shape = difference(zone.shape, occupiedParents);
      if (parentShape) shape = intersection(shape, parentShape);
      if (shape.getArea() >= 0.02) candidates.push({zone, shape});
    }
    const uncertain = [];
    for (const [index, a] of candidates.entries()) {
      if (!a.zone.yRange) continue;
      for (const b of candidates.slice(index + 1)) {
        if (!b.zone.yRange || a.zone.state === b.zone.state) continue;
        const [lo, hi] = a.zone.yRange;
        const [otherLo, otherHi] = b.zone.yRange;
        // Where the earlier volume covers the later one's whole height band,
        // the original order always decides between those two.
        if ((lo <= otherLo && otherHi <= hi) || !intersects(a.shape, b.shape)) continue;
        const overlap = polygonsOnly(intersection(a.shape, b.shape));
        if (overlap.getArea() < 0.02) continue;
        const heights = await terrain?.heightRange(overlap);
        if (heights && lo <= heights[0] && heights[1] <= hi
          && (ground.get(volumeKey(b.zone)) ?? []).every((point) => !covers(overlap, point))) continue;
        const provenOutside = heights ? [a, b].filter(({zone}) => {
          const anchors = ground.get(volumeKey(zone)) ?? [];
          const [lower, upper] = zone.yRange;
          return (heights[0] > upper || heights[1] < lower)
            && anchors.every((point) => !covers(overlap, point));
        }) : [];
        if (provenOutside.length) {
          for (const candidate of provenOutside) candidate.shape = difference(candidate.shape, overlap);
        } else {
          uncertain.push(overlap);
          conflicts.push({areas: [a.zone.id, b.zone.id], squareMetres: Number(overlap.getArea().toFixed(2))});
        }
      }
    }
    // A child may override its parent at one of the unresolved heights.
    let occupied = union(uncertain);
    if (uncertain.length) uncertainAreas.push(occupied);
    for (const {zone, shape} of candidates) {
      const clear = difference(shape, occupied);
      if (clear.getArea() < 0.02) continue;
      visible.push({zone, shape: clear});
      occupied = union([occupied, clear]);
    }
    if (parent) occupiedParents = union([occupiedParents, parent.shape]);
  }
  const result = [];
  const noBoundary = union(uncertainAreas);
  for (const [state, parcels] of group(visible, ({zone}) => zone.state)) {
    for (const patch of components(union(parcels.map(({shape}) => shape)), 'Polygon')) {
      const owners = parcels.map(({zone, shape}) => ({
        zone, overlap: intersection(shape, patch).getArea(),
      })).filter(({overlap}) => overlap >= 0.02);
      if (!owners.length) continue;
      const largest = owners.reduce((a, b) => b.overlap > a.overlap ? b : a).zone;
      const suffix = new Set(owners.map(({zone}) => zone.name)).size > 1 ? '等' : '';
      const rings = polygonRings(patch).map((ring) =>
        roundPositions(pointsFromLine(ring, {omitClosing: true}))).filter((ring, index) => {
        if (index === 0) return true;
        // Overlay can leave a long, effectively zero-width hole along a shared
        // seam. Five-decimal coordinate rounding can move either side by one unit.
        const perimeter = ring.reduce((length, [x, z], i) => {
          const [px, pz] = ring[(i + 1) % ring.length];
          return length + Math.hypot(x - px, z - pz);
        }, 0);
        return polygonFromRings([ring]).getArea() > perimeter * 1e-5;
      });
      const [x, z] = rings[0][0];
      const zone = {
        id: `${largest.id}:${x.toFixed(5)}:${z.toFixed(5)}`,
        name: largest.name + suffix, state, rings, areaIds: owners.map(({zone}) => zone.id),
      };
      if (intersects(patch, noBoundary)) {
        // A missing height decision creates a hole in the hit area. Its edge
        // is not an authored music boundary.
        zone.lines = polygonRings(patch).flatMap((ring) => components(
          difference(lineFromPoints(pointsFromLine(ring)), noBoundary), 'LineString',
        ))
          .map((line) => roundPositions(pointsFromLine(line)));
      }
      result.push(zone);
    }
  }
  return {zones: result, conflicts};
}

function retainZoneIds(previous, current) {
  const bySources = (zone) => JSON.stringify([zone.state, zone.name, zone.areaIds.toSorted((a, b) => a - b)]);
  const lookup = group(previous ?? [], bySources);
  const taken = new Set(current.map(({id}) => id));
  for (const zone of current) {
    const matches = (lookup.get(bySources(zone)) ?? []).filter(({id}) => !taken.has(id));
    if (matches.length === 0) continue;
    const freshShape = filledRings(zone.rings);
    const equivalent = matches.filter((old) =>
      symmetricDifference(filledRings(old.rings), freshShape).getArea() < 0.02);
    if (equivalent.length !== 1) continue;
    taken.delete(zone.id);
    zone.id = equivalent[0].id;
    taken.add(zone.id);
  }
  return current;
}

const {values: args} = parseArgs({options: Object.fromEntries(
  ['bgm', 'layers', 'points', 'regions', 'waypoints', 'out'].map((key) => [key, {type: 'string'}]),
)});
for (const key of ['bgm', 'layers', 'points', 'regions', 'waypoints', 'out']) {
  if (!args[key]) throw new Error(`需要 --${key}`);
}
const [bgm, catalog, guide, pointRelease, regionRelease] = await Promise.all([
  read(args.bgm), read(args.layers), read(args.waypoints),
  read(path.resolve(args.points, '../../../.assetdigger/client-input.json')),
  read(path.resolve(args.regions, '../../.assetdigger/client-input.json')),
]);
if ([catalog.game, pointRelease, regionRelease].some(({executableSha256}) =>
  executableSha256 !== bgm.source.clientExecutableSha256)) {
  throw new Error('ScenePoint、LayerRegion 与音区的客户端指纹不一致');
}
const volumes = group(bgm.volumes.map((zone) => ({
  ...zone, shape: polygonFromRings(zone.rings),
})).sort(compareSourceOrder), (zone) => zone.sceneId);
const [{ground, floorAssignments, floorAnchors}, shapes] = await Promise.all([
  locatePoints(args.points, guide, volumes, catalog.layers, bgm.layerFloor),
  layerPolygons(args.regions, catalog.layers),
]);
const floorVolumes = new Set(Object.values(bgm.floorZones).flat().flatMap((zone) => zone.areaIds));
const verifiedLayers = group(Object.values(floorAnchors).flat(), (anchor) => anchor.volume);
const excluded = new Map();
const floorVolumeBindings = {};
const floorVolumeBindingsByVolume = {};
for (const [sceneId, zones] of volumes) {
  for (const zone of zones) {
    const {areaId2, id, yRange, shape} = zone;
    if (!areaId2 || !yRange) continue;
    const key = volumeKey(zone);
    const verified = (verifiedLayers.get(key) ?? []).map(({layerId}) => layerId);
    const exact = (shapes.get(sceneId) ?? []).filter((layer) =>
      layer.bounds[0] <= yRange[0] && yRange[1] <= layer.bounds[1] && covers(layer.shape, shape),
    ).map(({layerId}) => layerId);
    const assigned = new Set([...verified, ...exact]);
    if (floorVolumes.has(id)) {
      for (const layer of floorAssignments.get(key) ?? []) assigned.add(layer);
    }
    if (!assigned.size) continue;
    const ids = [...assigned].sort((a, b) => a - b);
    floorVolumeBindingsByVolume[key] = ids;
    floorVolumeBindings[id] = [...new Set([...(floorVolumeBindings[id] ?? []), ...ids])].sort((a, b) => a - b);
    if (!ground.has(key)) excluded.set(key, ids);
  }
}
const surfaceLayerExclusions = {};
for (const [id, instances] of group(bgm.volumes.filter(({yRange}) => yRange), ({id}) => id)) {
  if (instances.every((row) => excluded.has(volumeKey(row)))) {
    surfaceLayerExclusions[id] = [...new Set(instances.flatMap((row) => excluded.get(volumeKey(row))))].sort((a, b) => a - b);
  }
}
const terrain = await readSurfaceTerrain(bgm.source.clientExecutableSha256);
const mainWorld = volumes.get(bgm.sceneId);
if (!mainWorld) throw new Error('音区清单缺少主世界体积');
const underground = await findUndergroundVolumes(mainWorld, terrain, ground);
const scenes = {};
const surfaceViewConflicts = {};
for (const [sceneId, rows] of volumes) {
  const main = sceneId === bgm.sceneId;
  const result = await projectSurface(rows, excluded, underground, main ? terrain : null, ground);
  scenes[sceneId] = retainZoneIds(main ? bgm.zones : bgm.scenes?.[sceneId], result.zones);
  if (result.conflicts.length) surfaceViewConflicts[sceneId] = result.conflicts;
}
const zones = scenes[bgm.sceneId];
delete scenes[bgm.sceneId];
Object.assign(bgm, {
  zones, scenes, surfaceLayerExclusions, floorVolumeBindings, floorVolumeBindingsByVolume, floorAnchors,
  surfaceViewConflicts,
  surfaceUndergroundExclusions: [...underground].map(({sceneId, id}) => ({sceneId, id})),
});
bgm.verification.projection = 'Surface projections use Scene Point and LayerRegion evidence per source volume. Teyvat also checks the map editor terrain heightfield. Unresolved height-dependent overlaps have no clickable surface region.';
await writeFile(args.out, `${JSON.stringify(bgm)}\n`);
console.log(`主世界 ${zones.length} 块音区，楼层独立音区 ${excluded.size} 个`);
