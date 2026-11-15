export const mapLabels = {
  Teyvat: '提瓦特',
  SeaOfBygoneEras: '旧日之海',
  AncientSacredMountain: '远古圣山',
  TempleOfSpace: '空之神殿',
  MoonCanon: '霜月',
};

export async function loadLayerBases(mainMap) {
  let response;
  try {
    response = await fetch('/layers/basemaps.json');
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
      return [[name, {canvas, pyramid, seaColor: map.seaColor ?? '#163c4c', dataVersion: version}]];
    }));
  } catch {
    return {};
  }
}
