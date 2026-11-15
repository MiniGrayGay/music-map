import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {
  compareSourceOrder, components, covers, difference, emptyPolygon, geometryMark, intersection, intersects,
  lineFromPoints, pointAt, pointsFromLine, polygonFromRings, polygonRings, polygonsOnly,
  rectangle, releaseGeometries, roundPositions, union,
} from './bgm-geometry.mjs';

function* alphaRuns(alpha, width, height, channels) {
  let active = new Map();
  for (let y = 0; y <= height; y += 1) {
    const current = new Map();
    for (let x = 0; y < height && x < width;) {
      const first = x;
      while (x < width && alpha[(y * width + x) * channels + channels - 1] >= 128) x += 1;
      if (first === x) {
        x += 1;
        continue;
      }
      const key = `${first}/${x}`;
      current.set(key, active.get(key) ?? {left: first, right: x, top: y});
      active.delete(key);
    }
    for (const run of active.values()) yield {...run, bottom: y};
    active = current;
  }
}

async function footprint(layer, manifest, folder) {
  if (!/^[A-Za-z]+\/UI_Map_LayeredMap_\d+\.webp$/.test(layer.image)) {
    throw new Error(`非法楼层贴片 ${layer.image}`);
  }
  const artwork = sharp(path.join(folder, layer.image));
  const {width, height, hasAlpha} = await artwork.metadata();
  if (width !== layer.width || height !== layer.height) throw new Error(`贴片尺寸不符 ${layer.layerId}`);
  const scale = manifest.projection.maps[layer.mapName].pixelScale;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`无效地图缩放 ${layer.mapName}`);
  const worldX = (layer.bottom - layer.top) / (height * scale);
  const worldZ = (layer.right - layer.left) / (width * scale);
  const project = ({left, right, top, bottom}) => rectangle(
    layer.worldTop - bottom * worldX, layer.worldTop - top * worldX,
    layer.worldLeft - right * worldZ, layer.worldLeft - left * worldZ,
  );
  if (!hasAlpha) return project({left: 0, right: width, top: 0, bottom: height});
  const {data, info} = await artwork.ensureAlpha().raw().toBuffer({resolveWithObject: true});
  return union(Array.from(alphaRuns(data, width, height, info.channels), project));
}

const keyByParent = (volume) => `${volume.sceneId}/${volume.areaId1}`;

function parentFootprints(volumes) {
  const parents = new Map();
  const occupied = new Map();
  for (const parent of volumes.filter((volume) => !volume.areaId2).sort(compareSourceOrder)) {
    const previous = occupied.get(parent.sceneId) ?? emptyPolygon();
    const shape = polygonFromRings(parent.rings);
    parents.set(keyByParent(parent), difference(shape, previous));
    occupied.set(parent.sceneId, union([previous, shape]));
  }
  return parents;
}

function invariantRegions(sceneVolumes, parents) {
  const byParent = Map.groupBy(sceneVolumes, ({areaId1}) => areaId1);
  const proven = [];
  for (const family of byParent.values()) {
    const parent = family.find(({areaId2}) => !areaId2);
    if (!parent) continue;
    const children = family.filter(({areaId2, state}) => areaId2 && state !== parent.state);
    const guaranteed = polygonsOnly(difference(parents.get(keyByParent(parent)),
      union(children.map(({rings}) => polygonFromRings(rings)))));
    if (!guaranteed.isEmpty()) proven.push({parent, shape: guaranteed});
  }
  return proven;
}

