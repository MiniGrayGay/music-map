// 层岩巨渊（TheChasm）独立地图补齐脚本。
// 从 7.2.0 拆包原图 3×3（UI_MapBack_TheChasm_{row}_{col}.png，1024²）合成
// 3072² 原生画布，套用外轮廓 SVG alpha 遮罩（technical ground clipping，
// 羽化 blur 24 原生像素，外部透明），产出 0–2 级 512px 瓦片金字塔（21 张），
// 并把条目合并进 dist/layers/basemaps.json、dist/tiles/meta.json 与
// dist/data/genshin-region-bgm.json（缺 maps.TheChasm 时注册）。
// 所有权威共享文件不就地改写：同目录固定 .stage 文件写好后 rename。
// 本脚本只处理 TheChasm，不复制其他资源、不调用整库构建；可重复运行，
// TheChasm 既有条目按新身份原子覆盖，不触碰其他地图。
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const project = path.resolve(import.meta.dirname, '..');
const NAME = 'TheChasm';
const FOLDER = '层岩巨渊';
const PATTERN = /^UI_MapBack_TheChasm_(-?\d+)_(-?\d+)\.png$/;
const ROWS = [1, 0, -1]; // 自上而下
const COLS = [-1, 0, 1]; // 自左而右
const NATIVE = 3072;
const TILE = 1024;
const TILE_SIZE = 512;
const QUALITY = 80;
const FEATHER = 24; // 遮罩羽化 sigma（原生像素）
// 外轮廓多边形（1024 基准坐标），遮罩时整体 ×3 映射到原生画布
const MASK_POINTS = '150,500 260,470 280,420 295,340 340,290 430,268 500,250 '
  + '590,245 650,320 700,390 710,465 655,550 620,620 610,700 500,720 '
  + '420,700 365,675 360,600 285,600 240,660 170,650 145,595';
const SEA_COLOR = '#262c30'; // 深岩灰背景
const VIEW_BOUNDS = [0.13, 0.23, 0.59, 0.49]; // 归一化 [x, y, w, h]

const texturesRoot = process.env.TEYVAT_TEXTURES_DIR
  ?? 'E:/tools/AnimeStudio/AssetDigger/output/原神7.2.0/Textures';
const sourceDir = path.join(texturesRoot, FOLDER);

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse);

// 共享文件原子发布：先写 .stage 再 rename（WebP 在 stage 路径上显式编码）
const publish = async (file, encode) => {
  await encode(`${file}.stage`);
  await rename(`${file}.stage`, file);
};

const digest = (file) => {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk))
      .on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
};

// ---- 版本核对：manifest game 身份 + 既有 basemaps 版本 ----
const manifest = await readJson(path.join(project, 'dist/layers/manifest.json'));
const basemapsPath = path.join(project, 'dist/layers/basemaps.json');
const basemaps = await readJson(basemapsPath);
const gameVersion = manifest.game?.version;
if (gameVersion !== '7.2.0' || basemaps.version !== gameVersion) {
  throw new Error(`版本不一致：manifest.game.version=${gameVersion}，basemaps.version=${basemaps.version}，要求 7.2.0`);
}
if (basemaps.format !== 'teyvat-layer-bases-v2') {
  throw new Error(`basemaps.json format 不符：${basemaps.format}`);
}
if (basemaps.executableSha256 && manifest.game.executableSha256
  && basemaps.executableSha256.toLowerCase() !== manifest.game.executableSha256.toLowerCase()) {
  throw new Error('basemaps.executableSha256 与 manifest.game 身份不一致');
}

// ---- 音乐清单 fail-closed：scenes['6'] 必须 8 条；maps.TheChasm 缺失则注册 ----
const bgmPath = path.join(project, 'dist/data/genshin-region-bgm.json');
const bgm = await readJson(bgmPath);
if ((bgm.scenes?.['6'] ?? []).length !== 8) {
  throw new Error(`genshin-region-bgm.json scenes['6'] 应有 8 个分区，实为 ${(bgm.scenes?.['6'] ?? []).length}`);
}
const chasmBgm = {sceneId: 6, origin: [512, 512]};
if (JSON.stringify(bgm.maps?.[NAME]) !== JSON.stringify(chasmBgm)) {
  await publish(bgmPath, (file) => writeFile(file, `${JSON.stringify({
    ...bgm,
    maps: {...(bgm.maps ?? {}), [NAME]: chasmBgm},
  })}\n`));
  console.log(`genshin-region-bgm.json 已注册 maps.${NAME}=${JSON.stringify(chasmBgm)}（.stage+rename）`);
}

// ---- 精确读取坐标 + SHA 去重，要求完整 3×3 ----
const files = (await readdir(sourceDir)).filter((file) => PATTERN.test(file));
const byCoord = new Map();
for (const file of files) {
  const [, row, col] = PATTERN.exec(file);
  const key = `${row},${col}`;
  const sha = await digest(path.join(sourceDir, file));
  if (byCoord.has(key)) {
    if (byCoord.get(key).sha !== sha) throw new Error(`坐标重复且内容不同：${key}`);
    continue; // 同内容重复文件去重
  }
  byCoord.set(key, {file, sha, row: Number(row), col: Number(col)});
}
for (const row of ROWS) {
  for (const col of COLS) {
    if (!byCoord.has(`${row},${col}`)) {
      throw new Error(`缺少 ${FOLDER}/UI_MapBack_TheChasm_${row}_${col}.png，3×3 不完整`);
    }
  }
}
for (const {file, row, col} of byCoord.values()) {
  const dimensions = await sharp(path.join(sourceDir, file)).metadata();
  if (dimensions.width !== TILE || dimensions.height !== TILE) {
    throw new Error(`${file} 尺寸 ${dimensions.width}×${dimensions.height} ≠ 1024²`);
  }
}

