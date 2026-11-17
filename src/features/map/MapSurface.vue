<script setup>
// 地图主画面：全视口画布，瓦片按视口加载。音乐分区层来自真实清单（投影
// ring 原始 polygon）：可视复用 RegionLines（共享单线 + 当前分区莓红洗色），
// 交互走 .world 内透明命中 path（fill:none + pointer-events:fill）；tooltip
// 只用 RegionTooltip。单击、右键或回车激活分区交给播放器，空白点击收起
// 播放器。基础交互保持：鼠标/触屏拖动、指轮锚点缩放、双指捏合、键盘平移缩放。
import {computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch} from 'vue';

import RegionTooltip from '../../components/RegionTooltip.vue';
import {musicView} from '../bgm/bgmStatus.js';
import {dayNightChoices, resolveRegionalPlaylist} from '../bgm/regionalPlaylist.js';
import LayerOverlay from '../layers/LayerOverlay.vue';
import {
  activeFocusRect,
  activeLayerPieces,
  layerFocusTransform,
  layerModeActive,
} from '../layers/layerSelection.js';
import RegionLines from './RegionLines.vue';
import TileCanvas from './TileCanvas.vue';
import {
  drawMoonCanonOverlay, loadMoonCanonSafety, moonCanonPatch, moonCanonReachable, moonCanonZoneAnchor,
} from './mooncanonSafety.js';
import {
  MAX_SCALE,
  clampTransform,
  fitTransform,
  minScale,
  panBy,
  rasterPosition,
  viewportWorldRect,
  zoomAt,
} from './mapModel.js';

const props = defineProps({
  mapData: {type: Object, required: true},
  mapName: {type: String, required: true},
  bgm: {type: Object, required: true}, // {status, reason, zones, …}（bgmStatus 结果）
  smoothBoundaries: {type: Boolean, default: true},
});

const emit = defineEmits(['view', 'zone-activate', 'blank-tap', 'canvas-frame']);

const containerRef = ref(null);
const moonOverlay = ref(null);
const moonSafety = shallowRef(null);
const moonSafetyError = ref(false);
const isMoonCanon = computed(() => props.mapName === 'MoonCanon');
const viewport = reactive({width: 0, height: 0});
const deviceScale = ref(window.devicePixelRatio || 1);
const transform = reactive({scale: 1, tx: 0, ty: 0});
const tooltipPoint = reactive({x: 0, y: 0});
const loadedLayerIds = reactive(new Set());

// 音乐分区交互状态：hover / 键盘焦点 / 激活选中，任一即为“当前分区”。
const hoveredZoneKey = ref(null);
const focusedZoneKey = ref(null);
const selectedZoneKey = ref(null);

let fitMinScale = 0.01;
let resizeObserver = null;

const worldStyle = computed(() => ({
  width: `${props.mapData.canvas.width}px`,
  height: `${props.mapData.canvas.height}px`,
  transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
  transformOrigin: '0 0',
}));

const currentLayerIds = computed(() => activeLayerPieces.value.map((entry) => entry.layerId));
const layerArtworkReady = computed(() => currentLayerIds.value.length > 0
  && currentLayerIds.value.every((id) => loadedLayerIds.has(id)));
const zoomCeiling = computed(() => Math.min(MAX_SCALE, ...activeLayerPieces.value.map(
  (entry) => entry.pixelDensity / deviceScale.value,
)));
const mapZones = computed(() => {
  if (layerModeActive.value && !layerArtworkReady.value) {
    return [];
  }
  return musicView(props.bgm, props.mapName, currentLayerIds.value, layerModeActive.value);
});
const moonZoneAnchors = computed(() => {
  const anchors = new Map();
  if (!isMoonCanon.value || !moonSafety.value) return anchors;
  for (const zone of mapZones.value) {
    const anchor = moonCanonZoneAnchor(moonSafety.value, zone);
    if (anchor) anchors.set(zone.key, anchor);
  }
  return anchors;
});
const zones = computed(() => isMoonCanon.value
  ? mapZones.value.filter(({key}) => moonZoneAnchors.value.has(key)) : mapZones.value);

watch(isMoonCanon, (enabled, _, cleanup) => {
  moonSafetyError.value = false;
  if (!enabled) return;
  let current = true;
  cleanup(() => { current = false; });
  loadMoonCanonSafety().then((safety) => {
    if (current) moonSafety.value = safety;
  }).catch(() => {
    if (current) moonSafetyError.value = true;
  });
}, {immediate: true});
watch([moonOverlay, moonSafety], ([canvas, safety]) => {
  if (canvas && safety) drawMoonCanonOverlay(canvas, safety);
}, {flush: 'post'});

