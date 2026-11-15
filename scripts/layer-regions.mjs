import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const vector = (value) => object(value) && ['x', 'y', 'z'].every((axis) =>
  Number.isFinite(value[`_${axis}`] ?? value[axis]));
const coordinate = (value, axis) => value[`_${axis}`] ?? value[axis];
const rowList = (value) => Array.isArray(value) && value.length > 0 && value.every(object);
const vertices = (value) => Array.isArray(value) && value.length >= 3 && value.every(vector);
const hasVertices = (row) => Object.values(row).some(vertices);
const extent = (points, axis) => {
  const values = points.map((entry) => coordinate(entry, axis));
  return [Math.min(...values), Math.max(...values)];
};

export async function loadLayerRegions(directory, knownLayers) {
  const files = new Map();
  const tally = new Map();
  for (const filename of (await readdir(directory)).filter((file) => /^\d+\.json$/.test(file)).sort()) {
    const raw = await readFile(path.join(directory, filename), 'utf8');
    const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const tables = Object.values(value).filter(rowList);
    if (tables.length > 1) throw new Error(`楼层区域表不能唯一定位 ${filename}`);
    if (!tables.length) continue;
    const [rows] = tables;
    files.set(filename, rows);
    for (const row of rows) {
      for (const shape of Object.values(row).filter(rowList).flat().filter((item) => !hasVertices(item))) {
        for (const [key, point] of Object.entries(shape).filter(([, item]) => vector(item))) {
          if (!tally.has(key)) tally.set(key, {nonzero: 0, zero: 0});
          const isPosition = ['x', 'y', 'z'].some((axis) => coordinate(point, axis) !== 0);
          tally.get(key)[isPosition ? 'nonzero' : 'zero'] += 1;
        }
      }
    }
  }
  const positionKeys = [...tally].filter(([, count]) => count.nonzero >= 100 && count.zero === 0);
  if (positionKeys.length !== 1) throw new Error('限位形状的世界中心字段不能唯一定位');
  const positionKey = positionKeys[0][0];
  const regions = new Map();
  for (const [filename, rows] of files) {
    const idKeys = new Set(rows.flatMap(Object.entries)
      .filter(([, value]) => Number.isSafeInteger(value) && knownLayers.has(value))
      .map(([key]) => key));
    if (!idKeys.size) continue;
    if (idKeys.size !== 1) throw new Error(`楼层区域表编号不能唯一定位 ${filename}`);
    const [idKey] = idKeys;
    for (const row of rows) {
      const id = row[idKey];
      if (!knownLayers.has(id)) continue;
      const points = [];
      const centers = [];
      let polygonCount = 0;
      let limitShapeCount = 0;
      for (const list of Object.values(row).filter(rowList)) {
        if (list.some(hasVertices)) {
          polygonCount += list.length;
          for (const shape of list) {
            for (const field of Object.values(shape)) {
              if (vertices(field)) points.push(...field);
              else if (vector(field)) points.push(field);
            }
          }
        } else if (list.every((shape) => Object.values(shape).some(vector))) {
          limitShapeCount += list.length;
          centers.push(...list.map((shape) => shape[positionKey]).filter(vector));
        }
      }
      if (!points.length && !centers.length) continue;
      const [left, right] = extent(points, 'x');
      const [top, bottom] = extent(points, 'z');
      regions.set(id, {
        yRange: extent([...points, ...centers], 'y'),
        xzBounds: points.length ? [left, top, right, bottom] : null,
        polygonCount,
        limitShapeCount,
        source: `BinOutput/MultilayerMapRegion/${filename}`,
      });
    }
  }
  return {regions, positionKey, evidence: Object.fromEntries(tally)};
}
