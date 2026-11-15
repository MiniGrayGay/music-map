import initGeos from 'geos-wasm';
import {geojsonToGeosGeom} from 'geos-wasm/helpers';

const geos = await initGeos();
const types = geos.GEOSGeomTypes;
const owned = [];
const value = geos.Module._malloc(16);

class Geometry {
  constructor(pointer) {
    if (!pointer) throw new Error('GEOS 无法生成几何对象');
    this.pointer = pointer;
  }

  isEmpty() {
    return predicate(geos.GEOSisEmpty(this.pointer));
  }

  getArea() {
    if (!geos.GEOSArea(this.pointer, value)) throw new Error('GEOS 无法计算面积');
    return geos.Module.getValue(value, 'double');
  }
}

function own(pointer) {
  const shape = new Geometry(pointer);
  owned.push(pointer);
  return shape;
}

function predicate(result) {
  if (result !== 0 && result !== 1) throw new Error('GEOS 几何判定失败');
  return result === 1;
}

export const geometryMark = () => owned.length;
export function releaseGeometries(mark = 0) {
  while (owned.length > mark) geos.GEOSGeom_destroy(owned.pop());
}

process.once('exit', () => {
  releaseGeometries();
  geos.Module._free(value);
});

function collection(shapes, type) {
  const array = geos.Module._malloc(Math.max(1, shapes.length) * 4);
  try {
    shapes.forEach(({pointer}, index) => {
      geos.Module.HEAPU32[array / 4 + index] = geos.GEOSGeom_clone(pointer);
    });
    return own(geos.GEOSGeom_createCollection(type, array, shapes.length));
  } finally {
    geos.Module._free(array);
  }
}

export const lineFromPoints = (coordinates) => own(geojsonToGeosGeom({type: 'LineString', coordinates}, geos));
export const pointAt = (x, z) => own(geos.GEOSGeom_createPointFromXY(x, z));
export const rectangle = (x1, x2, z1, z2) => own(geos.GEOSGeom_createRectangle(x1, z1, x2, z2));
export const emptyPolygon = () => own(geos.GEOSGeom_createEmptyPolygon());
export const covers = (a, b) => predicate(geos.GEOSCovers(a.pointer, b.pointer));
export const intersects = (a, b) => predicate(geos.GEOSIntersects(a.pointer, b.pointer));
export const difference = (a, b) => own(geos.GEOSDifference(a.pointer, b.pointer));
export const intersection = (a, b) => own(geos.GEOSIntersection(a.pointer, b.pointer));
export const symmetricDifference = (a, b) => own(geos.GEOSSymDifference(a.pointer, b.pointer));
export const sameGeometry = (a, b) => predicate(geos.GEOSEquals(a.pointer, b.pointer));

export function union(geometry) {
  return own(geos.GEOSUnaryUnion(collection(geometry, types.GEOS_GEOMETRYCOLLECTION).pointer));
}

export function polygonFromRings(rings) {
  const coordinates = rings.map((ring) => {
    const [firstX, firstZ] = ring[0];
    const [lastX, lastZ] = ring.at(-1);
    return firstX === lastX && firstZ === lastZ ? ring : [...ring, ring[0]];
  });
  const polygon = own(geojsonToGeosGeom({type: 'Polygon', coordinates}, geos));
  return own(geos.GEOSMakeValid(polygon.pointer));
}

export function filledRings(rings) {
  return rings.reduce((shape, ring) => symmetricDifference(shape, polygonFromRings([ring])),
    emptyPolygon());
}

const geometryTypes = {Polygon: types.GEOS_POLYGON, LineString: types.GEOS_LINESTRING};
export function components(shape, type) {
  const ownType = geos.GEOSGeomTypeId(shape.pointer);
  if (ownType === geometryTypes[type]) return shape.isEmpty() ? [] : [shape];
  if (ownType < types.GEOS_MULTIPOINT) return [];
  const count = geos.GEOSGetNumGeometries(shape.pointer);
  return Array.from({length: count}, (_, index) => components(
    new Geometry(geos.GEOSGetGeometryN(shape.pointer, index)), type,
  )).flat();
}

export const polygonsOnly = (shape) => collection(components(shape, 'Polygon'), types.GEOS_MULTIPOLYGON);
export function polygonRings(shape) {
  return components(shape, 'Polygon').flatMap(({pointer}) => [
    new Geometry(geos.GEOSGetExteriorRing(pointer)),
    ...Array.from({length: geos.GEOSGetNumInteriorRings(pointer)}, (_, index) =>
      new Geometry(geos.GEOSGetInteriorRingN(pointer, index))),
  ]);
}

export function pointsFromLine(line, {omitClosing = false} = {}) {
  const sequence = geos.GEOSGeom_getCoordSeq(line.pointer);
  if (!sequence || !geos.GEOSCoordSeq_getSize(sequence, value)) throw new Error('GEOS 无法读取边线');
  const size = geos.Module.getValue(value, 'i32') - (omitClosing ? 1 : 0);
  return Array.from({length: size}, (_, index) => {
    if (!geos.GEOSCoordSeq_getXY(sequence, index, value, value + 8)) {
      throw new Error('GEOS 无法读取边线坐标');
    }
    return [geos.Module.getValue(value, 'double'), geos.Module.getValue(value + 8, 'double')];
  });
}

export function compareSourceOrder(a, b) {
  for (let index = 0; index < Math.min(a.order.length, b.order.length); index += 1) {
    if (a.order[index] !== b.order[index]) return a.order[index] - b.order[index];
  }
  return a.order.length - b.order.length;
}

export const roundPositions = (points) => points.map((pair) =>
  pair.map((number) => Number(number.toFixed(5))));
