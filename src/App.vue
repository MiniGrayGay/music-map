<script setup>
// 应用组合层：装载地图数据与音乐分区清单，组织地图主画面、缩放控件与分区
// 音乐播放器。清单缺失/契约不符时保持空态（只有地图本身）；播放器只绑定
// 真实清单里的分区，页面不展示任何假设的音乐层。
import {computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue';
import LayerPicker from './components/LayerPicker.vue';
import LiquidGlass from './components/LiquidGlass.vue';
import MusicPlayer from './components/MusicPlayer.vue';
import SelectMenu from './components/SelectMenu.vue';
import ZoomControls from './components/ZoomControls.vue';
import {useAnchoredPanel} from './components/panelMotion.js';
import {pushEscapeHandler} from './components/escapeStack.js';
import {BGM_STATUS, loadRegionBgm} from './features/bgm/bgmStatus.js';
import {loadMapData} from './features/map/mapData.js';
import {layerModeActive, loadLayers, reloadLayers} from './features/layers/layerSelection.js';
import {loadLayerBases, mapLabels} from './features/layers/mapBases.js';
import {isMobileDevice} from './features/map/isMobileDevice.js';

const GlobeSurface = defineAsyncComponent(() => import('./features/map/GlobeSurface.vue'));
const ReliefPreview = defineAsyncComponent(() => import('./features/map/ReliefPreview.vue'));
// 平面地图只在分层模式或球面不可用时挂载，走异步分包不占首屏 JS。
const MapSurface = defineAsyncComponent(() => import('./features/map/MapSurface.vue'));

const mapData = ref(null);
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
const surfaceRef = ref(null);
const mapToolbar = ref(null);
const playerRef = ref(null);
const playerMotion = useAnchoredPanel(
  (panel) => panel.querySelector('button[aria-label="关闭播放器"]'),
  {name: 'glass-player', vanish: true},
);
const globeError = ref('');
const showGlobe = computed(() => !layerModeActive.value && !globeError.value);
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
const reliefAspect = ref(null);
const emptyReliefKey = ref(null);
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
  if (reliefZone.value?.key !== zone?.key) reliefAspect.value = null;
  reliefZone.value = zone;
  emptyReliefKey.value = null;
}
const updateReliefViewport = () => { showRelief.value = reliefViewportAllows(); };
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
const smoothingKey = 'teyvat-region-map.smooth-boundaries';
const smoothBoundaries = ref(true);
try {
  smoothBoundaries.value = localStorage.getItem(smoothingKey) !== 'off';
} catch {
  // The setting is still available for this page when storage is disabled.
}
watch(smoothBoundaries, (enabled) => {
  try {
    localStorage.setItem(smoothingKey, enabled ? 'on' : 'off');
  } catch {
    // Keep the setting for this page even when it cannot be persisted.
  }
});
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
  <div class="app">
    <template v-if="mapData">
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
          <LayerPicker :app-canvas="activeMap.canvas" :viewport-rect="view.viewportRect" />
        </div>
      </div>
      <div class="app-controls">
        <ZoomControls
          :can-zoom-in="view.canZoomIn"
          :can-zoom-out="view.canZoomOut"
          :layer-mode="layerModeActive"
          :globe-mode="showGlobe"
          :reset-label="lunarResetLabel"
          v-model:smooth-boundaries="smoothBoundaries"
          @zoom-in="surfaceRef?.zoomIn()"
          @zoom-out="surfaceRef?.zoomOut()"
          @reset="surfaceRef?.resetView()"
        />
      </div>
      <MapSurface
        v-if="!showGlobe"
        :key="mapName"
        ref="surfaceRef"
        :map-data="activeMap"
        :map-name="mapName"
        :bgm="bgm"
        :smooth-boundaries="smoothBoundaries"
        @canvas-frame="receiveBackdrop"
        @view="(state) => Object.assign(view, state)"
        @zone-activate="activeZone = $event"
        @blank-tap="activeZone = null"
      />
      <GlobeSurface
        v-else
        ref="surfaceRef"
        :map-data="activeMap"
        :map-name="mapName"
        :bgm="bgm"
        :active-zone="activeZone"
        :available-maps="mapOptions"
        :search-host="mapToolbar"
        :smooth-boundaries="smoothBoundaries"
        @canvas-frame="receiveBackdrop"
        @view="(state) => Object.assign(view, state)"
        @zone-activate="activeZone = $event"
        @zone-focus="focusRelief"
        @select-map="selectMap"
        @unavailable="globeError = $event"
      />
      <div v-if="globeError" class="music-unavailable" role="status">{{ globeError }}</div>
      <div v-if="showRelief && reliefPackStatus" class="music-unavailable relief-loading">
        <span role="status">{{ reliefPackLabels[reliefPackStatus.stage] }}</span>
        <progress v-if="reliefPackStatus.stage === 'download'" aria-label="点云下载进度"
                  :value="reliefPackStatus.received" :max="reliefPackStatus.total" />
        <button v-if="reliefPackStatus.stage === 'error'" type="button" @click="preloadToyRelief">重试</button>
      </div>
      <aside v-if="showGlobe && mapName === 'Teyvat' && showRelief && !reliefUnavailable
               && !reliefPackStatus && reliefZone && reliefZone.key !== emptyReliefKey"
             class="relief-dock map-glass" aria-label="高程点阵预览"
             :style="reliefAspect == null ? undefined : {'--relief-aspect': reliefAspect}">
        <LiquidGlass :rim="false" :displacement="false" />
        <ReliefPreview :zone="reliefZone" @aspect="reliefAspect = $event"
                       @empty="emptyReliefKey = $event" @unavailable="reliefUnavailable = true" />
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
  --relief-height: clamp(190px, 32vh, 326px);
  --relief-width: calc(var(--relief-height) * var(--relief-aspect, 1.45) + 22px);
  position: absolute;
  z-index: 2;
  inset-inline-end: var(--map-inline-end, 18px);
  inset-block-end: 18px;
  inline-size: calc(2 * clamp(216px, var(--relief-width), min(388px, 38vw)));
  block-size: var(--relief-height);
  border: 1px solid rgb(135 218 246 / .14);
  border-radius: var(--radius-card);
  overflow: hidden;
  pointer-events: none;
  --map-glass-fill: rgb(9 28 45 / .72);
  background: radial-gradient(ellipse at 55% 85%, rgb(32 89 110 / .2), transparent 72%);
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

