import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {discoverLayerDisplayFields} from '../../teyvat-map-editor/tools/bgi/layer-models.mjs';
import {analyzeLayerTables} from '../../teyvat-map-editor/tools/bgi/source-analysis.mjs';
import {loadLayerRegions} from './layer-regions.mjs';

const assetDigger = 'E:/tools/AnimeStudio/AssetDigger';
const bgi = `${assetDigger}/output/bgi`;
const extraction = `${assetDigger}/obj/Layout/ExportRepair/product-completion/map-editor`;
const {values: args} = parseArgs({options: {
  input: {type: 'string', default: `${assetDigger}/output/原神7.2.0`},
  report: {type: 'string', default: `${bgi}/map-editor/map-editor-conversion-report.json`},
  evidence: {type: 'string', default: `${bgi}/.assetdigger/conversion-evidence.json`},
  links: {type: 'string', default: `${extraction}/layer-image-links.log`},
  textures: {type: 'string', default: `${extraction}/textures`},
  out: {type: 'string'},
}});
if (!args.out) throw new Error('需要 --out 指定分层贴片生成目录');
const output = path.resolve(args.out);
const json = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const unique = (rows, label) => {
  if (rows.length !== 1) throw new Error(`${label}不能唯一定位`);
  return rows[0];
};
const [report, evidence, contract, identity] = await Promise.all([
  json(args.report), json(args.evidence), json(new URL('./layer-map-contract.json', import.meta.url)),
  json(path.join(args.input, '.assetdigger/client-input.json')),
]);
const kind = 'MapEditor.CurrentLayerPackage.v1';
if (report.format !== kind || report.status !== 'complete'
  || !/^[a-f0-9]{64}$/i.test(identity.executableSha256 ?? '')
  || [report.inputIdentity, evidence.inputIdentity].some((row) => ['executableSha256',
    'metadataSha256', 'startupSha256'].some((key) => !identity[key] || row[key] !== identity[key]))) {
  throw new Error('分层报告和源客户端指纹不一致');
}

