import {clamp, viewAtlasPoints} from './projection.js';

const TILE = 512;
const MIP_LEVELS = Math.log2(TILE) + 1;
export function detailTextures(gl, mapUnit = 1, atlasUnit = 2) {
  const map = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + mapUnit);
  gl.bindTexture(gl.TEXTURE_2D, map);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
  const atlas = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + atlasUnit);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.activeTexture(gl.TEXTURE0);
  return {map, atlas, mapUnit, atlasUnit};
}

export class DetailTiles {
  constructor(gl, textures, invalidate, {capacity, concurrency, compact, native = false}) {
    Object.assign(this, {gl, textures, invalidate, capacity, concurrency, compact, native});
    this.size = [0, 0];
    this.inflight = 0;
    this.reset(null, 0);
  }

  reset(world, zoom) {
    for (const controller of this.pending?.values() ?? []) controller.abort();
    this.world = world;
    this.zoom = zoom;
    this.revision = {};
    this.visible = new Map();
    this.slots = new Map();
    this.pending = new Map();
    this.failed = new Set();
    this.lastView = '';
    if (!zoom) {
      this.size = [0, 0];
      return;
    }
    const raster = this.native ? world.pyramid.native : world.pyramid;
    const {imageWidth, imageHeight, maxDim} = raster;
    const factor = this.native ? 1 : 2 ** zoom * TILE / maxDim;
    this.size = [Math.ceil(imageWidth * factor), Math.ceil(imageHeight * factor)];
    this.sourceIdentity = raster.sourceIdentity;
    this.nativeKeys = this.native ? new Set(raster.tiles) : null;
    this.columns = Math.ceil(this.size[0] / TILE);
    this.rows = Math.ceil(this.size[1] / TILE);
    this.lookup = new Uint8Array(this.columns * this.rows);
    this.lookupDirty = false;
    this.lookupReady = false;
    this.uploadLookup();
  }

  update(world, view) {
    const maxZoom = world.pyramid.maxTileZoom;
    const native = world.pyramid.native;
    // 手机屏幕像素少，2048 细节与桌面同门槛即可及时换清晰纹理，容量仍受紧凑限制。
    const nativeThreshold = view.focused ? 1.85 : 3.8;
    const eligible = native && world.projection !== 2 && view.zoom >= nativeThreshold;
    const level = this.native ? (eligible ? native.level : 0) : maxZoom > 3 && view.zoom >= 1.85
      ? Math.min(maxZoom, view.zoom >= 3.45 ? 5 : 4)
      : 0;
    if (world !== this.world || level !== this.zoom) this.reset(world, level);
    if (!level) return;
    const signature = [view.width, view.height, Math.round(view.cx), Math.round(view.cy),
      view.lon.toFixed(3), view.lat.toFixed(3), view.zoom.toFixed(3)].join('/');
    if (signature === this.lastView) return;
    this.lastView = signature;
    const {cx, cy, radius, basis, width, height} = view;
    const candidates = new Map();
    const left = Math.max(0, cx - radius);
    const right = Math.min(width, cx + radius);
    const top = Math.max(0, cy - radius);
    const bottom = Math.min(height, cy + radius);
    // 紧凑网格过稀会让盘面只剩零星清晰瓦片、其余回落低清图集（块状观感）；
    // 8×12 覆盖可见盘面，加载量仍由 capacity 与 concurrency 约束。
    const rows = this.compact ? 8 : 10;
    const columns = this.compact ? 12 : 15;
    for (let row = 0; row <= rows; row += 1) {
      for (let col = 0; col <= columns; col += 1) {
        const x = (left + (right - left) * col / columns - cx) / radius;
        const y = (cy - top - (bottom - top) * row / rows) / radius;
        if (x * x + y * y > .998) continue;
        for (const [u, v] of viewAtlasPoints(world, basis, view.zoom, x, y)) {
          if (u < 0 || u > 1 || v < 0 || v > 1) continue;
          const tx = clamp(Math.floor(u * this.size[0] / TILE), 0, this.columns - 1);
          const ty = clamp(Math.floor(v * this.size[1] / TILE), 0, this.rows - 1);
          if (this.nativeKeys && !this.nativeKeys.has(`${tx}/${ty}`)) continue;
          const key = ty * this.columns + tx;
          const distance = x * x + y * y;
          if ((candidates.get(key) ?? Infinity) > distance) candidates.set(key, distance);
        }
      }
    }
    this.visible = new Map([...candidates].sort((a, b) => a[1] - b[1]).slice(0, this.capacity));
    for (const [key, controller] of this.pending) if (!this.visible.has(key)) controller.abort();
    this.pump();
  }