function heightIndependentFloorZones(artwork, proven, anchors) {
  const mask = union([...artwork.values()].map(({shape}) => shape));
  const possible = proven.filter(({shape}) => intersects(mask, shape));
  const verified = [];
  for (const [state, matches] of Map.groupBy(possible, ({parent}) => parent.state)) {
    const region = union(matches.map(({shape}) => shape));
    const shape = covers(region, mask) ? polygonsOnly(mask) : polygonsOnly(intersection(region, mask));
    if (shape.isEmpty() || anchors.some(({position, state: anchorState}) =>
      anchorState !== state && covers(shape, pointAt(position[0], position[2])))) continue;
    verified.push({state, shape, areas: matches.map(({parent}) => parent)});
  }
  const names = new Set([...artwork.values()].map(({name}) => name));
  return verified.map(({state, shape, areas}) => {
    return {
      id: areas[0].id,
      name: verified.length === 1 && names.size === 1 ? [...names][0] : areas[0].name,
      state,
      areaIds: areas.map(({id}) => id),
      heightIndependent: true,
      rings: polygonRings(shape)
        .map((ring) => roundPositions(pointsFromLine(ring, {omitClosing: true}))),
      lines: [],
    };
  });
}

function inheritedFloorZones(artwork, anchors, sceneVolumes, parents, occupied) {
  const areaById = new Map(sceneVolumes.map((volume) => [volume.id, volume]));
  const anchorsByArea = Map.groupBy(anchors.filter((anchor) =>
    artwork.has(anchor.layerId) && areaById.get(anchor.areaId)?.areaId2 === 0),
  ({areaId}) => areaId);
  const result = [];
  for (const [areaId, points] of anchorsByArea) {
    const parent = areaById.get(areaId);
    const layerIds = new Set(points.map(({layerId}) => layerId));
    const layers = [...layerIds].map((id) => artwork.get(id));
    const footprint = union(layers.map(({shape}) => shape));
    let shape = intersection(footprint, parents.get(keyByParent(parent)));
    // A shared state is safe only where no different child state can override the parent.
    const overrides = sceneVolumes.filter((zone) =>
      zone.areaId1 === parent.areaId1 && zone.areaId2 && zone.state !== parent.state);
    shape = difference(shape, union(overrides.map(({rings}) => polygonFromRings(rings))));
    shape = polygonsOnly(difference(shape, occupied));
    if (shape.isEmpty() || !points.some(({position}) => covers(shape, pointAt(position[0], position[2])))) {
      continue;
    }
    if (anchors.some(({position, state}) =>
      state !== parent.state && covers(shape, pointAt(position[0], position[2])))) continue;
    const names = new Set(layers.map(({name}) => name));
    result.push({
      id: parent.id,
      name: names.size === 1 ? [...names][0] : parent.name,
      state: parent.state,
      areaIds: [parent.id],
      inheritedFrom: parent.id,
      rings: polygonRings(shape).map((ring) => roundPositions(pointsFromLine(ring, {omitClosing: true}))),
      lines: [],
    });
  }
  return result;
}

async function projectFloor(zones, layers, anchors, sceneVolumes, proven, parents, bindings, manifest, folder) {
  const mark = geometryMark();
  try {
    const completed = await Promise.allSettled(layers.map(async (layer) =>
      [layer.layerId, {shape: await footprint(layer, manifest, folder), name: layer.name}]));
    const failure = completed.find((read) => read.status === 'rejected');
    if (failure) throw failure.reason;
    const footprints = new Map(completed.map(({value}) => value));
    let occupied = emptyPolygon();
    const visible = [];
    const conflicts = [];
    for (const zone of zones) {
      const pieces = bindings[zone.id].filter((id) => footprints.has(id))
        .map((id) => footprints.get(id).shape);
      let artwork = polygonsOnly(difference(union(pieces), occupied));
      const parent = parents.get(keyByParent(zone));
      if (parent) artwork = polygonsOnly(intersection(artwork, parent));
      const shape = polygonsOnly(intersection(polygonFromRings(zone.rings), artwork));
      if (shape.isEmpty()) continue;

      occupied = union([occupied, shape]);
      const points = anchors.filter((anchor) =>
        anchor.state !== zone.state && covers(shape, pointAt(anchor.position[0], anchor.position[2])),
      ).map((anchor) => anchor.pointId);
      if (points.length) {
        conflicts.push({areaId: zone.id, pointIds: points});
        continue;
      }
      const lines = zone.rings.flatMap((ring) => components(
        intersection(lineFromPoints([...ring, ring[0]]), artwork), 'LineString',
      )).map((line) => roundPositions(pointsFromLine(line)));
      visible.push({
        id: zone.id, name: zone.name, state: zone.state, areaIds: [zone.id],
        rings: polygonRings(shape).map((ring) => roundPositions(pointsFromLine(ring, {omitClosing: true}))),
        lines,
      });
    }
    visible.push(...inheritedFloorZones(footprints, anchors, sceneVolumes, parents, occupied));
    if (!visible.length && !conflicts.length) {
      visible.push(...heightIndependentFloorZones(footprints, proven, anchors));
    }
    return {visible, conflicts};
  } finally {
    releaseGeometries(mark);
  }
}