async function verifyFile(file, expected) {
  const bytes = await readFile(file);
  if (digest(bytes) !== expected) throw new Error(`源文件指纹变化 ${file}`);
  return bytes;
}
for (const record of [...report.sources, ...report.configs]) {
  const exists = await lstat(record.file).then(() => true, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  // Some report entries refer to disposable trace captures cleared after verification.
  if (exists || report.configs.includes(record)) await verifyFile(record.file, record.sha256);
}
const consumer = unique(report.consumer.filter(({file}) =>
  path.resolve(file).toLowerCase() === path.resolve(contract.source.file).toLowerCase()), '地图编辑器坐标契约');
await verifyFile(consumer.file, consumer.sha256);

const tables = analyzeLayerTables(args.input);
for (const [name, field] of Object.entries(evidence.sourceAnalysis.layers.fields)) {
  if (tables.fields[name] !== field) throw new Error(`当前分层表字段与回放证据不符 ${name}`);
}
const [localization, floorSchema] = await Promise.all([
  json(path.join(args.input, 'TextMap/TextMapCHS.json')),
  json(path.join(args.input, 'schema/MapLayerFloorExcelConfigData.json')),
]);
const display = discoverLayerDisplayFields(tables, (value) => localization[value] ?? null, floorSchema);
const fields = tables.fields;
const groupKeys = Object.keys(tables.groups[0]).filter((key) => key !== fields.groupId);
const floors = new Set(tables.floorById.keys());
const groupIds = new Set(tables.groupById.keys());
const matches = (values, catalog, threshold) => values.length > 0
  && values.filter((val) => catalog.has(val)).length / values.length >= threshold;
const defaultFloor = unique(groupKeys.filter((key) =>
  matches(tables.groups.map((row) => row[key]).filter(Number.isSafeInteger), floors, 0.99)), '组的默认楼层字段');
const backgrounds = groupKeys.filter((key) => matches(tables.groups.flatMap((row) =>
  Array.isArray(row[key]) ? row[key] : []).filter(Number.isSafeInteger), groupIds, 0.9));
const backgroundField = backgrounds.length ? unique(backgrounds, '组的背景图层字段') : null;

const links = new Map();
for (const line of (await readFile(args.links, 'utf8')).split(/\r?\n/)) {
  const prefix = 'CURRENT LAYER IMAGE LINK ';
  if (!line.startsWith(prefix)) continue;
  const row = JSON.parse(line.slice(prefix.length));
  if (!Number.isSafeInteger(row.layerId) || !/^UI_Map_LayeredMap_\d+$/.test(row.textureName)) {
    throw new Error('贴片资源指向记录不完整');
  }
  const prior = links.get(row.layerId);
  const textureIdentity = (item) => JSON.stringify([
    item.textureName, item.textureKey, item.m_Width, item.m_Height, item.pngSha256,
  ]);
  if (prior && textureIdentity(prior) !== textureIdentity(row)) {
    throw new Error(`同一楼层有不同的源贴片 ${row.layerId}`);
  }
  links.set(row.layerId, row);
}
const layerIds = new Set(tables.layerById.keys());
if (links.size !== layerIds.size || [...links.keys()].some((id) => !layerIds.has(id))) {
  throw new Error('贴片资源编号和分层表不一致');
}
const images = new Map(report.images.map((image) => [Number(/_(\d+)\.webp$/.exec(image.file)?.[1]), image]));
const geometry = new Map(report.geometry.map((row) => [Number(row.layerId), row]));
const unavailable = new Map(report.unsupported.map((item) => [Number(item.layerId), item]));
if (images.size !== geometry.size || images.size + unavailable.size !== layerIds.size
  || [...images.keys()].some((id) => !geometry.has(id) || !layerIds.has(id) || unavailable.has(id))) {
  throw new Error('分层贴片、几何和缺图记录不能一一对应');
}
const scenes = new Map();
for (const {mapName, sceneId} of evidence.sourceAnalysis.points.scenes) {
  if (!scenes.has(mapName)) scenes.set(mapName, sceneId);
}
const {regions} = await loadLayerRegions(path.join(args.input, 'BinOutput/MultilayerMapRegion'), layerIds);

async function canvasFor(id, png, image, tint) {
  const bytes = await readFile(png);
  const identity = links.get(id).pngSha256;
  if (identity && digest(bytes) !== identity.toLowerCase()) throw new Error(`源 PNG 指纹变化 ${id}`);
  const rgba = sharp(bytes);
  const info = await rgba.metadata();
  if (info.format !== 'png') throw new Error(`分层原图必须是 PNG ${id}`);
  const published = await verifyFile(image.file, image.sha256);
  const direct = info.width === image.width && info.height === image.height;
  const source = direct ? rgba : sharp(published);
  if (await source.metadata().then(({width, height, format}) =>
    width !== image.width || height !== image.height || (!direct && format !== 'webp'))) {
    throw new Error(`贴片画布与报告不一致 ${id}`);
  }
  if (!direct && tint !== 1) throw new Error(`引用报告成品的层不能重复乘透明度 ${id}`);
  const data = await source.toColourspace('srgb').ensureAlpha().raw().toBuffer();
  let minimum = 255;
  let maximum = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (direct && tint !== 1) data[offset] = Math.round(data[offset] * tint);
    minimum = Math.min(minimum, data[offset]);
    maximum = Math.max(maximum, data[offset]);
  }
  if (!direct && (minimum !== image.alphaRange[0] || maximum !== image.alphaRange[1])) {
    throw new Error(`报告贴片的透明度范围不一致 ${id}`);
  }
  return {data, canvasSource: direct ? 'png' : 'webp-q80-reencode'};
}

