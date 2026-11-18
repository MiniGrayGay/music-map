<script setup>
// 应用组合层：装载地图数据与音乐分区清单，组织地图主画面、缩放控件与分区
// 音乐播放器。清单缺失/契约不符时保持空态（只有地图本身）；播放器只绑定
// 真实清单里的分区，页面不展示任何假设的音乐层。
import {computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch} from 'vue';
import LayerPicker from './components/LayerPicker.vue';
import LiquidGlass from './components/LiquidGlass.vue';
import MusicPlayer from './components/MusicPlayer.vue';
import SelectMenu from './components/SelectMenu.vue';
import ToyFollowPrompt from './components/ToyFollowPrompt.vue';
import ZoomControls from './components/ZoomControls.vue';
import {useAnchoredPanel} from './components/panelMotion.js';
import {pushEscapeHandler} from './components/escapeStack.js';
import {BGM_STATUS, loadRegionBgm} from './features/bgm/bgmStatus.js';
import {prepareToyFollow, toyFollowCardPreview} from './features/bgm/toyFollow.js';
import {loadMapData} from './features/map/mapData.js';
import {retireReliefDock} from './features/map/reliefDockMotion.js';
import {layerModeActive, loadLayers, reloadLayers} from './features/layers/layerSelection.js';
import {loadLayerBases, mapLabels} from './features/layers/mapBases.js';
import {isMobileDevice} from './features/map/isMobileDevice.js';

const GlobeSurface = defineAsyncComponent(() => import('./features/map/GlobeSurface.vue'));
const ReliefPreview = defineAsyncComponent(() => import('./features/map/ReliefPreview.vue'));
// 平面地图只在分层模式或球面不可用时挂载，走异步分包不占首屏 JS。
const MapSurface = defineAsyncComponent(() => import('./features/map/MapSurface.vue'));

const mapData = ref(null);
const appRoot = ref(null);
const followCardPreview = ref(import.meta.env.DEV ? toyFollowCardPreview() : null);
const baseMaps = ref({});
const mapName = ref('Teyvat');
const activeMap = computed(() => mapName.value === 'Teyvat'
  ? mapData.value : baseMaps.value[mapName.value]);
const loadError = ref(null);
const bgm = reactive({
  status: BGM_STATUS.LOADING,
  reason: null,
  zones: [],
  skipped: 0,
  clientVersion: null,
});
const activeZone = ref(null); // 播放器当前绑定的音乐分区（真实清单条目）
const presentedZone = ref(null);
const view = reactive({canZoomIn: true, canZoomOut: true});
const globeSurface = ref(null);
const planeSurface = ref(null);
const planeStage = ref(null);
const mapToolbar = ref(null);
const playerRef = ref(null);
const playerMotion = useAnchoredPanel(
  (panel) => panel.querySelector('button[aria-label="关闭播放器"]'),
  {name: 'glass-player', vanish: true},
);
const globeError = ref('');
const mobileDevice = isMobileDevice();
const showGlobe = computed(() => !layerModeActive.value && !globeError.value);
const presentedGlobe = ref(true);
const mapHandoff = shallowRef(null);
const surfaceRef = computed(() => showGlobe.value ? globeSurface.value : planeSurface.value);
const keepGlobe = computed(() => !globeError.value && (showGlobe.value || presentedGlobe.value || !!mapHandoff.value));
const keepPlane = computed(() => !showGlobe.value || !presentedGlobe.value || !!mapHandoff.value);
let surfaceFade;

function finishHandoff(plan) {
  if (mapHandoff.value !== plan) return;
  presentedGlobe.value = plan.toGlobe;
  mapHandoff.value = null;
  surfaceFade = null;
}

function blendSurfaces(plan, from = presentedGlobe.value ? 0 : 1) {
  if (mapHandoff.value !== plan || plan.blending) return;
  if (!planeStage.value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finishHandoff(plan);
    return;
  }
  plan.blending = true;
  const to = plan.toGlobe ? 0 : 1;
  const fade = surfaceFade = {element: planeStage.value, opacity: from, frame: 0};
  fade.element.style.opacity = from;
  let elapsed = 0;
  let last = performance.now();
  const advance = (now) => {
    if (surfaceFade !== fade) return;
    // A slow tile upload must not skip directly from one map to the other.
    elapsed += Math.min(48, Math.max(0, now - last));
    last = now;
    const progress = Math.min(1, elapsed / 280);
    const eased = progress * progress * (3 - 2 * progress);
    fade.opacity = from + (to - from) * eased;
    fade.element.style.opacity = fade.opacity;
    if (progress < 1) fade.frame = requestAnimationFrame(advance);
    else finishHandoff(plan);
  };
  fade.frame = requestAnimationFrame(advance);
}

