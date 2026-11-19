import {decodeReliefBlock, reliefBlockBytes} from './reliefFormat.js';
import {COMPACT_RELIEF, PACKED_RELIEF, decodeCompactRelief} from './reliefCompact.js';
import {fetchMapDocument, maskPacket, reliefAsset} from './releaseData.js';

let catalogTask;
let packedTask;
let completeBuffer;

function readCatalog() {
  catalogTask ??= fetchMapDocument('./relief/index.json').then(async (response) => {
    if (!response.ok) throw new Error(`点阵索引 HTTP ${response.status}`);
    const index = await response.json();
    if (index.schema !== 1 || !index.zones) throw new Error('分区点阵索引无效');
    if (index.encoding === PACKED_RELIEF) {
      if (!/^points-[a-f0-9]{16}\.gz\.data$/.test(index.file)
        || !Number.isSafeInteger(index.compressedBytes) || index.compressedBytes < 18
        || !Number.isSafeInteger(index.unpackedBytes) || index.unpackedBytes < 12) {
        throw new Error('点阵包索引无效');
      }
    } else if (index.encoding !== COMPACT_RELIEF && (!/^points-[a-f0-9]{16}\.f32$/.test(index.file)
        || !Number.isSafeInteger(index.bytes) || index.bytes < 12 || !index.modelSources)) {
      throw new Error('分区点阵索引无效');
    }
    return index;
  }).catch((error) => {
    catalogTask = null;
    throw error;
  });
  return catalogTask;
}

async function downloadPackedRelief(index, report) {
  const total = index.compressedBytes;
  report({stage: 'download', received: 0, total});
  const {url, seed} = reliefAsset('./relief/' + index.file);
  const response = await fetch(url);
  if (!response.ok) throw new Error('点阵包 HTTP ' + response.status);
  const compressed = new Uint8Array(total);
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (received + value.byteLength > total) {
        await reader.cancel();
        throw new Error('点阵包大小不符');
      }
      compressed.set(seed === null ? value : maskPacket(value, seed, received), received);
      received += value.byteLength;
      report({stage: 'download', received, total});
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== total) throw new Error('点阵包下载不完整');

  report({stage: 'decompress'});
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  if (buffer.byteLength !== index.unpackedBytes) throw new Error('点阵解压后大小不符');
  return new Uint8Array(buffer);
}

function readPackedRelief(index, report = () => {}) {
  packedTask ??= downloadPackedRelief(index, report).catch((error) => {
    packedTask = null;
    throw error;
  });
  return packedTask;
}

export async function preloadRelief(report) {
  const index = await readCatalog();
  if (index.encoding !== PACKED_RELIEF) throw new Error('缺少可预加载的点阵包');
  await readPackedRelief(index, report);
}

export async function loadReliefPoints(key, signal) {
  const index = await readCatalog();
  if (signal.aborted || !Object.hasOwn(index.zones, key)) return null;
  const entry = index.zones[key];
  if (index.encoding === PACKED_RELIEF) {
    const {offset, bytes, count} = entry;
    if (![offset, bytes, count].every(Number.isSafeInteger) || offset < 0 || bytes < 12 || count < 1
      || bytes > index.unpackedBytes - offset) throw new Error('点阵包分区范围无效');
    const packed = await readPackedRelief(index);
    if (signal.aborted) return null;
    return decodeCompactRelief(packed.subarray(offset, offset + bytes), entry);
  }
  if (index.encoding === COMPACT_RELIEF) {
    if (!Number.isSafeInteger(entry.slot) || entry.slot < 0 || !Number.isSafeInteger(entry.count) || entry.count < 1) {
      throw new Error('紧凑点阵索引无效');
    }
    reliefBlockBytes(entry);
    const response = await fetch(`./relief/blocks/${entry.slot}.json`, {signal});
    if (!response.ok) throw new Error(`分区点阵 HTTP ${response.status}`);
    const compressed = Uint8Array.from(atob(await response.json()), (character) => character.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return decodeCompactRelief(bytes, entry);
  }
  const {offset, count, modelCount} = entry;
  const size = reliefBlockBytes(entry);
  if (![offset, count, modelCount].every(Number.isSafeInteger) || offset < 0 || offset % 4 || count < 1 || modelCount < 0 || modelCount > count
    || offset + size > index.bytes) throw new Error('分区点阵范围无效');
  if (completeBuffer) return decodeReliefBlock(completeBuffer, entry, offset);
  const {url, seed} = reliefAsset(`./relief/${index.file}`);
  const response = await fetch(url, {
    signal, headers: {Range: `bytes=${offset}-${offset + size - 1}`},
  });
  if (response.status === 206) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== size || response.headers.get('content-range') !== `bytes ${offset}-${offset + size - 1}/${index.bytes}`) {
      throw new Error('分区点阵响应不完整');
    }
    if (seed !== null) maskPacket(new Uint8Array(buffer), seed, offset);
    return decodeReliefBlock(buffer, entry);
  }
  if (response.status === 200) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== index.bytes) throw new Error('点阵文件不完整');
    if (seed !== null) maskPacket(new Uint8Array(buffer), seed);
    completeBuffer = buffer;
    return decodeReliefBlock(buffer, entry, offset);
  }
  throw new Error(`分区点阵 HTTP ${response.status}`);
}
