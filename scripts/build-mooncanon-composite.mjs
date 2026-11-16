import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {moonCanonChart, moonCanonPatch} from '../src/features/map/mooncanonSafety.js';

const editor = process.env.BGI_MAP_EDITOR ?? 'E:/vueProjects/bettergi-map';
const source = path.resolve(editor, 'public/MoonCanon_1024.jpg');
const sourceBytes = await readFile(source);
const image = sharp(sourceBytes, {limitInputPixels: false});
const {width, height} = await image.metadata();
if (width !== moonCanonChart.width * 4 || height !== moonCanonChart.height * 4) {
  throw new Error(`编辑器霜月底图尺寸不一致：${width}×${height}`);
}

// Keep the editor artwork at its original coordinates. Feather the crop into the
// complete 7.2 atlas outside the composite, where both maps show the same terrain.
const rect = Object.fromEntries(['left', 'top', 'width', 'height'].map(
  (key) => [key, moonCanonPatch[key] * 4],
));
const {data, info} = await image.extract(rect).ensureAlpha().raw()
  .toBuffer({resolveWithObject: true});
const feather = 24;
for (let y = 0; y < rect.height; y += 1) {
  for (let x = 0; x < rect.width; x += 1) {
    const edge = Math.min(x, y, rect.width - 1 - x, rect.height - 1 - y);
    data[(y * rect.width + x) * 4 + 3] = Math.round(Math.min(1, edge / feather) * 255);
  }
}
const patch = await sharp(data, {raw: info}).webp({lossless: true}).toBuffer();
const destination = new URL('../src/features/map/mooncanon-editor-patch.webp', import.meta.url);
await writeFile(destination, patch);
console.log(JSON.stringify({source, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  rect, bytes: patch.byteLength,
  sha256: createHash('sha256').update(patch).digest('hex')}));