const activeZoneKey = computed(() =>
  hoveredZoneKey.value ?? focusedZoneKey.value ?? selectedZoneKey.value);
const activeZone = computed(() => zones.value.find((zone) => zone.key === activeZoneKey.value) || null);

watch(currentLayerIds, (ids, previous) => {
  if (ids.length === previous.length && ids.every((id, index) => id === previous[index])) return;
  hoveredZoneKey.value = null;
  focusedZoneKey.value = null;
  selectedZoneKey.value = null;
  emit('blank-tap');
});

// RegionLines 只认 {id1, rings, path}：分区传投影 rings、id1=zone.key、path。
const zoneRegions = computed(() => zones.value.map((zone) => ({
  id1: zone.key,
  rings: zone.pixelRings,
  lines: zone.pixelLines,
  path: zone.pathData,
})));
const activeZoneRegion = computed(() => {
  const zone = activeZone.value;
  if (!zone) return null;
  return {id1: zone.key, rings: zone.pixelRings, lines: zone.pixelLines, path: zone.pathData};
});

const playableZones = new WeakMap();
function zonePlayable(zone) {
  if (!playableZones.has(zone)) {
    playableZones.set(zone, dayNightChoices.some(({key}) => resolveRegionalPlaylist(zone, key).tracks.length > 0));
  }
  return playableZones.get(zone);
}

function emitView() {
  emit('view', {
    canZoomIn: transform.scale < zoomCeiling.value - 1e-9,
    canZoomOut: transform.scale > fitMinScale + 1e-9,
    viewportRect: viewportWorldRect(transform, viewport),
  });
}

function applyTransform(next) {
  const clamped = clampTransform(next, viewport, props.mapData.canvas, fitMinScale,
    Math.max(fitMinScale, zoomCeiling.value));
  transform.scale = clamped.scale;
  transform.tx = clamped.tx;
  transform.ty = clamped.ty;
  emitView();
}

function resetView() {
  if (activeFocusRect.value) {
    applyTransform(layerFocusTransform(viewport, activeFocusRect.value, fitMinScale,
      zoomCeiling.value));
    return;
  }
  const fit = fitTransform(viewport, props.mapData.canvas, 24);
  applyTransform(fit);
}

watch(activeFocusRect, (rect) => {
  if (!viewport.width || !viewport.height) return;
  if (rect) resetView();
  else applyTransform(transform);
});

// ---- 指针交互 ----
const pointers = new Map(); // pointerId → {x, y}
const dragState = reactive({active: false, lastX: 0, lastY: 0, moved: 0, pinch: null});

function pointFromEvent(event) {
  const rect = containerRef.value.getBoundingClientRect();
  return {x: event.clientX - rect.left, y: event.clientY - rect.top};
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    distance: Math.hypot(dx, dy),
    mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2},
  };
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  containerRef.value.focus({preventScroll: true});
  const point = pointFromEvent(event);
  pointers.set(event.pointerId, point);
  try {
    containerRef.value.setPointerCapture(event.pointerId);
  } catch {
    // 快速点按时指针可能已释放（pointerup 同批送达），捕获失败不阻断交互。
  }
  if (pointers.size === 1) {
    dragState.active = true;
    dragState.lastX = point.x;
    dragState.lastY = point.y;
    dragState.moved = 0;
    dragState.pinch = null;
  } else if (pointers.size === 2) {
    const info = pinchInfo();
    dragState.pinch = {distance: info.distance, mid: info.mid, transform: {...transform}};
  }
}

function onPointerMove(event) {
  if (!pointers.has(event.pointerId)) {
    if (isMoonCanon.value && (event.pointerType === 'mouse' || event.pointerType === 'pen')) {
      hoveredZoneKey.value = zoneAt(event.clientX, event.clientY)?.key ?? null;
    }
    // 未按下的鼠标移动：仅更新 tooltip 跟随位置。
    if (event.pointerType === 'mouse' && activeZone.value) {
      const point = pointFromEvent(event);
      setTooltipPoint(point);
    }
    return;
  }
  const point = pointFromEvent(event);
  pointers.set(event.pointerId, point);
  if (dragState.pinch && pointers.size >= 2) {
    const info = pinchInfo();
    if (info.distance > 0 && dragState.pinch.distance > 0) {
      const base = dragState.pinch;
      const target = base.transform.scale * (info.distance / base.distance);
      const scale = Math.min(Math.max(target, fitMinScale), zoomCeiling.value);
      const worldMid = {
        x: (base.mid.x - base.transform.tx) / base.transform.scale,
        y: (base.mid.y - base.transform.ty) / base.transform.scale,
      };
      applyTransform({scale, tx: info.mid.x - worldMid.x * scale, ty: info.mid.y - worldMid.y * scale});
    }
    return;
  }
  if (dragState.active) {
    const dx = point.x - dragState.lastX;
    const dy = point.y - dragState.lastY;
    dragState.moved += Math.abs(dx) + Math.abs(dy);
    dragState.lastX = point.x;
    dragState.lastY = point.y;
    applyTransform(panBy(transform, dx, dy));
  }
}