watch(showGlobe, (toGlobe) => {
  const opacity = surfaceFade?.opacity ?? null;
  if (surfaceFade) cancelAnimationFrame(surfaceFade.frame);
  surfaceFade = null;
  if (globeError.value || (toGlobe === presentedGlobe.value && opacity === null)) {
    globeSurface.value?.cancelViewportAlignment();
    presentedGlobe.value = toGlobe;
    mapHandoff.value = null;
    return;
  }
  const sameMap = planeSurface.value?.$props.mapName === mapName.value;
  const plan = {toGlobe, viewport: toGlobe && sameMap ? planeSurface.value.viewportRect() : null};
  mapHandoff.value = plan;
  if (opacity !== null) blendSurfaces(plan, opacity);
}, {flush: 'sync'});
onBeforeUnmount(() => { if (surfaceFade) cancelAnimationFrame(surfaceFade.frame); });

function maybeEnterLayer(plan) {
  if (plan.cameraReady && plan.rasterReady) blendSurfaces(plan);
}

function onPlaneView(state) {
  if (!showGlobe.value) Object.assign(view, state);
  const plan = mapHandoff.value;
  if (!plan || plan.toGlobe || plan.cameraMoving || !state.viewportRect?.width) return;
  plan.cameraMoving = true;
  const aligned = () => {
    plan.cameraReady = true;
    maybeEnterLayer(plan);
  };
  if (!globeSurface.value?.alignViewport(state.viewportRect, aligned)) aligned();
}

function onPlaneReady() {
  const plan = mapHandoff.value;
  if (!plan || plan.toGlobe) return;
  plan.rasterReady = true;
  maybeEnterLayer(plan);
}

function onGlobeFrame(canvas) {
  if (showGlobe.value) receiveBackdrop(canvas);
  const plan = mapHandoff.value;
  if (plan?.toGlobe && !plan.viewport) blendSurfaces(plan);
}
const lunarResetLabel = computed(() => {
  if (!showGlobe.value || mapName.value !== 'MoonCanon') return '';
  return view.globeMap === 'MoonCanon' && view.magnified ? '复位到霜月全览' : '返回全局预览';
});
const desktopRelief = matchMedia('(pointer: fine) and (hover: hover) and (min-width: 760px) and (min-height: 480px)');
// 手机（竖屏/横屏/桌面模式/iPad 桌面 UA）不请求点云：媒体查询之外用
// 共用移动判定兜底，接鼠标改不掉触屏身份；触屏笔记本正常放行。
function reliefViewportAllows() {
  return desktopRelief.matches && !isMobileDevice();
}
const showRelief = ref(reliefViewportAllows());
const reliefUnavailable = ref(false);
const reliefPackStatus = ref(null);
let reliefPackReady = false;
const reliefPackLabels = {
  index: '正在读取点云索引',
  download: '正在下载分片点云',
  decompress: '正在解压分片点云',
  error: '暂时无法加载点云',
};
const reliefZone = ref(null);
const reliefInstance = ref(0);
const reliefAspect = ref(null);
const reliefDock = ref(null);
const reliefOpen = ref(false);
const reliefExiting = ref(false);
const emptyReliefKey = ref(null);
let reliefRequest = 0;
function preloadToyRelief() {
  if (reliefPackReady || !showRelief.value || !mapData.value?.preloadRelief
    || (reliefPackStatus.value && reliefPackStatus.value.stage !== 'error')) return;
  reliefPackStatus.value = {stage: 'index'};
  import('./features/map/reliefData.js')
    .then(({preloadRelief}) => preloadRelief((status) => { reliefPackStatus.value = status; }))
    .then(() => {
      reliefPackReady = true;
      reliefPackStatus.value = null;
    })
    .catch(() => { reliefPackStatus.value = {stage: 'error'}; });
}
watch(showRelief, preloadToyRelief);
function focusRelief(zone) {
  const request = ++reliefRequest;
  const replacing = reliefZone.value?.key !== zone?.key || reliefExiting.value;
  const present = () => {
    if (request !== reliefRequest) return;
    reliefExiting.value = false;
    if (replacing) {
      reliefInstance.value += 1;
      reliefAspect.value = null;
      reliefOpen.value = false;
    }
    reliefZone.value = zone;
    emptyReliefKey.value = null;
  };
  const retiring = replacing && reliefDock.value && retireReliefDock(reliefDock.value);
  if (retiring) {
    // Keep the old WebGL canvas mounted until its visible exit has finished.
    reliefExiting.value = true;
    void retiring.then(present);
  } else {
    present();
  }
}
function revealRelief(key) {
  if (key === null) {
    reliefOpen.value = false;
    return;
  }
  if (reliefZone.value?.key !== key) return;
  reliefOpen.value = true;
}
const updateReliefViewport = () => { showRelief.value = reliefViewportAllows(); };
watch([showGlobe, showRelief], ([globe, relief]) => {
  if (!globe || !relief) focusRelief(null);
}, {flush: 'sync'});
onMounted(() => {
  desktopRelief.addEventListener('change', updateReliefViewport);
  screen.orientation?.addEventListener?.('change', updateReliefViewport);
  addEventListener('resize', updateReliefViewport);
});
onBeforeUnmount(() => {
  desktopRelief.removeEventListener('change', updateReliefViewport);
  screen.orientation?.removeEventListener?.('change', updateReliefViewport);
  removeEventListener('resize', updateReliefViewport);
});
const smoothBoundaries = true;
let currentBackdrop;
watch(layerModeActive, () => {
  activeZone.value = null;
  focusRelief(null);
  currentBackdrop = null;
});

