import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {
  compareSourceOrder, components, covers, difference, emptyPolygon, filledRings, intersection,
  pointAt, pointsFromLine, polygonFromRings, polygonRings, roundPositions, symmetricDifference, union,
} from './bgm-geometry.mjs';

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
  const ground = new Set();
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
          pointId, layerId, position: xyz, areaId: area.id, state: area.state,
        });
      }
      if (!child) continue;
      if (layerId) {
        if (!floorAssignments.has(child.id)) floorAssignments.set(child.id, new Set());
        floorAssignments.get(child.id).add(layerId);
      } else if (verified) ground.add(child.id);
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

function projectSurface(volumes, excluded) {
  const visible = [];
  let occupiedParents = emptyPolygon();
  for (const zones of group(volumes, (zone) => zone.areaId1).values()) {
    const parent = zones.find((zone) => !zone.areaId2);
    const parentShape = parent && difference(parent.shape, occupiedParents);
    let occupiedChildren = emptyPolygon();
    for (const zone of zones) {
      if (Object.hasOwn(excluded, zone.id)) continue;
      let shape = difference(zone.shape, occupiedParents);
      if (parentShape) shape = intersection(shape, parentShape);
      shape = difference(shape, occupiedChildren);
      if (shape.getArea() < 0.02) continue;
      visible.push({zone, shape});
      occupiedChildren = union([occupiedChildren, shape]);
    }
    if (parent) occupiedParents = union([occupiedParents, parent.shape]);
  }
  const result = [];
  for (const [state, parcels] of group(visible, ({zone}) => zone.state)) {
    for (const patch of components(union(parcels.map(({shape}) => shape)), 'Polygon')) {
      const owners = parcels.map(({zone, shape}) => ({
        zone, overlap: intersection(shape, patch).getArea(),
      })).filter(({overlap}) => overlap >= 0.02);
      if (!owners.length) continue;
      const largest = owners.reduce((a, b) => b.overlap > a.overlap ? b : a).zone;
      const suffix = new Set(owners.map(({zone}) => zone.name)).size > 1 ? '等' : '';
      const rings = polygonRings(patch).map((ring) =>
        roundPositions(pointsFromLine(ring, {omitClosing: true})));
      const [x, z] = rings[0][0];
      result.push({
        id: `${largest.id}:${x.toFixed(5)}:${z.toFixed(5)}`,
        name: largest.name + suffix, state, rings, areaIds: owners.map(({zone}) => zone.id),
      });
    }
  }
  return result;
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
const verifiedLayers = group(Object.values(floorAnchors).flat(), (anchor) => anchor.areaId);
const excluded = {};
const floorVolumeBindings = {};
for (const [sceneId, zones] of volumes) {
  for (const {areaId2, id, yRange, shape} of zones) {
    if (!areaId2 || !yRange) continue;
    const verified = (verifiedLayers.get(id) ?? []).map(({layerId}) => layerId);
    const exact = (shapes.get(sceneId) ?? []).filter((layer) =>
      layer.bounds[0] <= yRange[0] && yRange[1] <= layer.bounds[1] && covers(layer.shape, shape),
    ).map(({layerId}) => layerId);
    const assigned = new Set([...verified, ...exact]);
    if (floorVolumes.has(id)) {
      for (const layer of floorAssignments.get(id) ?? []) assigned.add(layer);
    }
    if (!assigned.size) continue;
    const ids = [...assigned].sort((a, b) => a - b);
    floorVolumeBindings[id] = ids;
    if (!ground.has(id)) excluded[id] = ids;
  }
}
const scenes = Object.fromEntries([...volumes].map(([sceneId, rows]) => [
  sceneId, retainZoneIds(sceneId === 3 ? bgm.zones : bgm.scenes?.[sceneId], projectSurface(rows, excluded)),
]));
const {3: zones, ...otherScenes} = scenes;
Object.assign(bgm, {
  zones, scenes: otherScenes, surfaceLayerExclusions: excluded, floorVolumeBindings, floorAnchors,
});
await writeFile(args.out, `${JSON.stringify(bgm)}\n`);
console.log(`主世界 ${zones.length} 块音区，楼层独立音区 ${Object.keys(excluded).length} 个`);