@media (min-width: 701px) and (pointer: fine), (min-width: 701px) and (min-height: 501px) {
  .app :deep(.floors) {
    top: 92px;
    right: auto;
    left: 18px;
    transform: none;
    --pane-limit: min(440px, calc(100dvh - 270px));
  }
}

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .app {
    --mobile-top: max(12px, env(safe-area-inset-top));
    --mobile-left: max(12px, env(safe-area-inset-left));
    --mobile-right: max(12px, env(safe-area-inset-right));
    --mobile-tools-top: calc(var(--mobile-top) + 52px);
    --mobile-floor-limit: min(22dvh, 148px);
    --player-top-clearance: calc(var(--mobile-tools-top) + 52px);
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

  .app :deep(.layer-picker .bar) {
    gap: 4px;
    padding: 0;
  }

  .app :deep(.layer-picker .mode),
  .app :deep(.layer-picker .group) {
    padding-inline: 8px;
  }

  .app :deep(.layer-picker .group-scroll) {
    --pane-limit: max(88px, min(320px, calc(100dvh - var(--mobile-top) - 132px
      - env(safe-area-inset-bottom))));
  }

  .app:has(.floor-buttons) {
    --player-top-clearance: calc(var(--mobile-tools-top) + var(--mobile-floor-limit) + 8px);
  }

  .app :deep(.floors) {
    top: var(--mobile-tools-top);
    right: var(--mobile-right);
    left: auto;
    transform: none;
    --floor-rail-limit: var(--mobile-floor-limit);
  }

  .music-unavailable {
    bottom: max(12px, env(safe-area-inset-bottom));
    inset-inline-start: var(--mobile-left);
    max-inline-size: calc(100% - var(--mobile-left) - var(--mobile-right));
  }
}

@media (min-width: 701px) and (max-height: 490px) and (pointer: fine) {
  .app :deep(.floors) {
    top: 84px;
    transform: none;
    --pane-limit: max(44px, calc(100dvh - 272px));
  }

  .app :deep(.layer-picker .group-scroll) {
    --pane-limit: max(44px, calc(100dvh - 310px));
  }
}

@media (min-width: 520px) and (orientation: landscape) and (pointer: coarse) and (max-height: 500px) {
  .app,
  .app:has(.floor-buttons) {
    --player-top-clearance: var(--mobile-tools-top);
  }

  .app :deep(.floors) {
    top: calc(var(--mobile-tools-top) + 52px);
    right: auto;
    left: var(--mobile-left);
    --floor-rail-limit: max(68px, calc(100dvh - var(--mobile-tools-top) - 68px
      - env(safe-area-inset-bottom)));
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
  z-index: 5;
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
  flex: 0 0 170px;
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
    --map-toolbar-row-height: 44px;
    --map-toolbar-row-gap: var(--space-1);
    top: var(--mobile-top);
  }

  .map-switcher {
    flex-basis: 112px;
  }

  .map-switcher :deep(.select-trigger) {
    min-height: 44px;
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