const mapOptions = computed(() => ['Teyvat', ...Object.keys(baseMaps.value)]
  .map((name) => ({value: name, label: mapLabels[name] ?? name})));


async function loadMusic() {
  bgm.status = BGM_STATUS.LOADING;
  Object.assign(bgm, await loadRegionBgm(mapData.value.dataVersion));
}

async function initialize() {
  loadError.value = null;
  void prepareToyFollow();
  try {
    mapData.value = await loadMapData();
    preloadToyRelief();
    void loadLayers({appCanvas: mapData.value.canvas});
    void loadLayerBases(mapData.value).then((maps) => { baseMaps.value = maps; });
    // 手机首帧带宽紧张：0.66MB 的音乐元数据等到首帧后空闲再拉，分区与
    // 搜索在清单到达时照常由响应式监听补上。
    if (isMobileDevice()) {
      const start = () => void loadMusic();
      if ('requestIdleCallback' in window) requestIdleCallback(start, {timeout: 3000});
      else setTimeout(start, 1500);
    } else {
      void loadMusic();
    }
  } catch (error) {
    loadError.value = error.message;
  }
}

onMounted(initialize);

function selectMap(name) {
  if (mapName.value === name) return;
  mapName.value = name;
  activeZone.value = null;
  focusRelief(null);
  currentBackdrop = null;
  void reloadLayers({appMapName: name, appCanvas: activeMap.value.canvas});
}

function receiveBackdrop(canvas) {
  currentBackdrop = canvas;
  refreshBackdrop();
}

function refreshBackdrop() {
  if (activeZone.value && currentBackdrop) playerRef.value?.updateBackdrop(currentBackdrop);
}

watch(playerRef, refreshBackdrop, {flush: 'post'});
watch(activeZone, (zone) => {
  if (zone) presentedZone.value = zone;
  else playerRef.value?.pause();
}, {flush: 'sync'});

let releasePlayerFrame;
function releaseClosedPlayer() {
  cancelAnimationFrame(releasePlayerFrame);
  releasePlayerFrame = requestAnimationFrame(() => {
    releasePlayerFrame = requestAnimationFrame(() => {
      if (!activeZone.value) presentedZone.value = null;
    });
  });
}
onBeforeUnmount(() => cancelAnimationFrame(releasePlayerFrame));

function closePlayer() {
  const previousZone = activeZone.value;
  activeZone.value = null;
  surfaceRef.value?.clearSelection();
  surfaceRef.value?.focusZone(previousZone?.key);
}

// Escape 关闭播放器经消费栈排队：试听详情、条件下拉、地图菜单、分层
// 搜索面板打开时都排在它前面（后开先关）。切区保留播放器原有的栈序。
let releasePlayerEscape = null;
watch(() => Boolean(activeZone.value), (open) => {
  releasePlayerEscape?.();
  releasePlayerEscape = null;
  if (open) {
    releasePlayerEscape = pushEscapeHandler(() => {
      if (!activeZone.value) return false;
      closePlayer();
      return true;
    });
  }
});
onBeforeUnmount(() => releasePlayerEscape?.());
</script>

