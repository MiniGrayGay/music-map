export const COMPACT_RELIEF = 'gzip-delta-5cm-v1';
export const PACKED_RELIEF = 'gzip-pack-5cm-v1';
const scale = 20;

function blockLayout(entry) {
  const cells = entry.grid ? entry.grid.columns * entry.grid.rows : 0;
  const maskBytes = Math.ceil(cells / 8);
  const heightCount = entry.grid ? entry.count : 0;
  const sideValues = (entry.grid ? entry.sideCount ?? 0 : entry.count) * 3;
  return {cells, maskBytes, heightCount, sideValues};
}

// Quantized deltas in byte planes let the compressor group the small residuals.
function writeValues(bytes, offset, values, count, stride) {
  const previous = new Int32Array(stride);
  let written = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const axis = written % stride;
    const rounded = Math.round(value * scale);
    const difference = rounded - previous[axis];
    previous[axis] = rounded;
    const code = ((difference << 1) ^ (difference >> 31)) >>> 0;
    for (let plane = 0; plane < 4; plane++) {
      bytes[offset + written + plane * count] = code >>> (plane * 8);
    }
    written++;
  }
  if (written !== count) throw new Error('点阵有效数据数量不符');
}

export function encodeCompactRelief(values, entry) {
  const {cells, maskBytes, heightCount, sideValues} = blockLayout(entry);
  const bytes = new Uint8Array(maskBytes + (heightCount + sideValues) * 4);
  if (values.length !== cells + sideValues) throw new Error('点阵原始块长度不符');
  for (let i = 0; i < cells; i++) {
    if (Number.isFinite(values[i])) bytes[i >> 3] |= 1 << (i & 7);
  }
  writeValues(bytes, maskBytes, values.subarray(0, cells), heightCount, 1);
  writeValues(bytes, maskBytes + heightCount * 4, values.subarray(cells), sideValues, 3);
  return bytes;
}

function deltaAt(bytes, offset, index, count) {
  const code = bytes[offset + index]
    | (bytes[offset + index + count] << 8)
    | (bytes[offset + index + count * 2] << 16)
    | (bytes[offset + index + count * 3] << 24);
  return (code >>> 1) ^ -(code & 1);
}

export function decodeCompactRelief(bytes, entry) {
  const {cells, maskBytes, heightCount, sideValues} = blockLayout(entry);
  if (bytes.length !== maskBytes + (heightCount + sideValues) * 4) {
    throw new Error('紧凑点阵块长度不符');
  }
  const positions = new Float32Array(heightCount * 3 + sideValues);
  let point = 0;
  let height = 0;
  if (entry.grid) {
    const {originX, originZ, columns, spacing} = entry.grid;
    for (let i = 0; i < cells; i++) {
      if (!(bytes[i >> 3] & (1 << (i & 7)))) continue;
      if (point >= heightCount) throw new Error('紧凑点阵网格数量不符');
      height += deltaAt(bytes, maskBytes, point, heightCount);
      positions[point * 3] = originX + (i % columns) * spacing;
      positions[point * 3 + 1] = height / scale;
      positions[point * 3 + 2] = originZ + Math.floor(i / columns) * spacing;
      point++;
    }
  }
  if (point !== heightCount) throw new Error('紧凑点阵网格数量不符');
  const offset = maskBytes + heightCount * 4;
  const previous = new Int32Array(3);
  for (let i = 0; i < sideValues; i++) {
    const axis = i % 3;
    previous[axis] += deltaAt(bytes, offset, i, sideValues);
    positions[heightCount * 3 + i] = previous[axis] / scale;
  }
  return {positions, spacing: entry.grid?.spacing ?? null};
}