  pump() {
    for (const key of this.visible.keys()) {
      if (this.inflight >= this.concurrency) break;
      if (this.slots.has(key) || this.pending.has(key) || this.failed.has(key)) continue;
      this.inflight += 1;
      const controller = new AbortController();
      this.pending.set(key, controller);
      const revision = this.revision;
      const x = key % this.columns;
      const y = Math.floor(key / this.columns);
      const url = './tiles/' + this.world.id + '/' + this.zoom + '/' + x + '/' + y + '.webp?v=' + this.sourceIdentity.slice(0, 12);
      void this.load(url, key, revision, controller);
    }
  }

  async load(url, key, revision, controller) {
    let image;
    try {
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      image = await createImageBitmap(await response.blob(), {premultiplyAlpha: 'none'});
      if (revision === this.revision && !controller.signal.aborted && this.visible.has(key)) {
        this.uploadTile(key, image);
      }
    } catch (error) {
      if (revision === this.revision && !controller.signal.aborted) this.failed.add(key);
    } finally {
      image?.close();
      this.inflight -= 1;
      if (revision === this.revision) this.pending.delete(key);
      this.pump();
    }
  }

  uploadTile(key, image) {
    let expired;
    let slot = 0;
    if (this.slots.size >= this.capacity) {
      expired = [...this.slots.keys()].find((other) => !this.visible.has(other));
      if (expired === undefined) return;
      slot = this.slots.get(expired);
    } else {
      const used = new Set(this.slots.values());
      while (used.has(slot)) slot += 1;
    }
    try {
      this.writeTile(slot, image);
    } catch (error) {
      this.gl.activeTexture(this.gl.TEXTURE0);
      if (expired !== undefined) {
        this.slots.delete(expired);
        this.lookup[expired] = 0;
        this.lookupDirty = true;
        this.invalidate();
      }
      throw error;
    }
    if (expired !== undefined) {
      this.slots.delete(expired);
      this.lookup[expired] = 0;
    }
    this.slots.set(key, slot);
    this.lookup[key] = slot + 1;
    // 同一帧内多张瓦片完成时只标记脏区，由 draw 入口的 flushLookup 在下次
    // 绘制前合并成一次 texSubImage2D；uploadTile 本身不再逐瓦片重传 lookup。
    this.lookupDirty = true;
    this.invalidate();
  }

  writeTile(slot, image) {
    const {gl, textures} = this;
    gl.activeTexture(gl.TEXTURE0 + textures.atlasUnit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, textures.atlas);
    if (!this.allocated) {
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, MIP_LEVELS, gl.RGBA8, TILE, TILE, this.capacity);
      // The map also uploads base textures on this context. A queued error
      // from one of those uploads must not trigger another immutable allocation.
      if (gl.getError() !== gl.NO_ERROR
        && !gl.getTexParameter(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_IMMUTABLE_FORMAT)) {
        throw new Error('Cannot allocate tile texture array');
      }
      this.allocated = true;
    }
    // Generate each tile's mip chain in a 2D staging texture. The read
    // framebuffer never attaches the texture array being written.
    if (!this.stagingTexture) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, MIP_LEVELS, gl.RGBA8, TILE, TILE);
      if (gl.getError() !== gl.NO_ERROR
        && !gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_IMMUTABLE_FORMAT)) {
        gl.deleteTexture(texture);
        throw new Error('Cannot allocate tile staging texture');
      }
      this.stagingTexture = texture;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.stagingTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.stagingRead ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.stagingRead);
    for (let level = 0, size = TILE; level < MIP_LEVELS; level += 1, size /= 2) {
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, this.stagingTexture, level);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, slot, 0, 0, size, size);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Cannot upload complete tile mip chain');
  }

  uploadLookup() {
    const {gl, textures} = this;
    gl.activeTexture(gl.TEXTURE0 + textures.mapUnit);
    gl.bindTexture(gl.TEXTURE_2D, textures.map);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.columns, this.rows, 0, gl.RED, gl.UNSIGNED_BYTE, this.lookup);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
    this.lookupReady = true;
    this.lookupDirty = false;
  }

  // 把批次内累计的 lookup 改动用一次 texSubImage2D 写入既有存储，
  // 须在每个 draw 的渲染前调用（存储尺寸只会随 reset 的整次重定义变化）。
  flushLookup() {
    if (!this.lookupDirty) return;
    if (!this.lookupReady) {
      this.uploadLookup();
      return;
    }
    this.lookupDirty = false;
    const {gl, textures} = this;
    gl.activeTexture(gl.TEXTURE0 + textures.mapUnit);
    gl.bindTexture(gl.TEXTURE_2D, textures.map);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.columns, this.rows, gl.RED, gl.UNSIGNED_BYTE, this.lookup);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
  }
}
