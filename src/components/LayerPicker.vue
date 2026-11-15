<script setup>
// 分层选择器：工作室 LayeredMapControl 模型的移植——「分层/退出」模式开关
// + 可搜索的分组选择 + 右侧楼层竖排按钮。选中组与楼层写入 layerSelection
// 单例；每次定位目标变化 emit('focus', rect)，由集成方用
// layerFocusTransform + MapSurface 平移缩放到贴片。清单未就绪时整体不渲染。
//
// 交互契约：
//   - 搜索框为 combobox（aria-activedescendant）：输入即过滤全部目录
//     （约 350 楼层量级必须可检索）；无输入时按视口近邻排序（需 viewportRect
//     prop，缺省给全量），已选组恒置顶；
//   - ↑/↓/Home/End 移动高亮，Enter 选中，Esc 关搜索面板并把焦点还给分组
//     按钮；面板外点击 / Tab 离开同样关闭；
//   - 楼层按钮显示 floorLabel（B1/1F），title 给楼层名；再点当前层不变化
//     （回地面＝「退出」或 Esc 退出整个分层模式，保留上次组/层）；
//   - 根节点阻断 pointerdown/wheel/按键冒泡，嵌在地图容器内不触发拖动、
//     平移、缩放热路径；
//   - 无标题装饰、无左侧色条；单楼层组同样显示（可进可出）。
//
// 集成（root）：放入全视口容器（如 .map-surface 或 .app 内），组件自定位
// top:10px right:10px；楼层列 position:fixed 右缘垂直居中。
//   <LayerPicker :app-canvas="mapData.canvas"
//                :viewport-rect="viewportWorldRect(transform, viewport)"
//                @focus="rect => surfaceRef.focusWorldRect(rect)" />
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import ScrollPane from './ScrollPane.vue';
import {pushEscapeHandler} from './escapeStack.js';

import {
  DEFAULT_GAME_VERSION,
  useLayerSelection,
} from '../features/layers/layerSelection.js';

const props = defineProps({
  appCanvas: {type: Object, required: true}, // 应用世界画布 {width,height}
  viewportRect: {type: Object, default: null}, // {x,y,width,height} 世界像素
  expectedVersion: {type: String, default: DEFAULT_GAME_VERSION},
});

const emit = defineEmits(['focus']);

const {state, load, selectGroup, selectFloor, enterLayers, exitLayers,
  layerModeActive, activeGroup, floorOptions, activeFocusRect} = useLayerSelection();

const rootRef = ref(null);
const modeButtonRef = ref(null);
const groupButtonRef = ref(null);
const searchRef = ref(null);
const listRef = ref(null);
const panelOpen = ref(false);
const query = ref('');
const highlightIndex = ref(0);

const ready = computed(() => state.status === 'ready' && state.groups.length > 0);
const activeGroupId = computed(() => state.groups.length > 0 ? state.activeGroupId : null);

onMounted(() => {
  load({expectedGameVersion: props.expectedVersion, appCanvas: props.appCanvas});
});

// ---- 分组列表：搜索只显示匹配项；无搜索时按视口近邻（工作室做法）----
const visibleGroups = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  if (text !== '') {
    // 搜索态不把不匹配的已选组置顶：方向键/回车落在可见匹配项上，查询
    // 无结果时呈现空状态。地图上的当前选中（底图与楼层）不受查询影响。
    return state.groups.filter((group) =>
      `${group.label} ${group.searchText} ${group.floorText}`.toLocaleLowerCase().includes(text));
  }
  let list;
  if (props.viewportRect) {
    const rect = props.viewportRect;
    const [left, top, right, bottom] = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const intersecting = state.groups.filter(({bbox}) => bbox
      && bbox.left <= right && bbox.right >= left && bbox.top <= bottom && bbox.bottom >= top);
    list = (intersecting.length > 0 ? intersecting : state.groups)
      .map((group) => {
        const distance = ((group.bbox.left + group.bbox.right) / 2 - centerX) ** 2
          + ((group.bbox.top + group.bbox.bottom) / 2 - centerY) ** 2;
        return {group, distance};
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 20)
      .map((item) => item.group);
  } else {
    list = state.groups;
  }
  const chosen = state.groups.find((group) => group.key === activeGroupId.value);
  if (chosen && !list.some((group) => group.key === chosen.key)) list = [chosen, ...list];
  return list;
});

function clampHighlight() {
  const count = visibleGroups.value.length;
  highlightIndex.value = count === 0 ? 0 : Math.min(highlightIndex.value, count - 1);
}

