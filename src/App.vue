<script setup>
// 应用组合层：装载地图数据与音乐分区清单，组织地图主画面、缩放控件与分区
// 音乐播放器。清单缺失/契约不符时保持空态（只有地图本身）；播放器只绑定
// 真实清单里的分区，页面不展示任何假设的音乐层。
import {computed, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue';
import LayerPicker from './components/LayerPicker.vue';
import MusicPlayer from './components/MusicPlayer.vue';
import SelectMenu from './components/SelectMenu.vue';
import ZoomControls from './components/ZoomControls.vue';
import {pushEscapeHandler} from './components/escapeStack.js';
import MapSurface from './features/map/MapSurface.vue';
import {BGM_STATUS, loadRegionBgm} from './features/bgm/bgmStatus.js';
import {loadMapData} from './features/map/mapData.js';
import {layerModeActive, loadLayers, reloadLayers} from './features/layers/layerSelection.js';
import {loadLayerBases, mapLabels} from './features/layers/mapBases.js';

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
const mode = ref('exploration');
const view = reactive({canZoomIn: true, canZoomOut: true});
const surfaceRef = ref(null);

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
    void loadLayers({appCanvas: mapData.value.canvas});
    void loadLayerBases(mapData.value).then((maps) => { baseMaps.value = maps; });
    void loadMusic();
  } catch (error) {
    loadError.value = error.message;
  }
}

onMounted(initialize);

function selectMap(name) {
  if (mapName.value === name) return;
  mapName.value = name;
  activeZone.value = null;
  void reloadLayers({appMapName: name, appCanvas: activeMap.value.canvas});
}

function closePlayer() {
  activeZone.value = null;
  surfaceRef.value?.clearSelection();
}

// Escape 关闭播放器经消费栈排队：播放器抽屉、条件下拉、地图菜单、分层
// 搜索面板打开时都排在它前面（后开先关），不会一次 Escape 连带关闭。
let releasePlayerEscape = null;
watch(activeZone, (zone) => {
  releasePlayerEscape?.();
  releasePlayerEscape = null;
  if (zone) {
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
      <!-- 叠加控件放地图前：键盘 Tab 先到地图切换/分层/缩放，再进入地图容器
           与全部分区命中 path（344+ 个 tab 停留点）。视觉层序不变——这些
           控件都有显式 z-index，画在 z-auto 的地图之上。 -->
      <div v-if="Object.keys(baseMaps).length" class="map-switcher">
        <SelectMenu
          :model-value="mapName"
          :options="mapOptions"
          aria-label="切换地图"
          @update:model-value="selectMap"
        />
      </div>
      <LayerPicker :app-canvas="activeMap.canvas" :viewport-rect="view.viewportRect" />
      <div class="app-controls">
        <ZoomControls
          :can-zoom-in="view.canZoomIn"
          :can-zoom-out="view.canZoomOut"
          :layer-mode="layerModeActive"
          @zoom-in="surfaceRef?.zoomIn()"
          @zoom-out="surfaceRef?.zoomOut()"
          @reset="surfaceRef?.resetView()"
        />
      </div>
      <MapSurface
        :key="mapName"
        ref="surfaceRef"
        :map-data="activeMap"
        :map-name="mapName"
        :bgm="bgm"
        @view="(state) => Object.assign(view, state)"
        @zone-activate="activeZone = $event"
        @blank-tap="activeZone = null"
      />
      <MusicPlayer
        v-if="activeZone"
        :zone="activeZone"
        v-model:mode="mode"
        @close="closePlayer"
      />
      <div v-else-if="bgm.reason && bgm.status !== BGM_STATUS.READY"
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
.music-unavailable {
  position: absolute;
  /* 与播放器同槽位：二者互斥（v-else），z-index 保证画在 z-auto 的地图上。 */
  z-index: 6;
  inset: auto auto 12px 12px;
  max-inline-size: calc(100vw - 86px);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--surface-overlay-border);
  border-radius: 10px;
  background: var(--surface-overlay);
  font-size: 14px;
}
.music-unavailable button, .app-message button {
  padding: 5px 11px;
  border: 1px solid var(--surface-overlay-border);
  border-radius: 7px;
  background: var(--control-hover);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}
.music-unavailable button:focus-visible, .app-message button:focus-visible {
  outline: 2px solid var(--control-focus);
}
.app {
  position: relative;
  width: 100%;
  height: 100%;
}

.app-controls {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 3;
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.map-switcher {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 5;
}

/* 地图切换触发器沿用共享选择控件，按左上主控加大命中区。 */
.map-switcher :deep(.select-trigger) {
  min-height: 44px;
  min-width: 128px;
  padding: 4px 4px 4px 12px;
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
  font-size: 15px;
  line-height: 1.6;
}

.app-message .detail {
  color: var(--text-secondary);
  font-size: 13px;
  max-width: 60vw;
}
</style>
