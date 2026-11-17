// 瓦片 mipmap 加载器：球面两套缓存共享的单例 module worker；worker 不可用时
// 永久回退到主线程复用 document canvas 的同一 CPU 算法。并发由调用方限流。

import { TILE_SIZE, decodeTileMipmaps } from './tileMipData.js';

let worker = null;
let workerFailed = false;
let pendingId = 0;
const pending = new Map(); // id → {resolve, reject, blob, signal, onAbort}

function ensureWorker() {
  if (workerFailed) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    workerFailed = true;
    return null;
  }
  try {
    worker = new Worker(new URL('./tileMipWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, image, mipmaps, error, unavailable } = event.data || {};
      const entry = pending.get(id);
      if (unavailable) {
        // worker 内 OffscreenCanvas/2D 上下文或 transfer 失败：终止并永久回退
        killWorker();
        const entries = [...pending.values()];
        pending.clear();
        fallbackEntries(entries);
        return;
      }
      if (!entry) {
        if (image) image.close();
        return;
      }
      pending.delete(id);
      if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort);
      if (error) {
        if (image) image.close();
        entry.reject(new Error(error));
      } else {
        entry.resolve({ image, mipmaps });
      }
    };
    const onWorkerFailure = (event) => {
      // 初始化或运行期失败：终止并永久回退，挂起请求改走本地解码
      killWorker();
      const entries = [...pending.values()];
      pending.clear();
      fallbackEntries(entries);
      if (event) event.preventDefault?.();
    };
    worker.onerror = onWorkerFailure;
    worker.onmessageerror = onWorkerFailure;
    return worker;
  } catch (err) {
    workerFailed = true;
    return null;
  }
}

// 回退处理：已中止的直接拒绝；其余改走本地解码（decodeLocally 内部仍会复查 signal）
function fallbackEntries(entries) {
  for (const entry of entries) {
    if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort);
    if (entry.signal && entry.signal.aborted) {
      entry.reject(new DOMException('aborted', 'AbortError'));
    } else {
      decodeLocally(entry.blob, entry.signal).then(entry.resolve, entry.reject);
    }
  }
}

function killWorker() {
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    worker = null;
  }
  workerFailed = true;
}

let localCtx = null;
function getLocalContext() {
  if (!localCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    localCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return localCtx;
}

async function decodeLocally(blob, signal) {
  const { image, mipmaps } = await decodeTileMipmaps(blob, getLocalContext());
  if (signal && signal.aborted) {
    image.close();
    throw new DOMException('aborted', 'AbortError');
  }
  return { image, mipmaps };
}

export function loadTileMipmaps(blob, signal) {
  if (signal && signal.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }
  const useWorker = ensureWorker();
  if (!useWorker) {
    return decodeLocally(blob, signal);
  }
  return new Promise((resolve, reject) => {
    const id = ++pendingId;
    const onAbort = () => {
      pending.delete(id);
      // 迟到的 worker 结果回来时因无条目而关闭位图
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: (value) => { if (signal) signal.removeEventListener('abort', onAbort); resolve(value); },
      reject: (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); },
      blob,
      signal,
      onAbort,
    });
    try {
      useWorker.postMessage({ id, blob });
    } catch (err) {
      // postMessage 同步失败（如结构化克隆不支持）：删条目、摘监听，走同一本地解码
      pending.delete(id);
      if (signal) signal.removeEventListener('abort', onAbort);
      decodeLocally(blob, signal).then(resolve, reject);
    }
  });
}
