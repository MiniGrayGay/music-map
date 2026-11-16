import {decodeReliefBlock, reliefBlockBytes} from './reliefFormat.js';

let catalogTask;
let completeBuffer;

function readCatalog() {
  catalogTask ??= fetch('./relief/index.json').then(async (response) => {
    if (!response.ok) throw new Error(`点阵索引 HTTP ${response.status}`);
    const index = await response.json();
    if (index.schema !== 1 || !/^points-[a-f0-9]{16}\.f32$/.test(index.file)
      || !Number.isSafeInteger(index.bytes) || index.bytes < 12 || !index.zones || !index.modelSources) {
      throw new Error('分区点阵索引无效');
    }
    return index;
  }).catch((error) => {
    catalogTask = null;
    throw error;
  });
  return catalogTask;
}

export async function loadReliefPoints(key, signal) {
  const index = await readCatalog();
  if (signal.aborted || !Object.hasOwn(index.zones, key)) return null;
  const entry = index.zones[key];
  const {offset, count, modelCount} = entry;
  const size = reliefBlockBytes(entry);
  if (![offset, count, modelCount].every(Number.isSafeInteger) || offset < 0 || offset % 4 || count < 1 || modelCount < 0 || modelCount > count
    || offset + size > index.bytes) throw new Error('分区点阵范围无效');
  if (completeBuffer) return decodeReliefBlock(completeBuffer, entry, offset);
  const response = await fetch(`./relief/${index.file}`, {
    signal, headers: {Range: `bytes=${offset}-${offset + size - 1}`},
  });
  if (response.status === 206) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== size || response.headers.get('content-range') !== `bytes ${offset}-${offset + size - 1}/${index.bytes}`) {
      throw new Error('分区点阵响应不完整');
    }
    return decodeReliefBlock(buffer, entry);
  }
  if (response.status === 200) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== index.bytes) throw new Error('点阵文件不完整');
    completeBuffer = buffer;
    return decodeReliefBlock(buffer, entry, offset);
  }
  throw new Error(`分区点阵 HTTP ${response.status}`);
}
