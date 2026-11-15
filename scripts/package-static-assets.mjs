import {createHash} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {copyFile, link, lstat, mkdir, open, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {layerFileNames, tileFileNames} from './asset-layout.mjs';

const project = path.resolve(import.meta.dirname, '..');
const workspace = path.resolve(project, '..', '..');
const output = path.join(project, 'dist');
const manifestFile = process.env.TEYVAT_BGM_MANIFEST ?? path.join(workspace, 'dist/genshin-region-bgm.json');
const audioSource = process.env.TEYVAT_AUDIO_DIR ?? path.join(workspace, 'dist/region-bgm-audio');

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || !info.size) throw new Error(`缺少有效文件 ${file}`);
  return info;
}

async function verifyOpus(file, size, expectedDuration) {
  const stream = await open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 512));
    await stream.read(head, 0, head.length, 0);
    const header = 27 + head[26];
    if (head.subarray(0, 4).toString() !== 'OggS'
      || header + 19 > head.length || head.subarray(header, header + 8).toString() !== 'OpusHead') {
      throw new Error(`音频缺少 Ogg Opus 头 ${file}`);
    }
    const serial = head.readUInt32LE(14);
    const preSkip = head.readUInt16LE(header + 10);
    const tail = Buffer.alloc(Math.min(size, 65536));
    await stream.read(tail, 0, tail.length, size - tail.length);
    for (let offset = tail.lastIndexOf('OggS'); offset >= 0;) {
      const segments = tail[offset + 26];
      const payload = offset + 27 + segments;
      if (payload <= tail.length && tail[offset + 4] === 0 && (tail[offset + 5] & 4)
        && tail.readUInt32LE(offset + 14) === serial) {
        const end = tail.subarray(offset + 27, payload).reduce((sum, bytes) => sum + bytes, payload);
        if (end === tail.length) {
          const duration = (Number(tail.readBigUInt64LE(offset + 6)) - preSkip) / 48000;
          if (Math.abs(duration - expectedDuration) > 0.1) {
            throw new Error(`音频时长与清单不符 ${file}`);
          }
          return;
        }
      }
      offset = offset > 0 ? tail.lastIndexOf('OggS', offset - 1) : -1;
    }
    throw new Error(`音频末尾不完整 ${file}`);
  } finally {
    await stream.close();
  }
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function materialize(source, destination, info) {
  const previous = await lstat(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (previous) {
    if (!previous.isFile()) throw new Error(`音频目标路径无效 ${destination}`);
    if (previous.dev === info.dev && previous.ino === info.ino) return;
    if (previous.size === info.size && await digest(source) === await digest(destination)) return;
    throw new Error(`音频内容与当前资料不一致 ${destination}`);
  }
  try {
    await link(source, destination);
  } catch (error) {
    if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

async function batches(items, execute) {
  for (let index = 0; index < items.length; index += 24) {
    await Promise.all(items.slice(index, index + 24).map(execute));
  }
}

function playbackItems(items) {
  return items.map((item) => item.children?.length
    ? {eRSType: item.eRSType, children: playbackItems(item.children)}
    : {SegmentID: item.SegmentID});
}

function playbackNode(node) {
  switch (node.kind) {
    case 'switch': return {kind: node.kind, mode: node.mode, groups: node.groups, leaves: node.leaves};
    case 'playlist': return {kind: node.kind, items: playbackItems(node.items)};
    case 'segment': return {kind: node.kind, source: node.source, issue: node.issue};
    default: return {kind: node.kind};
  }
}

const [map, tiles, layers, basemaps, source] = await Promise.all([
  json(path.join(output, 'data/map-data.json')),
  json(path.join(output, 'tiles/meta.json')),
  json(path.join(output, 'layers/manifest.json')),
  json(path.join(output, 'layers/basemaps.json')),
  json(manifestFile),
]);

const version = map.dataVersion;
const fingerprint = source.source?.clientExecutableSha256;
if (source.schemaVersion !== 1 || source.sceneId !== 3 || !source.musicGraph
  || [tiles.version, layers.game?.version, basemaps.version, source.clientVersion]
    .some((value) => value !== version)
  || !/^[a-f0-9]{64}$/i.test(fingerprint ?? '')
  || [layers.game?.executableSha256, basemaps.executableSha256]
    .some((value) => value?.toLowerCase() !== fingerprint.toLowerCase())) {
  throw new Error('发布素材的客户端版本或指纹不一致');
}

const tilePaths = tileFileNames(tiles);
const layerPaths = layerFileNames(layers);
await batches(tilePaths, (name) => regularFile(path.join(output, name)));
await batches(layers.layers, async (layer) => {
  const file = path.join(output, 'layers', layer.image);
  await regularFile(file);
  if (await digest(file) !== layer.sha256) throw new Error(`楼层贴片指纹不符 ${layer.image}`);
});

const graph = source.musicGraph;
const media = Object.entries(graph.media);
const audioOutput = path.join(output, 'region-bgm-audio');
await mkdir(audioOutput, {recursive: true});
let audioBytes = 0;
await batches(media, async ([id, track]) => {
  if (!/^\d+$/.test(id) || !Number.isFinite(track.duration) || track.duration <= 0) {
    throw new Error(`非法试听音轨 ${id}`);
  }
  const file = path.join(audioSource, `${id}.opus`);
  const info = await regularFile(file);
  await verifyOpus(file, info.size, track.duration);
  await materialize(file, path.join(audioOutput, `${id}.opus`), info);
  audioBytes += info.size;
});

const {
  schemaVersion, clientVersion, sceneId, zones, scenes, maps, layerFloor, floorViews,
  surfaceLayerExclusions,
} = source;
const runtime = {
  schemaVersion, clientVersion, sceneId, zones, scenes, maps, layerFloor, floorViews,
  surfaceLayerExclusions,
  music: Object.fromEntries(Object.entries(source.music).map(([state, entry]) => [
    state, {wwiseId: entry.wwiseId, playlists: entry.playlists},
  ])),
  musicGraph: {
    ...graph,
    nodes: Object.fromEntries(Object.entries(graph.nodes).map(([id, node]) => [id, playbackNode(node)])),
  },
};
async function publish(relative, data) {
  const final = path.join(output, relative);
  const stage = `${final}.stage`;
  await writeFile(stage, JSON.stringify(data));
  await rename(stage, final);
}

await Promise.all([
  publish('data/genshin-region-bgm.json', runtime),
  publish('data/map-data.json', {format: map.format, dataVersion: map.dataVersion, canvas: map.canvas}),
  publish('layers/manifest.json', {
    format: layers.format, game: layers.game, projection: layers.projection, maps: layers.maps,
    groups: layers.groups, layers: layers.layers, noImageLayers: layers.noImageLayers,
  }),
  publish('layers/basemaps.json', {
    format: basemaps.format, version: basemaps.version,
    executableSha256: basemaps.executableSha256, maps: basemaps.maps,
  }),
]);
console.log(`静态交付已核对 ${tilePaths.length} 张瓦片、${layerPaths.length} 张楼层贴片、${media.length} 首音轨（音频 ${Math.round(audioBytes / 1e6)} MB）`);
