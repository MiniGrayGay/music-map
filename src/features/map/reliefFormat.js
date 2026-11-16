export function reliefBlockBytes(entry) {
  const grid = entry.grid;
  if (!grid) return entry.count * 12;
  const sideCount = entry.sideCount ?? 0;
  if (![grid.columns, grid.rows].every((size) => Number.isInteger(size) && size > 0 && size <= 1024)
    || ![grid.originX, grid.originZ, grid.spacing].every(Number.isFinite) || grid.spacing <= 0
    || !Number.isSafeInteger(sideCount) || sideCount < 0 || sideCount > 65536
    || entry.count > grid.columns * grid.rows) throw new Error('分区等距网格无效');
  return grid.columns * grid.rows * 4 + sideCount * 12;
}

export function decodeReliefBlock(buffer, entry, offset = 0) {
  const grid = entry.grid;
  if (!grid) return {positions: new Float32Array(buffer, offset, entry.count * 3), spacing: null};
  const elevations = new Float32Array(buffer, offset, grid.columns * grid.rows);
  const baseLength = entry.count * 3;
  const sides = new Float32Array(buffer, offset + elevations.byteLength, (entry.sideCount ?? 0) * 3);
  const positions = new Float32Array(baseLength + sides.length);
  let write = 0;
  for (let i = 0; i < elevations.length; i++) {
    const height = elevations[i];
    if (Number.isNaN(height)) continue;
    if (!Number.isFinite(height) || write >= baseLength) throw new Error('分区等距网格数据不完整');
    positions[write++] = grid.originX + (i % grid.columns) * grid.spacing;
    positions[write++] = height;
    positions[write++] = grid.originZ + Math.floor(i / grid.columns) * grid.spacing;
  }
  if (write !== baseLength) throw new Error('分区等距网格点数不一致');
  if (!sides.every(Number.isFinite)) throw new Error('分区侧面点阵含无效坐标');
  positions.set(sides, baseLength);
  return {positions, spacing: grid.spacing};
}