function onPointerUp(event) {
  const isTap = pointers.size === 1 && dragState.active && dragState.moved < 8;
  const activates = isTap && (event.pointerType !== 'mouse' || event.button === 0);
  pointers.delete(event.pointerId);
  if (pointers.size < 2) dragState.pinch = null;
  if (pointers.size === 1) {
    // 双指抬起一支后：把单指拖动锚重置到剩余指针，避免跳变。
    const [remaining] = pointers.values();
    dragState.lastX = remaining.x;
    dragState.lastY = remaining.y;
    dragState.moved = 8; // 视为已移动，抬起时不再当作点选
    dragState.active = true;
  }
  if (pointers.size === 0) {
    dragState.active = false;
  }
  if (activates) {
    // 指针捕获会把 pointerup 的 target 变成容器，这里按坐标命中透明分区
    // 命中层：命中即试听（用户手势），否则视为空白，收起播放器。
    const zone = zoneAt(event.clientX, event.clientY);
    if (zone) {
      activateZone(zone);
      return;
    }
    selectedZoneKey.value = null;
    emit('blank-tap');
    return;
  }
  if (pointers.size === 0 && event.pointerType === 'mouse' && dragState.moved >= 8) {
    // 捕获拖动期间命中 path 的 pointerenter/leave 不会派发；释放捕获后按
    // 坐标刷新悬停，避免残留拖动前的选中。
    const zone = zoneAt(event.clientX, event.clientY);
    hoveredZoneKey.value = zone ? zone.key : null;
    if (zone) setTooltipPoint(pointFromEvent(event));
  }
}

function moonReachableAt(clientX, clientY) {
  if (!isMoonCanon.value) return true;
  const point = pointFromEvent({clientX, clientY});
  const {width, height} = props.mapData.canvas;
  return moonCanonReachable(moonSafety.value, (point.x - transform.tx) / (transform.scale * width),
    (point.y - transform.ty) / (transform.scale * height));
}

function zoneAt(clientX, clientY) {
  if (!zones.value.length || !moonReachableAt(clientX, clientY)) return null;
  const hit = document.elementFromPoint(clientX, clientY);
  const path = hit?.closest?.('path[data-zone-key]');
  if (!path) return null;
  return zones.value.find((zone) => zone.key === path.dataset.zoneKey) ?? null;
}

function zoneFromEventTarget(event) {
  if (!moonReachableAt(event.clientX, event.clientY)) return null;
  const path = event.target?.closest?.('path[data-zone-key]');
  if (!path) return null;
  return zones.value.find((zone) => zone.key === path.dataset.zoneKey) ?? null;
}

function activateZone(zone) {
  hoveredZoneKey.value = null;
  focusedZoneKey.value = null;
  selectedZoneKey.value = zone.key;
  emit('zone-activate', zone);
}

function onPointerCancel(event) {
  pointers.delete(event.pointerId);
  if (pointers.size === 0) {
    dragState.active = false;
    dragState.pinch = null;
  }
}

function setTooltipPoint(point) {
  tooltipPoint.x = point.x;
  tooltipPoint.y = point.y;
}

function onZoneEnter(zone, event) {
  if (dragState.active) return;
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
  if (!moonReachableAt(event.clientX, event.clientY)) return;
  hoveredZoneKey.value = zone.key;
  setTooltipPoint(pointFromEvent(event));
}

function onZoneLeave() {
  hoveredZoneKey.value = null;
}

// 键盘焦点即可视选中（RegionLines 洗色），tooltip 钉在命中面包围盒中心。
function onZoneFocus(zone, event) {
  focusedZoneKey.value = zone.key;
  const anchor = moonZoneAnchors.value.get(zone.key);
  if (anchor) {
    setTooltipPoint({
      x: transform.tx + anchor[0] * props.mapData.canvas.width * transform.scale,
      y: transform.ty + anchor[1] * props.mapData.canvas.height * transform.scale,
    });
    return;
  }
  const rect = event.currentTarget.getBoundingClientRect();
  setTooltipPoint({x: rect.left + rect.width / 2, y: rect.top + rect.height / 2});
}

