import {createHash} from 'node:crypto';
import {readFile, readdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'dist/layers');
const root = process.env.TEYVAT_TEXTURES_DIR
  ?? 'E:/tools/AnimeStudio/AssetDigger/output/原神7.2.0/Textures';
const specifications = {
  SeaOfBygoneEras: ['旧日之海', 'UI_MapBack_DeepSea'],
  AncientSacredMountain: ['远古圣山', 'UI_Map_Volcano'],
  TempleOfSpace: ['空之神殿', 'UI_Map_Firmament'],
  MoonCanon: ['霜月', 'UI_Map_MoonCanon'],
};
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

function mapWindow(cells, rows, columns) {
  const rr = cells.map(({row}) => row);
  const cc = cells.map(({column}) => column);
  let best = [];
  let bounds;
  for (let row = Math.min(...rr); row + rows - 1 <= Math.max(...rr); row += 1) {
    for (let column = Math.min(...cc); column + columns - 1 <= Math.max(...cc); column += 1) {
      const inside = cells.filter((cell) => cell.row >= row && cell.row < row + rows
        && cell.column >= column && cell.column < column + columns);
      if (!bounds || inside.length > best.length) {
        best = inside;
        bounds = {row, column, lastRow: row + rows - 1, lastColumn: column + columns - 1};
      }
    }
  }
  if (!bounds) throw new Error(`源纹理跨度不足以计算 ${rows}×${columns} 的画布`);
  return {best, bounds};
}

async function sampleSea(folder, cells, bounds) {
  const edge = cells.filter(({row, column}) => [bounds.row, bounds.lastRow].includes(row)
    || [bounds.column, bounds.lastColumn].includes(column));
  const samples = [];
  for (const {file} of edge) {
    const source = sharp(path.join(folder, file));
    const {width, height} = await source.metadata();
    const pixels = await source.ensureAlpha().extract({
      left: Math.floor(width / 2) - 12, top: Math.floor(height / 2) - 12,
      width: 24, height: 24,
    }).toColourspace('srgb').raw().toBuffer();
    if (pixels.length !== 24 * 24 * 4) throw new Error(`海色样本通道异常 ${file}`);
    const sums = [0, 0, 0];
    const squares = [0, 0, 0];
    let opaque = true;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 250) opaque = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = pixels[offset + channel];
        sums[channel] += value;
        squares[channel] += value ** 2;
      }
    }
    const means = sums.map((sum) => sum / 576);
    if (opaque && means.every((mean, channel) => squares[channel] / 576 - mean ** 2 <= 9)) {
      samples.push(means.map((value) => value % 1 === 0.5
        ? 2 * Math.round((value - 0.5) / 2) : Math.round(value)));
    }
  }
  if (samples.length < 4) return undefined;
  const color = [0, 1, 2].map((channel) => samples.map((rgb) => rgb[channel])
    .sort((a, b) => a - b)[Math.floor(samples.length / 2)]);
  return `#${Buffer.from(color).toString('hex')}`;
}

async function plan(name, [directory, stem], contract) {
  const folder = path.join(root, directory);
  const pattern = new RegExp(`^${stem}_([+-]?\\d+)_([+-]?\\d+).*\\.png$`);
  const coordinates = new Map();
  for (const file of (await readdir(folder)).sort()) {
    const match = pattern.exec(file);
    if (!match) continue;
    const row = Number(match[1]);
    const column = Number(match[2]);
    const key = `${row},${column}`;
    const previous = coordinates.get(key);
    if (previous) {
      if (await digest(path.join(folder, previous.file)) !== await digest(path.join(folder, file))) {
        throw new Error(`${name} 同坐标的纹理不一致 ${key}`);
      }
    } else {
      coordinates.set(key, {row, column, file});
    }
  }
  const {gameMapRows: rows, gameMapCols: columns, pixelScale, size: [width, height]} = contract;
  if (pixelScale !== 1 || width !== columns * 1024 || height !== rows * 1024) {
    throw new Error(`${name} 的坐标系与原始瓦片不匹配`);
  }
  const {best, bounds} = mapWindow([...coordinates.values()], rows, columns);
  const cells = best.sort((a, b) => a.row - b.row || a.column - b.column);
  console.log(`${name} 采用 ${cells.length} 张源纹理，窗口外 ${coordinates.size - cells.length} 张`);
  return {
    canvas: {width: width / 4, height: height / 4, block: 256},
    sources: cells.map(({row, column, file}) => ({
      file: `${directory}/${file}`, left: (bounds.lastColumn - column) * 1024,
      top: (bounds.lastRow - row) * 1024,
    })),
    seaColor: await sampleSea(folder, cells, bounds),
  };
}

const [{game}, contract] = await Promise.all([
  json(path.join(output, 'manifest.json')),
  json(path.join(project, 'scripts/layer-map-contract.json')),
]);
if (game.version !== '7.2.0' || !/^[a-f0-9]{64}$/i.test(game.executableSha256)) {
  throw new Error('未找到已确认身份的 7.2 楼层素材');
}
const maps = Object.fromEntries(await Promise.all(Object.entries(specifications).map(
  async ([name, specification]) => [name, await plan(name, specification, contract.maps[name])],
)));
const result = {
  format: 'teyvat-layer-bases-v2', executableSha256: game.executableSha256,
  version: game.version, maps,
};
const file = path.join(output, 'basemaps.json');
await writeFile(`${file}.stage`, JSON.stringify(result));
await rename(`${file}.stage`, file);
