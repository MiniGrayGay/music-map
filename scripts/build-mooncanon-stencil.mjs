// 生成霜月（scene 102）蓝色危险雾/安全区分类模板贴图。
// 输入全部只读消费研究证据目录；输出 src/features/map/globe/atlas/MoonCanonStencil.png。
// 通道契约（RGBA，A=255 避免颜色预乘损失）：
//   R = 蓝雾危险覆盖：Fog01∪Fog02 的 UI_Fog_MoonCanon_10 遮罩，减去开放区 920 与
//       九个安全区（官方 _Clip+.01 门槛），再按底图有效像素（轮廓内）裁剪。
//   G = 可达覆盖：(开放区 920 ∪ 九个安全区) ∩ 底图有效像素。
//   B = 安全区轮廓覆盖。描线使用原材质门槛，Stencil 130 裁掉开放区和安全区内部。
// 边缘门槛：底图有效像素 = 合成图缩放后 max(r,g,b) > 8（研究底图轮廓外 RGB 全黑、
// alpha 255，与复刻演示一致）；安全区/开放区通过 = maskR ≥ 0.51×255（_Clip=0.5 + .01，
// _OpenAreaLerp=1、_FogRGBA.r=1 时官方门槛 saturate(maskR)≥_Clip+.01）。
// 描线 _WarpMask（Eff_Water_LargeWaves_Normal.png）的 UV 时钟未能核实，按未扰动
// 源形状输出并在运行记录中注明。
// 运行前把 TEMP/TMP/TMPDIR 指向本任务登记的缓存目录，避免写入系统临时区。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(projectRoot, '../..');
const evidence = path.join(workspaceRoot, 'research/Extracted/maps/MoonCanonBlueMask');
const cacheDir = path.join(workspaceRoot, 'cache/teyvat-region-map/mooncanon-stencil');
fs.mkdirSync(cacheDir, {recursive: true});
for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = cacheDir;
const {default: sharp} = await import('sharp');

const configPath = path.join(evidence, 'mooncanon_safety_mask_config.json');
const compositePath = path.join(evidence, 'exports/MoonCanon_Map_17408x9216.png');
const restrictDir = path.join(evidence, 'asset_dump/restrict_fog_textures');
const bigworldDir = path.join(evidence, 'asset_dump/bigworld_fog_textures');
const outline1Path = path.join(restrictDir, 'UI_Fog_MoonCanon_1_Outline.png');
const warpPath = path.join(evidence, 'asset_dump/restrict_fog_aux/Eff_Water_LargeWaves_Normal.png');

const OUT_WIDTH = 2176; // 17408 / 8
const OUT_HEIGHT = 1152; // 9216 / 8
const TERRAIN_LUMA_GATE = 8; // 底图有效像素门槛（0–255）
const CLIP_GATE = 0.51; // _Clip(0.5)+0.01，×255 后采样比较
const OUTLINE_RANGE = 0.4; // 原材质的 _OutlineRange，_OulineFadeRange = 1

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.sceneId !== 102 || config.map.width !== 17408 || config.map.height !== 9216
  || config.blueFogLayers.length !== 2 || config.openRegions[0]?.areaId !== 920
  || config.safeAreas.map(({index}) => index).join(',') !== '1,2,3,4,5,6,7,8,9') {
  throw new Error('mooncanon_safety_mask_config.json 契约不匹配（sceneId/画幅）');
}
const scale = OUT_WIDTH / config.map.width;

function rectOf({pixelCenter, pixelSize}) {
  const x = (pixelCenter[0] - pixelSize[0] / 2) * scale;
  const y = (pixelCenter[1] - pixelSize[1] / 2) * scale;
  return {x, y, width: pixelSize[0] * scale, height: pixelSize[1] * scale};
}

// 原材质的 _Mask.r 和复刻页的灰度覆盖均使用已导出的形状通道。
async function maskLayer(file, rect) {
  const source = path.isAbsolute(file) ? file : path.join(restrictDir, file);
  return sharp(source)
    .extractChannel('red')
    .resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), {kernel: 'lanczos3'})
    .raw().toBuffer();
}

function splatMax(target, layer, rect, value = (sample) => sample) {
  const x0 = Math.max(0, Math.ceil(rect.x - .5));
  const y0 = Math.max(0, Math.ceil(rect.y - .5));
  const x1 = Math.min(OUT_WIDTH, Math.ceil(rect.x + rect.width - .5));
  const y1 = Math.min(OUT_HEIGHT, Math.ceil(rect.y + rect.height - .5));
  const lw = Math.max(1, Math.round(rect.width));
  const lh = Math.max(1, Math.round(rect.height));
  for (let y = y0; y < y1; y += 1) {
    const ly = Math.floor((y + .5 - rect.y) * lh / rect.height);
    for (let x = x0; x < x1; x += 1) {
      const lx = Math.floor((x + .5 - rect.x) * lw / rect.width);
      const v = value(layer[ly * lw + lx]);
      const i = y * OUT_WIDTH + x;
      if (v > target[i]) target[i] = v;
    }
  }
}