<template>
  <div ref="appRoot" class="app" :class="{'app--mobile': mobileDevice}">
    <template v-if="mapData">
      <div v-if="!mobileDevice" class="app-controls" :inert="!!mapHandoff">
        <ZoomControls
          :can-zoom-in="view.canZoomIn"
          :can-zoom-out="view.canZoomOut"
          :layer-mode="layerModeActive"
          :globe-mode="showGlobe"
          :reset-label="lunarResetLabel"
          @zoom-in="surfaceRef?.zoomIn()"
          @zoom-out="surfaceRef?.zoomOut()"
          @reset="surfaceRef?.resetView()"
        />
      </div>
      <div v-if="keepGlobe" class="map-stage" :inert="!!mapHandoff || !showGlobe">
        <GlobeSurface
          ref="globeSurface"
          :map-data="activeMap"
          :map-name="mapName"
          :bgm="bgm"
          :active-zone="activeZone"
          :available-maps="mapOptions"
          :search-host="showGlobe ? mapToolbar : null"
          :initial-viewport="mapHandoff?.toGlobe ? mapHandoff.viewport : null"
          :relief-target="reliefDock"
          :relief-aspect="reliefAspect"
          :mobile-device="mobileDevice"
          :smooth-boundaries="smoothBoundaries"
          @canvas-frame="onGlobeFrame"
          @handoff-ready="mapHandoff?.toGlobe && blendSurfaces(mapHandoff)"
          @view="(state) => { if (showGlobe) Object.assign(view, state) }"
          @zone-activate="activeZone = $event"
          @zone-focus="focusRelief"
          @relief-reveal="revealRelief"
          @select-map="selectMap"
          @unavailable="globeError = $event"
        />
      </div>
      <div v-if="keepPlane" ref="planeStage" class="map-stage" :style="{opacity: presentedGlobe ? 0 : 1}"
           :inert="!!mapHandoff || showGlobe">
        <MapSurface
          :key="mapName"
          ref="planeSurface"
          :map-data="activeMap"
          :map-name="mapName"
          :bgm="bgm"
          :retain-layers="!!mapHandoff?.toGlobe"
          :smooth-boundaries="smoothBoundaries"
          @canvas-frame="(canvas) => { if (!showGlobe) receiveBackdrop(canvas) }"
          @surface-ready="onPlaneReady"
          @view="onPlaneView"
          @zone-activate="activeZone = $event"
          @blank-tap="activeZone = null"
        />
      </div>
      <div v-if="globeError" class="music-unavailable" role="status">{{ globeError }}</div>
      <div v-if="showRelief && reliefPackStatus" class="music-unavailable relief-loading">
        <span role="status">{{ reliefPackLabels[reliefPackStatus.stage] }}</span>
        <progress v-if="reliefPackStatus.stage === 'download'" aria-label="点云下载进度"
                  :value="reliefPackStatus.received" :max="reliefPackStatus.total" />
        <button v-if="reliefPackStatus.stage === 'error'" type="button" @click="preloadToyRelief">重试</button>
      </div>
      <aside v-if="reliefZone && (reliefExiting || (showGlobe && mapName === 'Teyvat' && showRelief
               && !reliefUnavailable && !reliefPackStatus && reliefZone.key !== emptyReliefKey))"
             :key="reliefInstance"
             ref="reliefDock"
             class="relief-dock map-glass" aria-label="高程点阵预览"
             :data-relief-zone="reliefZone.key"
             :data-relief-open="reliefOpen"
             :aria-hidden="!reliefOpen">
        <LiquidGlass @ready="surfaceRef?.refreshRelief?.()" />
        <div class="relief-content">
          <ReliefPreview :zone="reliefZone" :active="reliefOpen" @aspect="reliefAspect = $event"
                         @empty="emptyReliefKey = $event" @unavailable="reliefUnavailable = true" />
        </div>
      </aside>
      <Transition :css="false" v-bind="playerMotion" @after-enter="refreshBackdrop"
                  @after-leave="releaseClosedPlayer">
        <MusicPlayer
          v-if="presentedZone"
          v-show="activeZone"
          ref="playerRef"
          :zone="presentedZone"
          @close="closePlayer"
        />
      </Transition>
      <div ref="mapToolbar" class="map-toolbar">
        <div class="map-toolbar-row">
          <div v-if="Object.keys(baseMaps).length" class="map-switcher">
            <SelectMenu
              :model-value="mapName"
              :options="mapOptions"
              aria-label="切换地图"
              glass
              @update:model-value="selectMap"
            />
          </div>
          <LayerPicker :app-canvas="activeMap.canvas"
                       :viewport-rect="showGlobe ? null : view.viewportRect"
                       :read-viewport="showGlobe ? surfaceRef?.viewportRect : null"
                       :floor-host="appRoot"
                       :switching="!!mapHandoff" />
        </div>
      </div>
      <ToyFollowPrompt v-if="followCardPreview" :author="followCardPreview"
                       @dismiss="followCardPreview = null" />
      <div v-if="!activeZone && bgm.reason && bgm.status !== BGM_STATUS.READY"
           class="music-unavailable" role="status">
        <span>{{ bgm.status === BGM_STATUS.LOADING ? '正在重新加载音乐分区' : '暂时无法加载音乐分区' }}</span>
        <button type="button" :disabled="bgm.status === BGM_STATUS.LOADING" @click="loadMusic">重试</button>
      </div>
    </template>
    <div v-else-if="loadError" class="app-message" role="alert">
      <p>暂时无法加载地图</p>
      <button type="button" @click="initialize">重试</button>
    </div>

    <div v-else class="app-message" aria-busy="true">
      <p>正在加载地图数据</p>
    </div>
  </div>