export async function buildFloorViews(bgm, manifest, folder) {
  if (bgm.source.clientExecutableSha256 !== manifest.game.executableSha256) {
    throw new Error('音区与楼层贴片的客户端指纹不一致');
  }
  const layersByView = new Map();
  for (const layer of manifest.layers) {
    const key = bgm.layerFloor[layer.layerId];
    if (!key) continue;
    if (!layersByView.has(key)) layersByView.set(key, []);
    layersByView.get(key).push(layer);
  }
  const parents = parentFootprints(bgm.volumes);
  const floorViews = {};
  const floorViewConflicts = {};
  const bindings = bgm.floorVolumeBindings ?? bgm.surfaceLayerExclusions;
  const volumesByScene = Map.groupBy(bgm.volumes, ({sceneId}) => sceneId);
  const invariants = new Map([...volumesByScene].map(([scene, volumes]) =>
    [scene, invariantRegions(volumes, parents)]));
  for (const [key, layers] of layersByView) {
    const layerIds = new Set(layers.map(({layerId}) => layerId));
    const scene = layers[0].sceneId;
    const sceneVolumes = volumesByScene.get(scene) ?? [];
    const zones = sceneVolumes.filter((zone) => zone.yRange !== null
      && bindings[zone.id]?.some((id) => layerIds.has(id))).sort(compareSourceOrder);
    const anchors = bgm.floorAnchors?.[key] ?? [];
    const proven = invariants.get(scene) ?? [];
    if (!zones.length && !anchors.length && !proven.length) continue;
    const {visible, conflicts} = await projectFloor(
      zones, layers, anchors, sceneVolumes, proven, parents, bindings, manifest, folder,
    );
    if (visible.length) floorViews[key] = visible;
    if (conflicts.length) floorViewConflicts[key] = conflicts;
  }
  return {floorViews, floorViewConflicts};
}

const {values: args} = parseArgs({options: {
  bgm: {type: 'string'}, layers: {type: 'string'}, out: {type: 'string'},
}});
if (!args.bgm || !args.layers || !args.out) throw new Error('需要 --bgm、--layers 和 --out');
const [bgm, manifest] = await Promise.all(
  [args.bgm, args.layers].map(async (file) => JSON.parse(await readFile(file, 'utf8'))),
);
const result = await buildFloorViews(bgm, manifest, path.dirname(args.layers));
Object.assign(bgm, result);
bgm.verification.floorViews = {
  method: 'Floor artwork alpha clips the music footprint. Scene Point and LayerRegion evidence assigns finite-height volumes. Inherited areas use verified waypoints. Height-independent patches are proven to have one state at every height and may cover only part of the artwork. Crop and inference edges are not authored music boundaries.',
  floors: Object.keys(result.floorViews).length,
  zones: Object.values(result.floorViews).flat().length,
};
await writeFile(args.out, `${JSON.stringify(bgm)}\n`);
console.log(`楼层 ${Object.keys(result.floorViews).length} 层，音区 ${Object.values(result.floorViews).flat().length} 块`);
