// 瓦片 mipmap 数据：整数 RGBA8 box filter，纯函数，无 DOM/Worker 依赖。
// 输出为 level 1..9 连续紧排的 Uint8Array（level 0 由原始位图直接上传）。

export const TILE_SIZE = 512;
export const MIP_LEVELS = 10;

// level 1..9 各层字节数与起始偏移（RGBA8，逐层减半）
const MIP_OFFSETS = (() => {
  const offsets = new Uint32Array(MIP_LEVELS);
  let offset = 0;
  for (let level = 1; level < MIP_LEVELS; level++) {
    offsets[level] = offset;
    offset += (TILE_SIZE >> level) * (TILE_SIZE >> level) * 4;
  }
  return offsets;
})();

const MIP_TOTAL_BYTES = MIP_OFFSETS[MIP_LEVELS - 1] + 1 * 1 * 4;

// rgba: 512*512*4 的 Uint8Array 或 Uint8ClampedArray（未预乘 RGBA，后者为 getImageData 返回类型）。
// 返回 level 1..9 紧排结果。
export function buildTileMipmaps(rgba) {
  const isBytes = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray;
  if (!isBytes || rgba.length !== TILE_SIZE * TILE_SIZE * 4) {
    throw new Error(`buildTileMipmaps: expected Uint8Array(${TILE_SIZE * TILE_SIZE * 4}), got length ${rgba && rgba.length}`);
  }
  const out = new Uint8Array(MIP_TOTAL_BYTES);
  let src = rgba;
  let srcSize = TILE_SIZE;
  for (let level = 1; level < MIP_LEVELS; level++) {
    const size = srcSize >> 1;
    const dst = out.subarray(MIP_OFFSETS[level], MIP_OFFSETS[level] + size * size * 4);
    const srcStride = srcSize * 4;
    for (let y = 0; y < size; y++) {
      const row0 = y * 2 * srcStride;
      const row1 = row0 + srcStride;
      let s0 = row0;
      let s1 = row0 + 4;
      let s2 = row1;
      let s3 = row1 + 4;
      let d = y * size * 4;
      for (let x = 0; x < size; x++) {
        for (let c = 0; c < 4; c++) {
          dst[d + c] = (src[s0 + c] + src[s1 + c] + src[s2 + c] + src[s3 + c] + 2) >> 2;
        }
        s0 += 8; s1 += 8; s2 += 8; s3 += 8;
        d += 4;
      }
    }
    src = dst;
    srcSize = size;
  }
  return out;
}

// 主线程/worker 通用：blob → {image, mipmaps}。context 为调用方持有的复用 512² 2D 上下文。
export async function decodeTileMipmaps(blob, context) {
  let image = null;
  try {
    image = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
    if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) {
      throw new Error(`tile size mismatch: ${image.width}x${image.height}`);
    }
    // 部分真实源瓦片含透明像素，默认 'source-over' 会保留上一张瓦片残留，先整幅清空
    context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    const mipmaps = buildTileMipmaps(rgba);
    return { image, mipmaps };
  } catch (err) {
    if (image) image.close();
    throw err;
  }
}
