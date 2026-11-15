<script setup>
import {onBeforeUnmount, onMounted, ref, watch} from 'vue';

const props = defineProps({
  mapName: {type: String, required: true},
  pyramid: {type: Object, required: true},
  canvas: {type: Object, required: true},
  viewport: {type: Object, required: true},
  transform: {type: Object, required: true},
  seaColor: {type: String, required: true},
});

const surface = ref(null);
const bitmaps = new Map();
const requested = new Map();
const failures = new Set();
const CACHE_LIMIT = 160;
const CONCURRENCY = 8;
let frameId = 0;
let visible = [];
let active = true;

const keyFor = (z, x, y) => `${z}/${x}/${y}`;

function dirty() {
  if (active && !frameId) frameId = requestAnimationFrame(draw);
}

function readTile(key) {
  const image = bitmaps.get(key);
  if (!image) return null;
  bitmaps.delete(key);
  bitmaps.set(key, image);
  return image;
}

async function fetchTile(key) {
  const controller = new AbortController();
  requested.set(key, controller);
  try {
    const version = props.pyramid.sourceIdentity.slice(0, 12);
    const response = await fetch(`/tiles/${props.mapName}/${key}.webp?v=${version}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const image = await createImageBitmap(await response.blob());
    if (!active) {
      image.close();
      return;
    }
    bitmaps.set(key, image);
    while (bitmaps.size > Math.max(CACHE_LIMIT, visible.length + 24)) {
      const oldest = bitmaps.keys().next().value;
      if (oldest === keyFor(0, 0, 0)) {
        readTile(oldest);
        continue;
      }
      bitmaps.get(oldest).close();
      bitmaps.delete(oldest);
    }
  } catch (error) {
    if (error.name !== 'AbortError' && active) {
      failures.add(key);
      surface.value.dataset.failed = key;
    }
  } finally {
    requested.delete(key);
    dirty();
  }
}

function schedule() {
  const root = keyFor(0, 0, 0);
  const next = new Set([root, ...visible.map((tile) => tile.key)]);
  for (const [key, controller] of requested) {
    if (!next.has(key)) controller.abort();
  }
  for (const key of next) {
    if (requested.size >= CONCURRENCY) break;
    if (!bitmaps.has(key) && !requested.has(key) && !failures.has(key)) {
      void fetchTile(key);
    }
  }
}

function drawTile(ctx, tile, level) {
  const {z, x, y, key, left, top, width, height} = tile;
  const whole = readTile(key);
  if (whole) {
    ctx.drawImage(whole, left, top, width, height);
    return true;
  }
  for (let ancestor = z - 1; ancestor >= 0; ancestor -= 1) {
    const ratio = 2 ** (z - ancestor);
    const image = readTile(keyFor(ancestor, Math.floor(x / ratio), Math.floor(y / ratio)));
    if (!image) continue;
    const sourceSize = level.tileSize / ratio;
    ctx.drawImage(image, (x % ratio) * sourceSize, (y % ratio) * sourceSize,
      sourceSize, sourceSize, left, top, width, height);
    break;
  }
  return false;
}

function draw() {
  frameId = 0;
  const element = surface.value;
  if (!element || !props.viewport.width || !props.viewport.height) return;
  const level = props.pyramid;
  const {width, height} = props.viewport;
  const {tx, ty, scale} = props.transform;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rasterWidth = Math.round(width * dpr);
  const rasterHeight = Math.round(height * dpr);
  if (element.width !== rasterWidth) element.width = rasterWidth;
  if (element.height !== rasterHeight) element.height = rasterHeight;
  const ctx = element.getContext('2d', {alpha: false});
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = props.seaColor;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(tx, ty, props.canvas.width * scale, props.canvas.height * scale);
  ctx.clip();

  const ratio = props.canvas.width / level.imageWidth;
  const worldMax = level.maxDim * ratio;
  const z = Math.min(level.maxTileZoom, Math.max(0,
    Math.round(Math.log2(worldMax * scale * dpr / level.tileSize))));
  const size = worldMax * scale / (2 ** z);
  const cols = Math.ceil(props.canvas.width * scale / size);
  const rows = Math.ceil(props.canvas.height * scale / size);
  const minX = Math.max(0, Math.floor(-tx / size));
  const minY = Math.max(0, Math.floor(-ty / size));
  const maxX = Math.min(cols - 1, Math.floor((width - tx) / size));
  const maxY = Math.min(rows - 1, Math.floor((height - ty) / size));
  visible = [];
  let ready = 0;
  const devicePixel = (value) => Math.round(value * dpr) / dpr;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const left = devicePixel(tx + x * size);
      const top = devicePixel(ty + y * size);
      const tile = {
        z, x, y, key: keyFor(z, x, y), left, top,
        width: devicePixel(tx + (x + 1) * size) - left,
        height: devicePixel(ty + (y + 1) * size) - top,
      };
      visible.push(tile);
      if (drawTile(ctx, tile, level)) ready += 1;
    }
  }
  ctx.restore();
  visible.sort((a, b) => Math.hypot(a.left + size / 2 - width / 2, a.top + size / 2 - height / 2)
    - Math.hypot(b.left + size / 2 - width / 2, b.top + size / 2 - height / 2));
  element.dataset.level = z;
  element.dataset.visible = visible.length;
  element.dataset.ready = ready;
  schedule();
}

watch(() => [props.transform.tx, props.transform.ty, props.transform.scale,
  props.viewport.width, props.viewport.height], dirty);
onMounted(dirty);
onBeforeUnmount(() => {
  active = false;
  cancelAnimationFrame(frameId);
  for (const controller of requested.values()) controller.abort();
  for (const image of bitmaps.values()) image.close();
});
</script>

<template>
  <canvas ref="surface" class="tile-layer" aria-hidden="true"></canvas>
</template>

<style scoped>
.tile-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
