import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import sharp from 'sharp';

const project = path.resolve(import.meta.dirname, '..');
const {values: args} = parseArgs({options: {out: {type: 'string'}}});
if (!args.out) throw new Error('需要 --out 指定已登记的原图瓦片生成目录');
const output = path.resolve(args.out);
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const reportPath = process.env.BGI_MAP_REPORT
  ?? 'E:/tools/AnimeStudio/AssetDigger/output/bgi/map-editor/map-editor-conversion-report.json';
const [report, map, meta] = await Promise.all([
  read(reportPath), read(path.join(project, 'public/data/map-data.json')),
  read(path.join(project, 'dist/tiles/meta.json')),
]);
const base = meta.maps.Teyvat;
const atlas = path.join(path.dirname(report.baseMap.source), 'Teyvat_2048.png');
const exportRoot = path.resolve(path.dirname(atlas), '../..');
const identity = await read(path.join(exportRoot, '.assetdigger/client-input.json'));
if (report.status !== 'complete' || report.inputIdentity.executableSha256 !== identity.executableSha256
  || meta.version !== map.dataVersion || base.imageWidth !== report.baseMap.width
  || base.imageHeight !== report.baseMap.height) throw new Error('原图、瓦片与地图版本不一致');
const nativeSize = map.canvas.block * 8;
const tileSize = base.tileSize;
const count = nativeSize / tileSize;
if (!Number.isInteger(count) || nativeSize !== 2048 || tileSize !== 512) {
  throw new Error('原图瓦片的大小不符合主世界网格');
}
const sourceFiles = [];
for (const tile of map.tiles) {
  if (!/^UI_MapBack_[-\d]+_[-\d]+\.png$/.test(tile.source?.file ?? '')) {
    throw new Error(`主世界原图文件名不符合契约 ${tile.file}`);
  }
  const source = path.join(exportRoot, 'Textures', '主世界', tile.source.file);
  const dimensions = await sharp(source).metadata();
  if (dimensions.width !== nativeSize || dimensions.height !== nativeSize) continue;
  const bytes = await readFile(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== tile.source.sha256) throw new Error(`原图摘要不符 ${source}`);
  sourceFiles.push(tile);
}
if (!sourceFiles.length) throw new Error('本次导出没有真正的 2048 原始地图瓦片');
const width = base.imageWidth * 2;
const height = base.imageHeight * 2;
const native = {imageWidth: width, imageHeight: height, tileSize, level: base.maxTileZoom + 1,
  tiles: sourceFiles.flatMap(({left, top}) => {
    const bx = left * 8 / tileSize;
    const by = top * 8 / tileSize;
    return Array.from({length: count * count}, (_, i) => `${bx + i % count}/${by + Math.floor(i / count)}`);
  })};
const atlasHash = createHash('sha256');
for await (const bytes of createReadStream(atlas)) atlasHash.update(bytes);
native.sourceIdentity = createHash('sha256').update(JSON.stringify([
  'native-webp-96-bounded-strips', atlasHash.digest('hex'), sourceFiles.map(({source}) => source.sha256),
])).digest('hex');

const channels = 3;
const raster = sharp(atlas, {limitInputPixels: false, sequentialRead: true});
const metadata = await raster.metadata();
if (metadata.width !== width || metadata.height !== height || metadata.channels !== channels) {
  throw new Error(`2048 合成图的尺寸或格式不匹配 ${JSON.stringify(metadata)}`);
}

// A single RGB decode of this atlas exceeds 4 GiB. Bound the native decode
// before extracting exact pixels, including the composition's approved patches.
const rowsPerStrip = Math.floor(2 ** 30 / (width * tileSize * channels));
if (rowsPerStrip < 1) throw new Error('原图的瓦片行超过解码容量');
const strips = new Map();
for (const key of native.tiles) {
  const [x, y] = key.split('/').map(Number);
  const strip = Math.floor(y / rowsPerStrip);
  if (!strips.has(strip)) strips.set(strip, []);
  strips.get(strip).push({x, y});
}

const folder = path.join(output, String(native.level));
const rowBytes = tileSize * channels;
for (const tiles of strips.values()) {
  const xs = tiles.map(({x}) => x);
  const ys = tiles.map(({y}) => y);
  const left = Math.min(...xs) * tileSize;
  const top = Math.min(...ys) * tileSize;
  const crop = {left, top, width: (Math.max(...xs) + 1) * tileSize - left,
    height: (Math.max(...ys) + 1) * tileSize - top};
  const {data, info} = await raster.clone().extract(crop).raw().toBuffer({resolveWithObject: true});
  if (info.width !== crop.width || info.height !== crop.height || info.channels !== channels
    || data.length !== crop.width * crop.height * channels) {
    throw new Error(`原图条带解码不完整 ${JSON.stringify(crop)}`);
  }
  for (let i = 0; i < tiles.length; i += 12) {
    await Promise.all(tiles.slice(i, i + 12).map(async ({x, y}) => {
      const column = path.join(folder, String(x));
      await mkdir(column, {recursive: true});
      const bytes = Buffer.allocUnsafe(tileSize * rowBytes);
      const offsetX = x * tileSize - left;
      const offsetY = y * tileSize - top;
      for (let row = 0; row < tileSize; row += 1) {
        const start = ((offsetY + row) * crop.width + offsetX) * channels;
        data.copy(bytes, row * rowBytes, start, start + rowBytes);
      }
      await sharp(bytes, {raw: {width: tileSize, height: tileSize, channels}})
        .webp({quality: 96, effort: 3}).toFile(path.join(column, `${y}.webp`));
    }));
  }
}
base.native = native;
await writeFile(path.join(output, 'meta.json'), `${JSON.stringify(meta)}\n`);
console.log(`从 ${sourceFiles.length} 张 2048 原图证明覆盖，生成 ${native.tiles.length} 张原像素瓦片`);
