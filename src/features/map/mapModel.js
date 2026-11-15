// 地图视口纯逻辑：适屏、锚点缩放、平移边界与可见瓦片范围。
// 世界层是一块 canvas.width × canvas.height 的固定画布，用 CSS transform
// translate + scale 显示；scale=1 时一个世界像素对应一个 CSS 像素。

export const MAX_SCALE = 8; // 2048px 原生瓦片 ÷ 256 放置单位，放大到此为原生像素
const PAN_BLEED = 160;      // 平移时画布边缘允许超出视口的最大空白

export function fitTransform(viewport, canvas, padding) {
  const scale = Math.min(
    (viewport.width - padding * 2) / canvas.width,
    (viewport.height - padding * 2) / canvas.height,
  );
  return {
    scale,
    tx: (viewport.width - canvas.width * scale) / 2,
    ty: (viewport.height - canvas.height * scale) / 2,
  };
}

export function minScale(viewport, canvas, padding) {
  // 适屏比例即最小缩放：再小只会出现无内容的大片空白。
  return fitTransform(viewport, canvas, padding).scale;
}

export function clampTransform(transform, viewport, canvas, min, max = MAX_SCALE) {
  const scale = Math.min(Math.max(transform.scale, min), max);
  const worldWidth = canvas.width * scale;
  const worldHeight = canvas.height * scale;
  let tx;
  let ty;
  if (worldWidth <= viewport.width) {
    tx = (viewport.width - worldWidth) / 2;
  } else {
    tx = Math.min(Math.max(transform.tx, viewport.width - worldWidth - PAN_BLEED), PAN_BLEED);
  }
  if (worldHeight <= viewport.height) {
    ty = (viewport.height - worldHeight) / 2;
  } else {
    ty = Math.min(Math.max(transform.ty, viewport.height - worldHeight - PAN_BLEED), PAN_BLEED);
  }
  return {scale, tx, ty};
}

// 以屏幕坐标 anchor 为锚缩放：锚点下的世界内容保持在原位。
export function zoomAt(transform, viewport, anchor, factor, min, max = MAX_SCALE) {
  const target = Math.min(Math.max(transform.scale * factor, min), max);
  const scale = target / transform.scale;
  return {
    scale: target,
    tx: anchor.x - (anchor.x - transform.tx) * scale,
    ty: anchor.y - (anchor.y - transform.ty) * scale,
  };
}

export function rasterPosition(transform, x, y, width, height, overlap = 0) {
  const {scale, tx, ty} = transform;
  return {
    left: `${tx + x * scale}px`,
    top: `${ty + y * scale}px`,
    width: `${width * scale + overlap}px`,
    height: `${height * scale + overlap}px`,
  };
}

export function panBy(transform, dx, dy) {
  return {scale: transform.scale, tx: transform.tx + dx, ty: transform.ty + dy};
}

// 视口（CSS 像素）→ 世界像素矩形。
export function viewportWorldRect(transform, viewport) {
  return {
    x: (0 - transform.tx) / transform.scale,
    y: (0 - transform.ty) / transform.scale,
    width: viewport.width / transform.scale,
    height: viewport.height / transform.scale,
  };
}

// 当前视口覆盖到的瓦片格（row/col 闭区间），四周各多备一圈。
export function visibleGrid(transform, viewport, canvas, block, grid) {
  const rect = viewportWorldRect(transform, viewport);
  const colAt = (worldX) => grid.maxCol - Math.floor(worldX / block);
  const rowAt = (worldY) => grid.maxRow - Math.floor(worldY / block);
  // left=(maxCol-col)*block → col = maxCol - left/block；left∈[rect.x, rect.x+w)
  const minCol = Math.max(grid.minCol, colAt(rect.x + rect.width) - 1);
  const maxCol = Math.min(grid.maxCol, colAt(rect.x) + 1);
  const minRow = Math.max(grid.minRow, rowAt(rect.y + rect.height) - 1);
  const maxRow = Math.min(grid.maxRow, rowAt(rect.y) + 1);
  return {minRow, maxRow, minCol, maxCol};
}
