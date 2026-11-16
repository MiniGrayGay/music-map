import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {reliefFileNames} from './asset-layout.mjs';
import {sampleOriginalTerrainGaps} from './editor-relief-models.mjs';

const {values} = parseArgs({options: {out: {type: 'string'}, input: {type: 'string', multiple: true}}});
if (!values.out || !values.input?.length) throw new Error('需要 --out 和至少一个 --input');
const output = path.resolve(values.out);
const bgm = JSON.parse(await readFile(new URL('../../../dist/genshin-region-bgm.json', import.meta.url), 'utf8'));
const parts = await Promise.all(values.input.map(async (dir) => {
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  reliefFileNames(index, bgm);
  const bytes = await readFile(path.join(dir, index.file));
  if (bytes.length !== index.bytes || createHash('sha256').update(bytes).digest('hex') !== index.sha256) {
    throw new Error(`点阵分批摘要不符 ${dir}`);
  }
  return {index, bytes, source: index.modelSources};
}));
parts.sort((a, b) => a.source.part - b.source.part);
const first = parts[0].source;
if (parts.some(({source}, i) => source.part !== i || source.parts !== parts.length
  || source.registrySha256 !== first.registrySha256 || source.planSha256 !== first.planSha256 || source.total !== first.total)
  || parts.reduce((sum, {source}) => sum + source.assigned, 0) !== first.total) {
  throw new Error('分批编号或编辑器模型分块计划不一致');
}

const zones = Object.create(null);
const buffers = [];
const omissions = bgm.zones.filter(({id}) => parts.every(({index}) => !Object.hasOwn(index.zones, String(id))));
const supplement = await sampleOriginalTerrainGaps(omissions, bgm.source.clientExecutableSha256);
let offset = 0;
for (const {id} of bgm.zones) {
  const key = String(id);
  const points = [];
  const models = [];
  const seen = new Set();
  for (const [index, part] of parts.entries()) {
    const entry = part.index.zones[key];
    if (!entry) continue;
    const ground = entry.count - entry.modelCount;
    if (index !== 0 && ground) throw new Error(`第 ${index + 1} 批重复提供底面 ${key}`);
    for (let i = 0; i < entry.count; i++) {
      const offset = entry.offset + i * 12;
      const xyz = [0, 4, 8].map((axis) => part.bytes.readFloatLE(offset + axis));
      const identity = xyz.join('/');
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (i < ground) points.push(...xyz);
      else models.push(xyz);
    }
  }
  if (supplement.points.has(key)) models.push(...supplement.points.get(key));
  const modelCount = Math.min(11200, models.length);
  for (let i = 0; i < modelCount; i++) points.push(...models[Math.floor(i * models.length / modelCount)]);
  if (!points.length) continue;
  const block = Buffer.alloc(points.length * 4);
  points.forEach((value, i) => block.writeFloatLE(value, i * 4));
  zones[key] = {offset, count: points.length / 3, modelCount};
  offset += block.length;
  buffers.push(block);
}

const bytes = Buffer.concat(buffers, offset);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const missing = bgm.zones.filter(({id}) => !Object.hasOwn(zones, String(id))).map(({id, name}) => ({id, name}));
const modelSources = {registrySha256: first.registrySha256, planSha256: first.planSha256,
  datasets: [...new Set(parts.flatMap(({source}) => source.datasets))].sort(),
  terrainSupplements: [...supplement.sources].sort(),
  assets: parts.reduce((sum, {source}) => sum + source.assets, 0),
  skipped: parts.reduce((sum, {source}) => sum + source.skipped, 0)};
const index = {schema: 1, version: bgm.clientVersion, zoneSignature: parts[0].index.zoneSignature,
  sha256, file: `points-${sha256.slice(0, 16)}.f32`, bytes: bytes.length, modelSources, zones};
reliefFileNames(index, bgm);
await mkdir(output);
await writeFile(path.join(output, index.file), bytes, {flag: 'wx'});
await writeFile(path.join(output, 'index.json'), JSON.stringify(index) + '\n', {flag: 'wx'});
console.log(JSON.stringify({covered: Object.keys(zones).length, total: bgm.zones.length, missing,
  modelAssets: modelSources.assets, skipped: modelSources.skipped, bytes: bytes.length}));