watch(visibleGroups, () => {
  highlightIndex.value = 0;
});

watch(highlightIndex, async () => {
  await nextTick();
  listRef.value?.querySelectorAll('li[role="option"]')[highlightIndex.value]
    ?.scrollIntoView({block: 'nearest'});
});

function emitFocus() {
  if (activeFocusRect.value) emit('focus', activeFocusRect.value);
}

// ---- 面板开关与焦点 ----
function openPanel() {
  if (panelOpen.value) return;
  panelOpen.value = true;
  query.value = '';
  const chosen = visibleGroups.value.findIndex((group) => group.key === activeGroupId.value);
  highlightIndex.value = chosen >= 0 ? chosen : 0;
  void nextTick(() => searchRef.value?.focus({preventScroll: true}));
}

function closePanel(restoreFocus) {
  if (!panelOpen.value) return;
  panelOpen.value = false;
  if (restoreFocus) groupButtonRef.value?.focus({preventScroll: true});
}

function togglePanel() {
  if (panelOpen.value) closePanel(false);
  else openPanel();
}

// ---- 选择 ----
function chooseGroup(group) {
  selectGroup(group.key);
  closePanel(true);
  emitFocus();
}

function chooseFloor(level) {
  selectFloor(level);
  emitFocus();
}

function toggleMode() {
  if (layerModeActive.value) {
    exitLayers();
    return;
  }
  enterLayers();
  if (!activeGroup.value) openPanel();
  else emitFocus();
}

// ---- 键盘 ----
function onSearchKeydown(event) {
  const count = visibleGroups.value.length;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      highlightIndex.value = count === 0 ? 0 : Math.min(highlightIndex.value + 1, count - 1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      highlightIndex.value = Math.max(highlightIndex.value - 1, 0);
      break;
    case 'Home':
      event.preventDefault();
      highlightIndex.value = 0;
      break;
    case 'End':
      event.preventDefault();
      highlightIndex.value = Math.max(count - 1, 0);
      break;
    case 'Enter': {
      event.preventDefault();
      const group = visibleGroups.value[highlightIndex.value];
      if (group) chooseGroup(group);
      break;
    }
    default:
      break;
  }
}

function onRootKeydown(event) {
  event.stopPropagation(); // 组件内按键不外泄给地图（平移/缩放热路径）
  if (event.key === 'Escape' && !panelOpen.value) {
    event.preventDefault();
    exitLayers(); // 回地面；再进分层恢复上次组/层
  }
}

function onFocusOut(event) {
  if (panelOpen.value && event.relatedTarget && !rootRef.value?.contains(event.relatedTarget)) {
    closePanel(false);
  }
}

function onDocPointerDown(event) {
  if (panelOpen.value && !rootRef.value?.contains(event.target)) closePanel(false);
}

// 面板打开期间接管 Escape（只关面板并还焦点给分组按钮）；经 escapeStack
// 排队，后开的弹层（播放器抽屉/下拉/地图菜单）优先于本面板关闭。
let releasePanelEscape = null;
watch(panelOpen, (value) => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  releasePanelEscape?.();
  releasePanelEscape = null;
  if (value) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    releasePanelEscape = pushEscapeHandler(() => {
      if (!panelOpen.value) return false;
      closePanel(true);
      return true;
    });
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  releasePanelEscape?.();
});
</script>