// ---- 合成 3072² 原生画布，left=(1-col)*1024，top=(1-row)*1024 ----
const sources = ROWS.flatMap((row) => COLS.map((col) => {
  const {file, sha} = byCoord.get(`${row},${col}`);
  return {file: `${FOLDER}/${file}`, sha, left: (1 - col) * TILE, top: (1 - row) * TILE};
}));
const composition = await Promise.all(sources.map(({file, left, top}) =>
  sharp(path.join(texturesRoot, file)).png().toBuffer().then((input) => ({input, left, top}))));
let {data: pixels, info} = await sharp({create: {width: NATIVE, height: NATIVE, channels: 4, background: 'transparent'},
  limitInputPixels: false}).composite(composition).raw().toBuffer({resolveWithObject: true});
if (info.width !== NATIVE || info.height !== NATIVE) throw new Error('合成画布尺寸不符');

// ---- 外轮廓 alpha 遮罩（technical ground clipping）：SVG 多边形 ×3 → 羽化 → dst-in ----
const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" `
  + `width="${NATIVE}" height="${NATIVE}"><polygon points="${MASK_POINTS}" fill="white"/></svg>`;
const mask = await sharp(Buffer.from(maskSvg)).blur(FEATHER).png().toBuffer();
({data: pixels} = await sharp(pixels, {raw: {width: NATIVE, height: NATIVE, channels: 4}, limitInputPixels: false})
  .composite([{input: mask, blend: 'dest-in'}]).raw().toBuffer({resolveWithObject: true}));
const seaColor = SEA_COLOR;

const sourceIdentity = createHash('sha256').update(JSON.stringify([
  'independent-map-webp-80-masked', NAME, NATIVE, TILE_SIZE, QUALITY,
  MASK_POINTS, FEATHER, seaColor,
  sources.map(({sha, left, top}) => [sha, left, top]),
])).digest('hex');

// ---- 输出：0–2 级 512px 瓦片金字塔（羽化透明边缘，质量 80），21 张 ----
const maxDim = Math.max(NATIVE, NATIVE);
const maxTileZoom = Math.max(0, Math.floor(Math.log2(maxDim / TILE_SIZE)));
const tilesRoot = path.join(project, 'dist/tiles', NAME);
let tileCount = 0;
for (let z = 0; z <= maxTileZoom; z += 1) {
  const span = maxDim / (2 ** z);
  const cols = Math.ceil(NATIVE / span);
  const rows = Math.ceil(NATIVE / span);
  for (let x = 0; x < cols; x += 1) {
    const folder = path.join(tilesRoot, String(z), String(x));
    await mkdir(folder, {recursive: true});
    for (let y = 0; y < rows; y += 1) {
      const left = Math.round(x * span);
      const top = Math.round(y * span);
      const width = Math.min(NATIVE, Math.round((x + 1) * span)) - left;
      const height = Math.min(NATIVE, Math.round((y + 1) * span)) - top;
      const tilePath = path.join(folder, `${y}.webp`);
      await publish(tilePath, (file) => sharp(pixels, {raw: {width: NATIVE, height: NATIVE, channels: 4}, limitInputPixels: false})
        .extract({left, top, width, height})
        .resize(TILE_SIZE, TILE_SIZE, {
          fit: 'contain',
          position: width >= height ? 'top' : 'left',
          background: {r: 0, g: 0, b: 0, alpha: 0},
        })
        .webp({quality: QUALITY, lossless: false})
        .toFile(file));
      tileCount += 1;
    }
  }
}
if (tileCount !== 21) throw new Error(`瓦片数量 ${tileCount} ≠ 21`);

// ---- 合并 dist/tiles/meta.json（.stage + rename，只覆盖 TheChasm 条目） ----
const metaPath = path.join(project, 'dist/tiles/meta.json');
const meta = await readJson(metaPath);
if (meta.version !== gameVersion) throw new Error(`tiles/meta.json version=${meta.version} ≠ ${gameVersion}`);
await publish(metaPath, (file) => writeFile(file, `${JSON.stringify({
  ...meta,
  maps: {
    ...meta.maps,
    [NAME]: {
      imageWidth: NATIVE, imageHeight: NATIVE, maxDim, maxTileZoom,
      tileSize: TILE_SIZE, sourceIdentity, quality: QUALITY,
    },
  },
})}\n`));

// ---- 合并 dist/layers/basemaps.json（.stage + rename，只覆盖 TheChasm 条目） ----
const stagedBasemaps = {
  ...basemaps,
  maps: {
    ...basemaps.maps,
    [NAME]: {
      canvas: {width: 768, height: 768, block: 256},
      sources: sources.map(({file, left, top}) => ({file, left, top})),
      seaColor,
      viewBounds: VIEW_BOUNDS,
    },
  },
};
await publish(basemapsPath, (file) => writeFile(file, `${JSON.stringify(stagedBasemaps)}\n`));

console.log(`${NAME}: 3×3 原图合成 ${NATIVE}²，外轮廓遮罩（${MASK_POINTS.split(' ').length} 顶点，`
  + `羽化 σ=${FEATHER}），seaColor=${seaColor}，viewBounds=[${VIEW_BOUNDS}]，`
  + `${tileCount} 张瓦片（0–${maxTileZoom} 级），`
  + `meta/basemaps/bgm 均按 .stage+rename 合并，sourceIdentity=${sourceIdentity.slice(0, 12)}…`);
