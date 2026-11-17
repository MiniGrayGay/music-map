// 瓦片 mipmap worker：持有复用的 512² OffscreenCanvas 2D 上下文（worker 内无 DOM）。
// 请求 {id, blob} → 成功 {id, image, mipmaps}（transfer 二者），解码失败 {id, error}，
// 环境不可用（OffscreenCanvas/2D 上下文为 null 或 transfer 失败）{id, unavailable: true}。

import { TILE_SIZE, decodeTileMipmaps } from './tileMipData.js';

let ctx = null;
function getContext() {
  if (!ctx) {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return ctx;
}

self.onmessage = async (event) => {
  const { id, blob } = event.data;
  let context;
  try {
    context = getContext();
    if (!context) {
      self.postMessage({ id, unavailable: true });
      return;
    }
  } catch (err) {
    self.postMessage({ id, unavailable: true });
    return;
  }
  try {
    const { image, mipmaps } = await decodeTileMipmaps(blob, context);
    try {
      self.postMessage({ id, image, mipmaps }, [image, mipmaps.buffer]);
    } catch (err) {
      // transfer 失败属环境不可用，全局回退；此时关闭位图避免泄漏
      image.close();
      self.postMessage({ id, unavailable: true });
    }
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