<template>
  <div
    v-if="ready"
    ref="rootRef"
    class="layer-picker"
    @pointerdown.stop
    @wheel.stop
    @keydown="onRootKeydown"
    @focusout="onFocusOut"
  >
    <div class="bar">
      <button
        ref="modeButtonRef"
        type="button"
        class="mode"
        :class="{on: layerModeActive}"
        :aria-pressed="layerModeActive ? 'true' : 'false'"
        aria-label="切换分层地图"
        :title="layerModeActive ? '退出分层地图（回地面）' : '进入分层地图'"
        @click="toggleMode"
      >{{ layerModeActive ? '退出' : '分层' }}</button>
      <button
        v-if="layerModeActive"
        ref="groupButtonRef"
        type="button"
        class="group"
        aria-haspopup="listbox"
        :aria-expanded="panelOpen ? 'true' : 'false'"
        aria-label="分层区域"
        :title="activeGroup?.label ?? '选择区域'"
        @click="togglePanel"
      >
        <span class="group-label">{{ activeGroup?.label ?? '选择区域' }}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <div v-if="panelOpen" class="panel">
      <input
        ref="searchRef"
        v-model="query"
        class="search"
        role="combobox"
        aria-expanded="true"
        aria-controls="layer-group-list"
        :aria-activedescendant="visibleGroups.length > 0
          ? `layer-group-opt-${highlightIndex}` : null"
        aria-label="搜索分层区域"
        aria-autocomplete="list"
        placeholder="搜索区域"
        autocomplete="off"
        spellcheck="false"
        type="text"
        @keydown="onSearchKeydown"
      >
      <ScrollPane v-if="visibleGroups.length" class="group-scroll" label="分层区域列表滚动">
        <ul id="layer-group-list" ref="listRef" class="options" role="listbox" aria-label="分层区域">
          <li
            v-for="(group, index) in visibleGroups"
            :id="`layer-group-opt-${index}`"
            :key="group.key"
            role="option"
            :class="{highlight: index === highlightIndex, chosen: group.key === activeGroupId}"
            :aria-selected="group.key === activeGroupId ? 'true' : 'false'"
            :title="group.label"
            @click="chooseGroup(group)"
            @pointermove="highlightIndex = index"
          >{{ group.label }}</li>
        </ul>
      </ScrollPane>
      <p v-else class="no-match" role="status">无匹配</p>
    </div>

    <ScrollPane
      v-if="layerModeActive && !panelOpen && floorOptions.length > 0"
      class="floors"
      label="楼层列表滚动"
    >
      <div class="floor-buttons" role="group" aria-label="分层楼层">
        <button
          v-for="floor in floorOptions"
          :key="floor.level"
          type="button"
          class="floor"
          :class="{active: floor.level === state.activeFloorLevel}"
          :aria-pressed="floor.level === state.activeFloorLevel ? 'true' : 'false'"
          :title="floor.name ?? floor.label"
          @click="chooseFloor(floor.level)"
        >{{ floor.label }}</button>
      </div>
    </ScrollPane>
  </div>
</template>

<style scoped>
.layer-picker {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 5;
}

.bar {
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 4px;
  border-radius: 13px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-overlay-border);
  backdrop-filter: blur(6px);
  box-shadow: 0 8px 24px rgba(4, 8, 14, 0.4);
}

.mode {
  height: 40px;
  min-width: 52px;
  padding: 0 12px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, color 120ms ease;
}

.mode:hover {
  background: var(--control-hover);
  color: var(--accent-cyan);
}

.mode.on {
  background: rgba(155, 232, 241, 0.18);
  color: var(--accent-cyan);
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: min(250px, 42vw);
  height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.group:hover {
  background: var(--control-hover);
}

.group:focus-visible,
.mode:focus-visible {
  outline: 2px solid var(--control-focus);
  outline-offset: -2px;
}

.group-label {
  min-width: 0;
  max-width: 34vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: min(300px, calc(100vw - 20px));
  border-radius: 12px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-overlay-border);
  backdrop-filter: blur(6px);
  box-shadow: 0 8px 24px rgba(4, 8, 14, 0.4);
  overflow: hidden;
}

.search {
  box-sizing: border-box;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-bottom: 1px solid var(--surface-overlay-border);
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.4;
}

.search::placeholder {
  color: var(--text-secondary);
}

.search:focus {
  outline: none;
}

.panel:focus-within {
  border-color: rgba(155, 232, 241, 0.5);
}

.group-scroll {
  --pane-limit: min(320px, 46vh);
}

.options {
  list-style: none;
  margin: 0;
  padding: 6px;
}

.options li {
  min-height: 34px;
  padding: 7px 9px;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.options li:hover,
.options li.highlight {
  background: var(--control-hover);
}

.options li.chosen {
  background: rgba(155, 232, 241, 0.18);
  color: var(--accent-cyan);
}

.no-match {
  margin: 0;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.floors {
  position: fixed;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  z-index: 5;
  --pane-limit: min(58vh, 466px);
  border-radius: 13px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-overlay-border);
  backdrop-filter: blur(6px);
  overflow: hidden;
}

.floor-buttons {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}

.floor {
  box-sizing: border-box;
  width: 48px;
  min-height: 44px;
  padding: 0 5px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 550;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, color 120ms ease;
}

.floor:hover {
  background: var(--control-hover);
  color: var(--text-primary);
}

.floor:focus-visible {
  outline: 2px solid var(--control-focus);
  outline-offset: -2px;
}

.floor.active {
  background: rgba(155, 232, 241, 0.18);
  color: var(--accent-cyan);
  font-weight: 600;
}
</style>