const layers = [];
const noImageLayers = [];
const groups = {};
const stats = {pngDirect: 0, webpReencode: 0, alphaExact: 0, rgbMaxChannelError: 0};
const ordered = [...tables.layerById.keys()].sort((a, b) => a - b);
await mkdir(output);
for (const layerId of ordered) {
  const row = tables.layerById.get(layerId);
  const floorId = row[fields.layerFloor];
  const floor = tables.floorById.get(floorId);
  const groupId = floor[fields.floorGroup];
  const group = tables.groupById.get(groupId);
  const floorLevel = floor[display.floor];
  const floorLabel = floorLevel < 0 ? `B${-floorLevel}` : `${floorLevel}F`;
  groups[groupId] ??= {
    defaultFloorId: group[defaultFloor],
    backgroundGroupIds: backgroundField && group[backgroundField]?.length
      ? group[backgroundField] : undefined,
  };
  const base = {layerId, groupId, floorId, floorLevel, floorLabel, name: display.resolveName(floor),
    region: regions.get(layerId) ?? null};
  if (unavailable.has(layerId)) {
    noImageLayers.push({...base, sceneId: unavailable.get(layerId).sceneId,
      reason: 'current client ships no texture for this layer'});
    continue;
  }
  const geom = geometry.get(layerId);
  const image = images.get(layerId);
  if (!geom || !image || !contract.maps[geom.mapName] || !scenes.has(geom.mapName)
    || geom.imageColor?.length !== 4 || geom.imageColor.slice(0, 3).some((n) => n !== 1)
    || !Number.isFinite(geom.imageColor[3]) || geom.imageColor[3] < 0 || geom.imageColor[3] > 1) {
    throw new Error(`贴片几何、场景或透明度证据缺失 ${layerId}`);
  }
  const texture = links.get(layerId).textureName;
  const {data, canvasSource} = await canvasFor(layerId, path.join(args.textures, `${texture}.png`),
    image, geom.imageColor[3]);
  const raw = {width: image.width, height: image.height, channels: 4};
  const encoded = await sharp(data, {raw})
    .webp({quality: 100, alphaQuality: 100, effort: 6, lossless: false}).toBuffer();
  const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer();
  if (decoded.length !== data.length) throw new Error(`贴片编码尺寸不符 ${layerId}`);
  let rgbMaxChannelError = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (decoded[offset + 3] !== data[offset + 3]) throw new Error(`贴片透明度编码有损 ${layerId}`);
    if (!data[offset + 3]) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      rgbMaxChannelError = Math.max(rgbMaxChannelError, Math.abs(decoded[offset + channel] - data[offset + channel]));
    }
  }
  const stem = `UI_Map_LayeredMap_${layerId}`;
  const relative = `${geom.mapName}/${stem}.webp`;
  await mkdir(path.join(output, geom.mapName), {recursive: true});
  await writeFile(path.join(output, relative), encoded, {flag: 'wx'});
  stats[canvasSource === 'png' ? 'pngDirect' : 'webpReencode'] += 1;
  stats.alphaExact += 1;
  stats.rgbMaxChannelError = Math.max(stats.rgbMaxChannelError, rgbMaxChannelError);
  const [left, top, right, bottom] = geom.bounds;
  layers.push({...base, mapName: geom.mapName, sceneId: scenes.get(geom.mapName), image: relative,
    width: image.width, height: image.height, left, top, right, bottom, worldLeft: geom.worldLeft,
    worldTop: geom.worldTop, nativeScale: geom.nativeScale, drawOrder: geom.drawOrder,
    textureAlias: texture === stem ? null : texture, canvasSource, sha256: digest(encoded), rgbMaxChannelError});
}

const maps = Object.fromEntries(Object.keys(contract.maps).map((name) => {
  const entries = layers.filter(({mapName}) => mapName === name);
  return [name, {layers: entries.length, sceneIds: [...new Set(entries.map(({sceneId}) => sceneId))]}];
}));
const manifest = {
  format: 'teyvat-region-map.layers.v1', game: {version: '7.2.0', executableSha256: identity.executableSha256},
  projection: {maps: contract.maps}, maps, groups, layers, noImageLayers,
  encoding: {format: 'webp', quality: 100, lossless: false, alphaLossless: true, effort: 6},
  encodingStats: stats,
};
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {flag: 'wx'});
console.log(`楼层贴片 ${layers.length} 张，透明度逐像素一致 ${stats.alphaExact} 张，缺图 ${noImageLayers.length} 张`);