function onZoneBlur() {
  focusedZoneKey.value = null;
}

function onZoneKeydown(zone, event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  activateZone(zone);
}

function onContextMenu(event) {
  // 右键分区 = 试听（用户手势）；空白处保留系统菜单。优先用派发事件的
  // 真实目标命中：contextmenu 坐标会被浏览器取整，点落在分区边界的亚像素
  // 交界时按坐标回退可能落到区外；坐标只作为目标不可用时的回退。
  const zone = zoneFromEventTarget(event) ?? zoneAt(event.clientX, event.clientY);
  if (!zone) return;
  event.preventDefault();
  activateZone(zone);
}

function onWheel(event) {
  const point = pointFromEvent(event);
  const factor = Math.pow(2, -event.deltaY * 0.0022);
  applyTransform(zoomAt(transform, viewport, point, factor, fitMinScale, zoomCeiling.value));
}

function onKeydown(event) {
  const panStep = 90;
  const actions = {
    ArrowUp: () => applyTransform(panBy(transform, 0, panStep)),
    ArrowDown: () => applyTransform(panBy(transform, 0, -panStep)),
    ArrowLeft: () => applyTransform(panBy(transform, panStep, 0)),
    ArrowRight: () => applyTransform(panBy(transform, -panStep, 0)),
    '+': () => zoomCenter(1.6),
    '=': () => zoomCenter(1.6),
    '-': () => zoomCenter(1 / 1.6),
    Home: resetView,
    '0': resetView,
    Escape: () => {
      hoveredZoneKey.value = null;
      focusedZoneKey.value = null;
      selectedZoneKey.value = null;
    },
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

function zoomCenter(factor) {
  const anchor = {x: viewport.width / 2, y: viewport.height / 2};
  applyTransform(zoomAt(transform, viewport, anchor, factor, fitMinScale, zoomCeiling.value));
}

function clearSelection() {
  selectedZoneKey.value = null;
  focusedZoneKey.value = null;
}

function focusZone(key) {
  const map = containerRef.value;
  if (!map) return;
  const zone = key ? map.querySelector(`[data-zone-key="${CSS.escape(key)}"]`) : null;
  (zone ?? map).focus({preventScroll: true});
}

defineExpose({
  zoomIn: () => zoomCenter(1.5), zoomOut: () => zoomCenter(1 / 1.5),
  resetView, clearSelection, focusZone,
});

onMounted(() => {
  const element = containerRef.value;
  viewport.width = element.clientWidth;
  viewport.height = element.clientHeight;
  fitMinScale = minScale(viewport, props.mapData.canvas, 24);
  resetView();
  resizeObserver = new ResizeObserver(() => {
    const wasFit = Math.abs(transform.scale - fitMinScale) < 1e-9;
    const center = viewportWorldRect(transform, viewport);
    const x = center.x + center.width / 2;
    const y = center.y + center.height / 2;
    viewport.width = element.clientWidth;
    viewport.height = element.clientHeight;
    deviceScale.value = window.devicePixelRatio || 1;
    fitMinScale = minScale(viewport, props.mapData.canvas, 24);
    if (wasFit && !activeFocusRect.value) {
      resetView();
    } else {
      const scale = Math.min(Math.max(transform.scale, fitMinScale), zoomCeiling.value);
      applyTransform({scale, tx: viewport.width / 2 - x * scale, ty: viewport.height / 2 - y * scale});
    }
  });
  resizeObserver.observe(element);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>

<template>
  <div
    ref="containerRef"
    class="map-surface"
    :class="{dragging: dragState.active, 'moon-surface': isMoonCanon}"
    tabindex="0"
    role="application"
    aria-roledescription="提瓦特区域地图"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @wheel.prevent="onWheel"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  >
    <TileCanvas :class="{ 'floor-context': layerModeActive }" :map-name="mapName"
                :pyramid="mapData.pyramid" :canvas="mapData.canvas" :sea-color="mapData.seaColor"
                :viewport="viewport" :transform="transform" @canvas-frame="emit('canvas-frame', $event)" />
    <img v-if="isMoonCanon" :src="moonCanonPatch.url" class="moon-editor-patch"
         :class="{'floor-context': layerModeActive}"
         :style="rasterPosition(transform, moonCanonPatch.left, moonCanonPatch.top,
           moonCanonPatch.width, moonCanonPatch.height)"
         alt="" draggable="false" />
    <canvas v-if="isMoonCanon && moonSafety" ref="moonOverlay" class="moon-safety-overlay"
            :class="{'floor-context': layerModeActive}" :style="worldStyle" aria-hidden="true" />
    <LayerOverlay :pieces="activeLayerPieces" :transform="transform"
                  @loaded="loadedLayerIds.add($event)" />
    <div class="world" :style="worldStyle">
      <!-- 分区透明命中层：不可见；hover/单击/右键/键盘都发生在这层。 -->
      <svg
        v-if="zones.length"
        class="zone-hits"
        :width="mapData.canvas.width"
        :height="mapData.canvas.height"
        :viewBox="`0 0 ${mapData.canvas.width} ${mapData.canvas.height}`"
      >
        <path
          v-for="zone in zones"
          :id="`zone-${zone.key}`"
          :key="zone.key"
          :d="zone.pathData"
          :data-zone-key="zone.key"
          :data-hovered="zone.key === hoveredZoneKey ? '' : null"
          :aria-current="zone.key === selectedZoneKey ? 'true' : null"
          class="zone-hit"
          :tabindex="0"
          role="button"
          :aria-label="zonePlayable(zone)
            ? `音乐分区 ${zone.name}，单击或回车试听`
            : `音乐分区 ${zone.name}，暂无曲目`"
          @pointerenter="onZoneEnter(zone, $event)"
          @pointerleave="onZoneLeave"
          @focus="onZoneFocus(zone, $event)"
          @blur="onZoneBlur"
          @keydown="onZoneKeydown(zone, $event)"
        />
      </svg>
    </div>
    <!-- 分区可视层：RegionLines 共享单线 + 当前分区莓红洗色；无分区时整层不渲染。 -->
    <RegionLines
      v-if="zones.length"
      :regions="zoneRegions"
      :active-region="activeZoneRegion"
      :transform="transform"
      :smooth="smoothBoundaries"
      :highlight-footprint="layerModeActive"
    />
    <RegionTooltip
      v-if="!dragState.active && activeZone && activeZone.key !== selectedZoneKey &&
        (hoveredZoneKey !== null || focusedZoneKey !== null)"
      :key="activeZone.key"
      :label="activeZone.name"
      :id1="activeZone.key"
      :bgm-state="zonePlayable(activeZone) ? null : '暂无曲目'"
      :x="tooltipPoint.x"
      :y="tooltipPoint.y"
      :viewport="viewport"
    />
    <p v-if="moonSafetyError" class="floor-status" role="status">霜月遮罩无法加载</p>
    <p v-else-if="layerArtworkReady && bgm.status === 'ready' && !zones.length
      && (!isMoonCanon || moonSafety)" class="floor-status" role="status">
      本层音乐分区待核实
    </p>
  </div>
</template>

<style scoped>
.map-surface {
  position: relative;
  z-index: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  outline: none;
  cursor: grab;
  background: var(--surface-page);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.map-surface.dragging {
  cursor: grabbing;
}

.map-surface:not(.moon-surface)::after {
  position: absolute;
  z-index: 2;
  inset: 0;
  pointer-events: none;
  content: '';
  background: linear-gradient(145deg, rgb(191 203 184 / .36), rgb(160 181 168 / .24));
}

.world {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}

.moon-safety-overlay,
.moon-editor-patch {
  position: absolute;
  pointer-events: none;
}

.moon-safety-overlay {
  left: 0;
  top: 0;
}

.moon-surface .zone-hit:not([data-hovered]) {
  cursor: inherit;
}

.tile-layer.floor-context,
.moon-editor-patch.floor-context,
.moon-safety-overlay.floor-context {
  opacity: 0.38;
}

.zone-hits {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
}

/* 透明命中：不绘制任何描边/填色；焦点可视由 RegionLines 洗色呈现。 */
.zone-hit {
  fill: none;
  fill-rule: evenodd;
  pointer-events: fill;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.zone-hit:focus,
.zone-hit:focus-visible {
  outline: none;
}

.floor-status {
  position: absolute;
  left: 12px;
  bottom: var(--space-2);
  margin: 0;
  padding: var(--space-1);
  border-radius: var(--radius-card);
  color: var(--text-secondary);
  background: var(--surface-overlay);
  font-size: 12px;
  pointer-events: none;
}

@media (min-width: 701px) {
  .floor-status {
    left: 86px;
    bottom: 24px;
  }
}
</style>
