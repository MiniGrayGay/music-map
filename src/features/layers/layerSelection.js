// 分层选择状态（模块级单例）：一次选一个组（工作室 LayeredMapControl 的
// 模型），组内选当前楼层；退出分层即回地面（基础地图）。
// 装载与投影见 layerCatalog；未就绪（ABSENT）时一切为空，纯地图语义。

import {computed, reactive} from 'vue';

import {
  DEFAULT_APP_MAP,
  DEFAULT_GAME_VERSION,
  LAYER_CATALOG_STATUS,
  loadLayerCatalog,
} from './layerCatalog.js';

export {DEFAULT_GAME_VERSION};

const state = reactive({
  status: 'idle', // idle | loading | ready | absent
  reason: null,
  mapName: DEFAULT_APP_MAP, // 当前地图（provider：独立场景等底图后可切换）
  maps: [], // 全部地图索引（含无底图场景，不默默丢掉）
  groups: [], // 当前地图的组（仅含可投影组；无底图地图为空）
  activeGroupId: null, // null = 未进入分层（回地面）
  activeFloorLevel: null,
  skipped: 0,
});

let loadPromise = null;
let loadRevision = 0;

// 幂等装载：appCanvas 为应用世界画布 {width,height}（Teyvat 5632×4864），
// 投影比例由此推导（÷4 是该画布的自然结果，不写死）。
export function loadLayers(options = {}) {
  const {
    expectedGameVersion = DEFAULT_GAME_VERSION,
    appMapName = DEFAULT_APP_MAP,
    appCanvas = null,
  } = options;
  if (state.status === 'loading' || state.status === 'ready') return loadPromise;
  const revision = ++loadRevision;
  state.status = 'loading';
  state.reason = null;
  loadPromise = loadLayerCatalog({expectedGameVersion, appMapName, appCanvas}).then((catalog) => {
    if (revision !== loadRevision) return catalog;
    state.status = catalog.status;
    state.reason = catalog.status === LAYER_CATALOG_STATUS.ABSENT ? catalog.reason : null;
    state.maps = catalog.maps;
    state.mapName = catalog.appMapName ?? appMapName;
    state.groups = catalog.appGroups;
    state.skipped = catalog.skipped;
    resetSelection();
    return catalog;
  });
  return loadPromise;
}

export function reloadLayers(options = {}) {
  loadPromise = null;
  state.status = 'idle';
  resetSelection();
  return loadLayers(options);
}

// ---- provider：地图切换接口（独立场景底图就绪后由集成方调用）----
// 切到未投影地图时组列表为空、选择清空，但地图仍留在 maps 索引中。
export function setActiveMap(mapName) {
  if (!state.maps.some((map) => map.name === mapName)) return false;
  state.mapName = mapName;
  state.groups = groupsForMap(state, mapName);
  resetSelection();
  return true;
}

function groupsForMap(currentState, mapName) {
  const map = currentState.maps.find((item) => item.name === mapName);
  if (!map || !map.projectable) return [];
  // groups 仅在装载时为应用地图构建；切换地图需要重新装载（fail-closed：
  // 未投影地图没有可渲染坐标，等底图与画布参数就绪后由集成方提供）。
  return map.isAppMap ? currentState.groups : [];
}

function resetSelection() {
  state.activeGroupId = null;
  state.activeFloorLevel = null;
}

export function selectGroup(groupKey) {
  const group = state.groups.find((item) => item.key === groupKey);
  if (!group) return;
  state.activeGroupId = group.key;
  state.activeFloorLevel = group.defaultFloorLevel;
}

export function selectFloor(level) {
  const group = activeGroup.value;
  if (!group || !group.floors.some((floor) => floor.level === level)) return;
  state.activeFloorLevel = level;
}

export function exitLayers() {
  resetSelection();
}

export const layerModeActive = computed(() => state.status === 'ready'
  && state.activeGroupId !== null
  && state.groups.length > 0);

export const activeGroup = computed(() => state.groups.find(
  (group) => group.key === state.activeGroupId) ?? null);

export const floorOptions = computed(() => activeGroup.value?.floors ?? []);

export const activeFloor = computed(() => floorOptions.value.find(
  (floor) => floor.level === state.activeFloorLevel) ?? null);

export const activeLayerPieces = computed(() =>
  layerModeActive.value ? activeFloor.value?.entries ?? [] : []);

export const contextLayerPieces = computed(() => {
  const group = activeGroup.value;
  if (!layerModeActive.value || !group) return [];
  const drawn = new Set(activeLayerPieces.value.map(entry => entry.layerId));
  const backgrounds = group.backgroundGroupIds.map(key =>
    state.groups.find(candidate => candidate.key === key)).filter(Boolean);
  return [...backgrounds, group].flatMap(candidate => candidate.floors.flatMap(floor => floor.entries))
    .filter((entry) => {
      if (drawn.has(entry.layerId)) return false;
      drawn.add(entry.layerId);
      return true;
    });
});

// 定位目标：当前楼层贴片并集（显示坐标）。选中组/楼层后由选择器 emit，
// 集成方用它把视口平移缩放到位（layerFocusTransform）。
export const activeFocusRect = computed(() => {
  const floor = activeFloor.value;
  if (!floor || !layerModeActive.value) return null;
  let bbox = null;
  for (const entry of floor.entries) {
    if (!entry.rect) continue;
    const right = entry.rect.left + entry.rect.width;
    const bottom = entry.rect.top + entry.rect.height;
    bbox = bbox === null
      ? {left: entry.rect.left, top: entry.rect.top, right, bottom}
      : {
          left: Math.min(bbox.left, entry.rect.left),
          top: Math.min(bbox.top, entry.rect.top),
          right: Math.max(bbox.right, right),
          bottom: Math.max(bbox.bottom, bottom),
        };
  }
  if (bbox === null) return null;
  return {x: bbox.left, y: bbox.top, width: bbox.right - bbox.left, height: bbox.bottom - bbox.top};
});

// 视口定位变换（纯函数）：把 rect 居中放到视口，四周留白，限制在
// [min, MAX_SCALE]。结果交给 MapSurface 的 clampTransform 收口。
export function layerFocusTransform(viewport, rect, min, max) {
  const padding = Math.min(96, viewport.width * 0.12, viewport.height * 0.12);
  const fit = Math.min(
    (viewport.width - padding * 2) / Math.max(rect.width, 1),
    (viewport.height - padding * 2) / Math.max(rect.height, 1),
  );
  const scale = Math.min(Math.max(fit, min), max);
  return {
    scale,
    tx: viewport.width / 2 - (rect.x + rect.width / 2) * scale,
    ty: viewport.height / 2 - (rect.y + rect.height / 2) * scale,
  };
}

export function useLayerSelection() {
  return {
    state,
    load: loadLayers,
    reload: reloadLayers,
    setActiveMap,
    selectGroup,
    selectFloor,
    exitLayers,
    layerModeActive,
    activeGroup,
    floorOptions,
    activeFloor,
    activeLayerPieces,
    activeFocusRect,
    layerFocusTransform,
  };
}
