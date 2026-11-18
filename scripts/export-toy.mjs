import {execFile} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import {createGzip} from 'node:zlib';
import sharp from 'sharp';
import {build, normalizePath, transformWithEsbuild} from 'vite';
import {PACKED_RELIEF, encodeCompactRelief} from '../src/features/map/reliefCompact.js';
import {reliefBlockBytes} from '../src/features/map/reliefFormat.js';
import {mapLabels} from '../src/features/layers/mapBases.js';
import {layerFileNames, reliefFileNames, tileFileNames} from './asset-layout.mjs';

const run = promisify(execFile);
const project = path.resolve(import.meta.dirname, '..');
const distribution = path.join(project, 'dist');
const work = path.resolve(project, '../../cache/teyvat-region-map/toy-package');
const bundle = path.join(work, 'app');
const output = path.join(distribution, 'teyvat-toy.zip');
const maxBytes = 50_000_000;
const quality = 80;
const keepMaps = new Set(Object.keys(mapLabels));
const pick = (entries, names) => Object.fromEntries(
  Object.entries(entries).filter(([key]) => names.has(key)),
);
const json = (relative) => readFile(path.join(distribution, relative), 'utf8').then(JSON.parse);

async function writeJson(relative, value) {
  const target = path.join(bundle, relative);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, JSON.stringify(value));
}

