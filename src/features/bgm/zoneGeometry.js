// 音乐分区几何：世界坐标环 → 地图画布像素路径。
// 投影合同与 scripts/build-map-data.mjs 主世界一致（provenance.projection）：
//   pixelX = 4096 - worldZ * 0.25 ; pixelY = 3072 - worldX * 0.25
// 只做投影与构路，环点保持清单原始值（原始 polygon 直接显示，不化简不改形）。

const PIXEL_ORIGIN_X = 4096;
const PIXEL_ORIGIN_Y = 3072;
const WORLD_TO_PIXEL_SCALE = 0.25;

export function projectWorldPoint([worldX, worldZ], origin = [PIXEL_ORIGIN_X, PIXEL_ORIGIN_Y]) {
  return [
    origin[0] - worldZ * WORLD_TO_PIXEL_SCALE,
    origin[1] - worldX * WORLD_TO_PIXEL_SCALE,
  ];
}

// 整组环投影到画布像素坐标（RegionLines 以像素 rings 画共享单线）。
export function projectRings(rings, origin) {
  return rings.map((ring) => ring.map((point) => projectWorldPoint(point, origin)));
}

// 多环 → 单 path 的 M…L…Z 子路径序列；配合 fill-rule="evenodd" 内环即成为洞。
export function ringsPathData(rings, origin) {
  return rings.map((ring) => {
    const [first, ...rest] = ring.map((point) => projectWorldPoint(point, origin));
    return `M ${first[0]} ${first[1]}${rest.map(([x, y]) => ` L ${x} ${y}`).join('')} Z`;
  }).join(' ');
}

export function ringsBBox(rings, origin) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      const [x, y] = projectWorldPoint(point, origin);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}
