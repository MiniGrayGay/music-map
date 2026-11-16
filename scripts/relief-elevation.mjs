import {decodeTerrainHeight} from '../../teyvat-map-editor/src/terrainHeightfield.js';
import {readSurfaceTerrain} from './bgm-surface-terrain.mjs';

// Remove the neighborhood where the older height grid could spread a single rooftop vertex.
export function modeledFootprint(points, grid, elevation) {
  const {columns, rows, originX, originZ, spacing} = grid;
  const covered = new Uint8Array(columns * rows);
  for (const [x, y, z] of points) {
    const col = Math.round((x - originX) / spacing), row = Math.round((z - originZ) / spacing);
    if (col < 0 || col >= columns || row < 0 || row >= rows || y < elevation(x, z) + .6) continue;
    for (let v = Math.max(0, row - 3); v <= Math.min(rows - 1, row + 3); v++) {
      const from = v * columns + Math.max(0, col - 3);
      const to = v * columns + Math.min(columns - 1, col + 3) + 1;
      covered.fill(1, from, to);
    }
  }
  return covered;
}

export async function loadReliefElevation(clientSha256, regions) {
  const terrain = await readSurfaceTerrain(clientSha256);
  const tiles = regions ? terrain.tiles.filter((tile) => regions.some(({bounds}) =>
    tile.x0 <= bounds.maxX && tile.x1 >= bounds.minX && tile.z0 <= bounds.maxZ && tile.z1 >= bounds.minZ)) : terrain.tiles;
  const surface = new Map(await Promise.all(tiles.map(async (tile) =>
    [tile.tile.join('/'), {tile, bytes: await terrain.samples(tile)}])));
  return (x, z) => {
    const entry = surface.get(`${Math.floor(x / 1024)}/${Math.floor(z / 1024)}`);
    if (!entry) return NaN;
    const {tile, bytes} = entry;
    const u = (x - tile.x0) / 2, v = (z - tile.z0) / 2;
    const col = Math.floor(u), row = Math.floor(v);
    const width = tile.heightResolution;
    if (col < 0 || row < 0 || col + 1 >= width || row + 1 >= width) return NaN;
    const offset = (row * width + col) * 2;
    const a = bytes.readUInt16LE(offset), b = bytes.readUInt16LE(offset + 2);
    const c = bytes.readUInt16LE(offset + width * 2), d = bytes.readUInt16LE(offset + width * 2 + 2);
    const dx = u - col, dz = v - row;
    return decodeTerrainHeight((a + (b - a) * dx) * (1 - dz) + (c + (d - c) * dx) * dz) + tile.yOffset;
  };
}
