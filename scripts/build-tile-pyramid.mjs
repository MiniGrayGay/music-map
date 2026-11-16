import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'dist', 'tiles');
const editor = path.resolve(process.env.BGI_MAP_EDITOR ?? 'E:/vueProjects/bettergi-map');
const reportPath = process.env.BGI_MAP_REPORT
  ?? 'E:/tools/AnimeStudio/AssetDigger/output/bgi/map-editor/map-editor-conversion-report.json';
const {MAPS} = await import(pathToFileURL(path.join(editor, 'src/config/mapConfig.js')));
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const data = JSON.parse(await readFile(path.join(project, 'public/data/map-data.json'), 'utf8'));
const layerBases = JSON.parse(await readFile(path.join(project, 'dist/layers/basemaps.json'), 'utf8'));
const layerManifest = JSON.parse(await readFile(path.join(project, 'dist/layers/manifest.json'), 'utf8'));
const texturesRoot = process.env.TEYVAT_TEXTURES_DIR ?? layerBases.texturesRoot
  ?? path.resolve(path.dirname(report.baseMap.source), '..', '..', 'Textures');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

if (report.status !== 'complete' || report.baseMap.status !== 'complete'
  || report.inputIdentity.executableSha256.toLowerCase() !== layerManifest.game.executableSha256.toLowerCase()
  || layerBases.executableSha256 !== layerManifest.game.executableSha256
  || data.dataVersion !== layerManifest.game.version) {
  throw new Error('地图编辑器合成底图、现有地图数据和分层素材版本不一致');
}
if (await digest(report.baseMap.source) !== report.baseMap.sourceSha256) {
  throw new Error('7.2 合成图的内容与地图编辑器转换报告不一致');
}

const entries = {};
const metaPath = path.join(output, 'meta.json');
const previous = await readFile(metaPath, 'utf8').then(JSON.parse, () => ({}));
const jobWidth = 20;

async function cut(name, sourceIdentity, imageWidth, imageHeight, openImage) {
  const tileSize = MAPS[name]?.tileSize;
  if (!Number.isInteger(tileSize) || tileSize <= 0) throw new Error(`缺少 ${name} 编辑器切片尺寸`);
  const maxDim = Math.max(imageWidth, imageHeight);
  const maxTileZoom = Math.max(0, Math.floor(Math.log2(maxDim / tileSize)));
  const meta = {imageWidth, imageHeight, maxDim, maxTileZoom, tileSize, sourceIdentity, quality: 100};
  const {native, ...oldBase} = previous.maps?.[name] ?? {};
  const reuse = JSON.stringify(oldBase) === JSON.stringify(meta);
  let decoded;
  let total = 0;
  for (let z = 0; z <= maxTileZoom; z += 1) {
    const span = maxDim / (2 ** z);
    const cols = Math.ceil(imageWidth / span);
    const rows = Math.ceil(imageHeight / span);
    const jobs = [];
    for (let x = 0; x < cols; x += 1) {
      const folder = path.join(output, name, String(z), String(x));
      await mkdir(folder, {recursive: true});
      for (let y = 0; y < rows; y += 1) {
        const file = path.join(folder, `${y}.webp`);
        total += 1;
        if (reuse && await exists(file)) continue;
        const left = Math.round(x * span);
        const top = Math.round(y * span);
        const width = Math.min(imageWidth, Math.round((x + 1) * span)) - left;
        const height = Math.min(imageHeight, Math.round((y + 1) * span)) - top;
        jobs.push({file, left, top, width, height});
      }
    }
    if (!jobs.length) continue;
    decoded ??= await openImage();
    const {data: pixels, info: {width, height, channels}} = decoded;
    if (width !== imageWidth || height !== imageHeight) throw new Error(`画布尺寸不符：${name}`);
    for (let index = 0; index < jobs.length; index += jobWidth) {
      await Promise.all(jobs.slice(index, index + jobWidth).map(({file, ...crop}) =>
        sharp(pixels, {raw: {width, height, channels}, limitInputPixels: false})
          .extract(crop)
          .resize(tileSize, tileSize, {
            fit: 'contain',
            position: width >= height ? 'top' : 'left',
            background: {r: 0, g: 0, b: 0, alpha: 0},
          })
          .webp({quality: 100, lossless: false})
          .toFile(file)));
    }
  }
  entries[name] = reuse && native ? {...meta, native} : meta;
  console.log(`${name} ${imageWidth}×${imageHeight}，${total} 张 512px 瓦片，0–${maxTileZoom} 级`);
}

const base = report.baseMap;
if (base.width !== data.canvas.width * 4 || base.height !== data.canvas.height * 4) {
  throw new Error('合成底图与 7.2 音乐分区投影不一致');
}
const sea = [22, 60, 76];
const nativeBlock = data.canvas.block * 4;
const occupied = new Set(data.tiles.map((tile) => `${tile.left * 4},${tile.top * 4}`));
const sourceIdentity = createHash('sha256').update(JSON.stringify([
  base.sourceSha256, 'water-fill-source-voids', sea, [...occupied],
])).digest('hex');
await cut('Teyvat', sourceIdentity, base.width, base.height, async () => {
  const decoded = await sharp(base.source, {limitInputPixels: false}).raw().toBuffer({resolveWithObject: true});
  const {data: pixels, info: {width, height, channels}} = decoded;
  for (let y = 0; y < height; y += nativeBlock) {
    for (let x = 0; x < width; x += nativeBlock) {
      if (occupied.has(`${x},${y}`)) continue;
      for (let row = y; row < Math.min(y + nativeBlock, height); row += 1) {
        let offset = (row * width + x) * channels;
        const end = (row * width + Math.min(x + nativeBlock, width)) * channels;
        for (; offset < end; offset += channels) {
          if (pixels[offset] || pixels[offset + 1] || pixels[offset + 2]) continue;
          [pixels[offset], pixels[offset + 1], pixels[offset + 2]] = sea;
        }
      }
    }
  }
  return decoded;
});

for (const [name, map] of Object.entries(layerBases.maps)) {
  const tiles = await Promise.all(map.sources.map(async (tile) => {
    const input = path.join(texturesRoot, tile.file);
    return {input, hash: await digest(input), left: tile.left, top: tile.top};
  }));
  const sourceIdentity = createHash('sha256').update(JSON.stringify(
    tiles.map(({hash, left, top}) => [hash, left, top]),
  )).digest('hex');
  const width = map.canvas.width * 4;
  const height = map.canvas.height * 4;
  await cut(name, sourceIdentity, width, height, async () => {
    const block = 1024;
    const composition = await Promise.all(tiles.map(async ({input, left, top}) => ({
      input: await sharp(input).resize(block, block, {fit: 'fill'}).png().toBuffer(), left, top,
    })));
    return sharp({create: {width, height, channels: 4, background: map.seaColor ?? 'transparent'},
      limitInputPixels: false}).composite(composition).raw().toBuffer({resolveWithObject: true});
  });
}

const stagedMeta = path.join(output, 'meta.stage.json');
await writeFile(stagedMeta, JSON.stringify({
  format: 'teyvat-map-editor-pyramid-v1',
  version: data.dataVersion,
  maps: entries,
}) + '\n');
await rename(stagedMeta, metaPath);