const terrain = new Float32Array(OUT_WIDTH * OUT_HEIGHT);
const fog = new Float32Array(OUT_WIDTH * OUT_HEIGHT);
const clearing = new Float32Array(OUT_WIDTH * OUT_HEIGHT);
const outline = new Float32Array(OUT_WIDTH * OUT_HEIGHT);

console.log('底图有效像素（轮廓）:', path.relative(workspaceRoot, compositePath));
{
  const {data} = await sharp(compositePath)
    .removeAlpha().resize(OUT_WIDTH, OUT_HEIGHT, {kernel: 'lanczos3'}).raw().toBuffer({resolveWithObject: true});
  let covered = 0;
  for (let i = 0; i < terrain.length; i += 1) {
    const p = i * 3;
    const luma = Math.max(data[p], data[p + 1], data[p + 2]);
    const inside = luma > TERRAIN_LUMA_GATE ? 255 : 0;
    terrain[i] = inside;
    if (inside) covered += 1;
  }
  console.log(`  门槛 max(r,g,b)>${TERRAIN_LUMA_GATE}，有效像素 ${(covered / terrain.length * 100).toFixed(2)}%`);
}

console.log('蓝雾层（Fog01/Fog02，同一圆形遮罩 UI_Fog_MoonCanon_10.png）:');
for (const layer of config.blueFogLayers) {
  const rect = rectOf(layer);
  const mask = await maskLayer(layer.mask, rect);
  splatMax(fog, mask, rect);
}

console.log('开放区 920 与九个安全区（maskR ≥ ' + (CLIP_GATE * 255).toFixed(1) + '）:');
const gate = CLIP_GATE * 255;
const openRegion = config.openRegions[0];
{
  const rect = rectOf(openRegion);
  const mask = await maskLayer(path.join(bigworldDir, path.basename(openRegion.mask)), rect);
  splatMax(clearing, mask, rect, v => (v >= gate ? 255 : 0));
}
for (const area of config.safeAreas) {
  const rect = rectOf(area);
  const mask = await maskLayer(`UI_Fog_MoonCanon_${area.index}.png`, rect);
  splatMax(clearing, mask, rect, (v) => v >= gate ? 255 : 0);
  const border = area.index === 1 ? await maskLayer(outline1Path, rect) : mask;
  splatMax(outline, border, rect, (v) => v >= OUTLINE_RANGE * 255 ? 255 : v);
}
if (fs.existsSync(warpPath)) {
  console.log(`  描线 _WarpMask ${path.basename(warpPath)} 存在，但其 UV 时钟未核实，按未扰动源形状输出。`);
} else {
  console.log('  描线 _WarpMask 缺失，按未扰动源形状输出。');
}

const pixels = Buffer.alloc(OUT_WIDTH * OUT_HEIGHT * 4, 255);
let hazardPixels = 0, reachPixels = 0, outlinePixels = 0;
for (let i = 0; i < terrain.length; i += 1) {
  const t = terrain[i] / 255;
  const cleared = clearing[i] / 255;
  const hazard = Math.round(fog[i] * (1 - cleared) * t);
  const reach = Math.round(clearing[i] * t);
  pixels[i * 4] = hazard;
  pixels[i * 4 + 1] = reach;
  const border = Math.round(outline[i] * (1 - cleared) * t);
  pixels[i * 4 + 2] = border;
  if (hazard > 127) hazardPixels += 1;
  if (reach > 127) reachPixels += 1;
  if (border > 127) outlinePixels += 1;
}
const total = terrain.length;
const outPath = path.join(projectRoot, 'src/features/map/globe/atlas/MoonCanonStencil.png');
await sharp(pixels, {raw: {width: OUT_WIDTH, height: OUT_HEIGHT, channels: 4}})
  .png({compressionLevel: 9}).toFile(outPath);
console.log(`输出 ${path.relative(projectRoot, outPath)} ${OUT_WIDTH}×${OUT_HEIGHT}，` +
  `${(fs.statSync(outPath).size / 1e6).toFixed(3)} MB`);
console.log(`覆盖统计（>127）：R 危险 ${(hazardPixels / total * 100).toFixed(2)}%，` +
  `G 可达 ${(reachPixels / total * 100).toFixed(2)}%，B 轮廓 ${(outlinePixels / total * 100).toFixed(2)}%`);

// 确定性采样：chartX/chartY 为 17408×9216 合成图像素坐标（÷8 采样成品）。
function sample(chartX, chartY) {
  const x = Math.min(OUT_WIDTH - 1, Math.max(0, Math.floor(chartX * scale)));
  const y = Math.min(OUT_HEIGHT - 1, Math.max(0, Math.floor(chartY * scale)));
  const i = (y * OUT_WIDTH + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}
const probes = [
  ['危险点', 12320, 4240],
  ['画幅外(左上角)', 4, 4],
  ['开放区 920 中心', ...openRegion.pixelCenter],
  ...config.safeAreas.map(area => [`安全区 ${area.index} 中心`, ...area.pixelCenter]),
];
for (const [name, x, y] of probes) console.log(`  ${name} (${x},${y}) → R,G,B = ${sample(x, y).join(',')}`);