</template>

<style scoped>
.relief-dock {
  position: absolute;
  border-radius: var(--radius-card);
  pointer-events: none;
  transition-property: none;
}

.relief-dock:not([data-relief-closing]):is(:not([data-relief-placed]), [data-relief-open='false']) {
  visibility: hidden;
  opacity: 0;
}

.relief-content {
  block-size: 100%;
  border-radius: inherit;
  overflow: clip;
  opacity: var(--relief-content-opacity, 0);
  transition-property: none;
}

.relief-dock > :deep(.liquid-glass) {
  inset: var(--relief-glass-top, 0) auto auto var(--relief-glass-left, 0);
  inline-size: var(--relief-glass-width, 0px);
  block-size: var(--relief-glass-height, 0px);
  border-radius: var(--relief-glass-radius, var(--radius-card));
  transition-property: none;
}

.music-unavailable {
  position: absolute;
  /* 清单重试与正常播放器互斥，提示停留在地图边缘。 */
  z-index: 6;
  inset-inline-start: 16px;
  bottom: 16px;
  max-inline-size: calc(100% - 32px);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-card);
  background: var(--glass-light), var(--surface-raised);
  -webkit-backdrop-filter: var(--glass-effect);
  backdrop-filter: var(--glass-effect);
  animation: ui-fade-in 240ms cubic-bezier(0, 0, 0.2, 1);
  font-size: 14px;
}
.relief-loading {
  inset-inline-start: auto;
  inset-inline-end: var(--map-inline-end, 18px);
}
.relief-loading progress {
  inline-size: min(22vw, 160px);
  accent-color: var(--accent);
}
.music-unavailable button, .app-message button {
  min-height: 44px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  background: var(--accent);
  color: #fff;
  font: inherit;
  cursor: pointer;
}
.music-unavailable button:hover:not(:disabled), .app-message button:hover {
  background: var(--accent-hover);
}
.music-unavailable button:active:not(:disabled), .app-message button:active {
  background: var(--accent-hover);
  transform: scale(.97);
}
.music-unavailable button:focus-visible, .app-message button:focus-visible {
  background: var(--control-focus);
  color: var(--text-primary);
}
.app {
  --player-width: clamp(340px, 28vw, 428px);
  --player-top: 80px;
  --map-inline-inset: 22px;
  --map-inline-end: var(--map-inline-inset);
  position: relative;
  width: 100%;
  height: 100%;
}

.map-stage { position: absolute; inset: 0; }

.app-controls {
  position: absolute;
  left: 24px;
  bottom: clamp(18px, 5.333dvh, 56px);
  z-index: 3;
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
}

