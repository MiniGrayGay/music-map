import {fetchMapDocument, mapDocument} from '../map/releaseData.js';

export const mapLabels = {
  Teyvat: '提瓦特',
  SeaOfBygoneEras: '旧日之海',
  AncientSacredMountain: '远古圣山',
  TheChasm: '层岩巨渊·地下矿区',
  MoonCanon: '霜月',
};

// 独立场景只有平面展示，入场视口由归一化 rect [x, y, w, h] 指定；
// 层岩巨渊以清单里的 map.viewBounds 为准，其余用实测值。
const planeViewBounds = {
  SeaOfBygoneEras: [.28, .33, .47, .40],
  AncientSacredMountain: [.32, .22, .42, .48],
};

export async function loadLayerBases(mainMap) {
  let response;
  try {
    response = await fetchMapDocument(mapDocument.bases);
    if (!response.ok) return {};
    const {format, version, maps} = await response.json();
    if (format !== 'teyvat-layer-bases-v2' || version !== mainMap.dataVersion) return {};
    return Object.fromEntries(Object.entries(maps).flatMap(([name, map]) => {
      if (!Object.hasOwn(mapLabels, name) || name === 'Teyvat') return [];
      const {canvas} = map;
      const pyramid = mainMap.pyramids[name];
      if (!pyramid || pyramid.imageWidth !== canvas.width * 4 || pyramid.imageHeight !== canvas.height * 4) {
        return [];
      }
      const viewBounds = name === 'TheChasm' ? map.viewBounds : planeViewBounds[name];
      return [[name, {canvas, pyramid, seaColor: map.seaColor ?? '#163c4c', dataVersion: version,
        ...(viewBounds ? {viewBounds} : {})}]];
    }));
  } catch {
    return {};
  }
}