// Re-encode display images, leaving PNG masks and vector graphics intact.
function toyAssets(excludedMaps) {
  const sources = normalizePath(path.join(project, 'src/'));
  const atlases = normalizePath(path.join(project, 'src/features/map/globe/atlas/'));
  return {
    name: 'toy-assets',
    enforce: 'pre',
    async load(id) {
      if (id.startsWith(atlases) && id.endsWith('.webp?url')
        && excludedMaps.has(path.basename(id, '.webp?url'))) return 'export default null;';
      if (!id.startsWith(sources) || !/\.(?:jpg|webp)\?url$/.test(id)) return;
      const input = id.slice(0, -4);
      const source = await sharp(input).webp({quality, alphaQuality: 100}).toBuffer();
      const name = path.basename(input, path.extname(input)) + '.webp';
      const reference = this.emitFile({type: 'asset', name, source});
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}

function toyNotices() {
  const notices = new Set();
  const dependencies = new Map();
  return {
    name: 'toy-third-party-notices',
    renderChunk: {
      order: 'post',
      async handler(code, chunk) {
        const result = await transformWithEsbuild(code, chunk.fileName, {
          loader: 'js', charset: 'utf8', minifyWhitespace: true, legalComments: 'external',
        });
        const notice = result.legalComments?.replace(/\/\*!\s*#__NO_SIDE_EFFECTS__\s*\*\//g, '').trim();
        if (notice) notices.add(notice);
        for (const id of Object.keys(chunk.modules)) {
          if (id.startsWith('\0')) continue;
          const module = normalizePath(id).match(/^(.*\/node_modules\/)((?:@[^/]+\/)?[^/]+)\//);
          if (module) dependencies.set(module[1] + module[2], module[2]);
        }
        return {code: result.code, map: null};
      },
    },
    async generateBundle() {
      const licenses = await Promise.all([...dependencies].sort().map(async ([directory, name]) =>
        name + '\n' + (await readFile(path.join(directory, 'LICENSE'), 'utf8')).trim(),
      ));
      this.emitFile({type: 'asset', fileName: 'third-party-notices.txt',
        source: [...licenses, ...notices].join('\n\n') + '\n'});
    },
  };
}

async function writeImages(files) {
  for (let index = 0; index < files.length; index += 8) {
    await Promise.allSettled(files.slice(index, index + 8).map(async (relative) => {
      const target = path.join(bundle, relative);
      await mkdir(path.dirname(target), {recursive: true});
      await sharp(path.join(distribution, relative)).webp({quality, effort: 3, alphaQuality: 100}).toFile(target);
    })).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
  }
}

async function writeRelief(index, bgm) {
  const [, file] = reliefFileNames(index, bgm);
  const data = await readFile(path.join(distribution, file));
  if (data.byteLength !== index.bytes) throw new Error('分区点阵发布字节数不符');
  const zones = {};
  let unpackedBytes = 0;
  function* blocks() {
    for (const [key, entry] of Object.entries(index.zones)) {
      const length = reliefBlockBytes(entry);
      const values = new Float32Array(data.buffer, data.byteOffset + entry.offset, length / 4);
      const block = encodeCompactRelief(values, entry);
      const {count, sideCount, grid} = entry;
      zones[key] = {count, sideCount, grid, offset: unpackedBytes, bytes: block.byteLength};
      unpackedBytes += block.byteLength;
      yield block;
    }
  }
  const packedName = `points-${index.sha256.slice(0, 16)}.gz.data`;
  const target = path.join(bundle, 'relief', packedName);
  await mkdir(path.dirname(target), {recursive: true});
  await pipeline(Readable.from(blocks(), {objectMode: false}), createGzip(), createWriteStream(target));
  const {size: compressedBytes} = await lstat(target);
  await writeJson('relief/index.json', {
    schema: 1, encoding: PACKED_RELIEF, file: packedName, compressedBytes, unpackedBytes, zones,
  });
}

async function assemble() {
  const [map, tiles, layers, basemaps, bgm, relief] = await Promise.all([
    json('data/map-data.json'), json('tiles/meta.json'), json('layers/manifest.json'),
    json('layers/basemaps.json'), json('data/genshin-region-bgm.json'), json('relief/index.json'),
  ]);
  if ([tiles.version, layers.game.version, basemaps.version, bgm.clientVersion]
    .some((version) => version !== map.dataVersion)) throw new Error('Toy 发布素材版本不一致');

  const excludedMaps = new Set(Object.keys(tiles.maps).filter((name) => !keepMaps.has(name)));
  layers.layers = layers.layers.filter((layer) => keepMaps.has(layer.mapName));
  layers.noImageLayers = layers.noImageLayers.filter((layer) => keepMaps.has(layer.mapName));
  layers.maps = pick(layers.maps, keepMaps);
  layers.projection.maps = pick(layers.projection.maps, keepMaps);
  layers.groups = pick(layers.groups, new Set(layers.layers.map((layer) => String(layer.groupId))));
  tiles.maps = pick(tiles.maps, keepMaps);
  for (const mapTiles of Object.values(tiles.maps)) mapTiles.quality = quality;
  basemaps.maps = pick(basemaps.maps, keepMaps);
  bgm.maps = pick(bgm.maps, keepMaps);
  bgm.scenes = pick(bgm.scenes, new Set(Object.values(bgm.maps).map(({sceneId}) => String(sceneId))));
  bgm.layerFloor = pick(bgm.layerFloor, new Set(layers.layers.map((layer) => String(layer.layerId))));
  bgm.floorViews = pick(bgm.floorViews, new Set(Object.values(bgm.layerFloor)));
  delete bgm.musicGraph.audioBaseUrl;
  delete bgm.musicGraph.supplementAudioBaseUrl;
  for (const area of Object.values(bgm.music)) delete area.playlists?.combat;
  // The runtime uses the published catalog for names, album titles and durations.
  // Keep source membership so the graph still resolves the original branches.
  for (const id of Object.keys(bgm.musicGraph.media)) bgm.musicGraph.media[id] = {};

  await build({root: project, plugins: [toyAssets(excludedMaps), toyNotices()],
    build: {outDir: bundle, copyPublicDir: false, manifest: false, sourcemap: false}});
  await Promise.all([
    copyFile(path.join(project, 'public/favicon.svg'), path.join(bundle, 'favicon.svg')),
    writeJson('data/map-data.json', {...map, preloadRelief: true}), writeJson('data/genshin-region-bgm.json', bgm),
    writeJson('tiles/meta.json', tiles), writeJson('layers/manifest.json', layers),
    writeJson('layers/basemaps.json', basemaps),
  ]);
  await writeRelief(relief, bgm);
  const tilePaths = tileFileNames(tiles);
  await writeImages([...tilePaths, ...layerFileNames(layers)]);
  return {tiles: tilePaths.length, zones: Object.keys(relief.zones).length};
}

// Python's standard ZIP writer keeps paths relative to the submission root.
const zip = [
  'import pathlib, sys, zipfile',
  'root = pathlib.Path(sys.argv[1])',
  'with zipfile.ZipFile(sys.argv[2], "x", zipfile.ZIP_DEFLATED) as archive:',
  '    for source in sorted(root.rglob("*")):',
  '        if source.is_file(): archive.write(source, source.relative_to(root).as_posix())',
].join('\n');

await mkdir(work);
process.env.TEMP = work;
process.env.TMP = work;
try {
  const counts = await assemble();
  const archive = path.join(work, 'teyvat-toy.zip');
  await run('python', ['-B', '-c', zip, bundle, archive], {windowsHide: true});
  const {size} = await lstat(archive);
  if (size > maxBytes) throw new Error(`Toy ZIP 超过 50 MB，实测 ${(size / 1e6).toFixed(2)} MB`);
  await rename(archive, output);
  console.log(`Toy ZIP ${(size / 1e6).toFixed(2)} MB，${counts.tiles} 张地图瓦片，${counts.zones} 个点阵分区\n${output}`);
} finally {
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', 'E:\\tools\\Remove-Directory.ps1', '-Path', work, '-Json'], {windowsHide: true});
    if ((await readdir(path.dirname(work))).includes(path.basename(work))) throw new Error(`清理未完成 ${work}`);
  } else {
    await rm(work, {recursive: true});
  }
}