.map-toolbar:has(.map-switcher .select-trigger[aria-expanded='true'],
    .layer-picker .panel:is([data-panel-open], [data-liquid-morph]))
    :deep(.globe-search) {
  visibility: hidden;
}

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .app {
    /* 移动端控件共享外边距、命中尺寸与行距。 */
    --mobile-edge: 12px;
    --mobile-top: max(var(--mobile-edge), env(safe-area-inset-top));
    --mobile-left: max(var(--mobile-edge), env(safe-area-inset-left));
    --mobile-right: max(var(--mobile-edge), env(safe-area-inset-right));
    --mobile-control-size: 44px;
    --mobile-row-gap: var(--space-1);
    --mobile-tools-top: calc(var(--mobile-top) + var(--mobile-control-size)
      + var(--mobile-row-gap));
    --floor-tools-top: var(--mobile-tools-top);
    --floor-tools-left: var(--mobile-left);
    --floor-tools-right: var(--mobile-right);
    --player-top-clearance: calc(var(--mobile-tools-top) + var(--mobile-control-size)
      + var(--mobile-row-gap));
  }

  .app-controls {
    top: var(--mobile-tools-top);
    right: auto;
    bottom: auto;
    left: var(--mobile-left);
  }

  .app:has(.globe-surface) .app-controls {
    left: auto;
    right: var(--mobile-right);
  }

  .app:has(.layer-picker .panel:is([data-panel-open], [data-liquid-morph])) .app-controls {
    visibility: hidden;
  }

  .app-controls :deep(.zoom-controls) {
    flex-direction: row;
    gap: 4px;
    padding: 0;
  }

  .app-controls :deep(.zoom-controls button) {
    width: var(--mobile-control-size);
    height: var(--mobile-control-size);
  }

  .app :deep(.layer-picker .bar) {
    gap: 4px;
    padding: 0;
  }

  /* 左侧模式控件与搜索框共用同源 44px 命中区。 */
  .app :deep(.layer-picker .mode) {
    height: var(--mobile-control-size);
  }

  .app :deep(.layer-picker .group-scroll) {
    --pane-limit: max(88px, min(320px, calc(100dvh - var(--mobile-top) - 132px
      - env(safe-area-inset-bottom))));
  }

  .app:has(.floor-buttons) {
    --player-top-clearance: calc(var(--mobile-tools-top) + var(--mobile-control-size) + 16px);
  }

  .music-unavailable {
    bottom: max(12px, env(safe-area-inset-bottom));
    inset-inline-start: var(--mobile-left);
    max-inline-size: calc(100% - var(--mobile-left) - var(--mobile-right));
  }
}

@media (min-width: 701px) and (max-height: 490px) and (pointer: fine) {
  .app :deep(.layer-picker .group-scroll) {
    --pane-limit: max(44px, calc(100dvh - 310px));
  }
}

.map-toolbar {
  --map-toolbar-left: var(--map-inline-inset);
  --map-toolbar-right: 20px;
  --map-toolbar-row-height: 54px;
  --map-toolbar-row-gap: 14px;
  position: absolute;
  top: var(--map-toolbar-top, 15px);
  inset-inline-start: var(--map-toolbar-left);
  display: grid;
  grid-template-columns: minmax(0, auto);
  row-gap: var(--map-toolbar-row-gap);
  max-inline-size: calc(100% - var(--map-toolbar-left) - var(--map-toolbar-right));
  pointer-events: none;
}

.map-toolbar-row {
  display: flex;
  align-items: start;
  gap: var(--space-1);
}

.map-toolbar-row > *,
.map-toolbar :deep(.globe-search) {
  pointer-events: auto;
}

.map-switcher {
  /* 让工具栏的固有宽度也计入选择器的完整宽度，玻璃和按钮共用同一列。 */
  flex: none;
  inline-size: 170px;
}

/* 地图切换触发器沿用共享选择控件，按左上主控加大命中区。 */
.map-switcher :deep(.select-trigger) {
  min-height: 54px;
  padding: 4px 10px 4px 15px;
  font-size: 16px;
}

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .map-toolbar {
    --map-toolbar-left: var(--mobile-left);
    --map-toolbar-right: var(--mobile-right);
    --map-toolbar-row-height: var(--mobile-control-size);
    --map-toolbar-row-gap: var(--mobile-row-gap);
    top: var(--mobile-top);
  }

  .app:not(.app--mobile):has(.globe-surface) .map-toolbar :deep(.globe-search) {
    max-inline-size: calc(100dvw - var(--mobile-left) - var(--mobile-right)
      - var(--mobile-control-size) - var(--mobile-row-gap));
  }

  .map-switcher {
    inline-size: 112px;
  }

  .map-switcher :deep(.select-trigger) {
    min-height: var(--mobile-control-size);
    font-size: 14px;
  }
}

.app-message {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 4px;
  padding: 24px;
  text-align: center;
}

.app-message p {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
}

.app-message .detail {
  color: var(--text-secondary);
  font-size: 12px;
  max-width: 60vw;
}
</style>
