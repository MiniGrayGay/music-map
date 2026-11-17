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
import LiquidGlass from './LiquidGlass.vue';
import {useAnchoredPanel} from './panelMotion.js';
import ScrollPane from './ScrollPane.vue';
import {pushEscapeHandler} from './escapeStack.js';

import {
  DEFAULT_GAME_VERSION,
  useLayerSelection,
} from '../features/layers/layerSelection.js';

const props = defineProps({
  appCanvas: {type: Object, required: true}, // 应用世界画布 {width,height}
  viewportRect: {type: Object, default: null}, // {x,y,width,height} 世界像素
  readViewport: {type: Function, default: null},
  floorHost: {type: HTMLElement, default: null},
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
const floorButtonsRef = ref(null);
const moreFloorsAbove = ref(false);
const moreFloorsBelow = ref(false);
const panelOpen = ref(false);
let panelAnchor;
const panelMotion = useAnchoredPanel(() => panelAnchor?.isConnected ? panelAnchor : modeButtonRef.value);
const query = ref('');
const openedViewport = ref(null);
const highlightIndex = ref(0);

const ready = computed(() => state.status === 'ready' && state.groups.length > 0);
const activeGroupId = computed(() => state.groups.length > 0 ? state.activeGroupId : null);
const activeFloorSelector = '[aria-pressed="true"]';
let keepFloorVisible = true;

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
  const rect = props.viewportRect ?? openedViewport.value;
  if (rect) {
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
function openPanel(focusSearch) {
  if (panelOpen.value) return;
  openedViewport.value = props.readViewport?.() ?? null;
  panelAnchor = layerModeActive.value ? groupButtonRef.value : modeButtonRef.value;
  panelOpen.value = true;
  query.value = '';
  const chosen = visibleGroups.value.findIndex((group) => group.key === activeGroupId.value);
  highlightIndex.value = chosen >= 0 ? chosen : 0;
  if (focusSearch) void nextTick(() => searchRef.value?.focus({preventScroll: true}));
}

function closePanel(restoreFocus) {
  if (!panelOpen.value) return;
  panelOpen.value = false;
  const trigger = layerModeActive.value ? groupButtonRef.value : modeButtonRef.value;
  if (restoreFocus) trigger?.focus({preventScroll: true});
}

function togglePanel(event) {
  if (panelOpen.value) closePanel(false);
  else openPanel(event.pointerType !== 'touch');
}

// ---- 选择 ----
function revealActiveFloor() {
  const list = floorButtonsRef.value;
  const viewport = list?.parentElement;
  const selected = list?.querySelector(activeFloorSelector);
  if (!viewport || !selected) return;

  keepFloorVisible = true;
  // 只调整楼层列表自身，避免 scrollIntoView 连带移动外层地图。
  const {top: visibleTop, bottom: visibleBottom} = viewport.getBoundingClientRect();
  const {top, bottom} = selected.getBoundingClientRect();
  if (top < visibleTop) viewport.scrollTop += Math.floor(top - visibleTop);
  else if (bottom > visibleBottom) viewport.scrollTop += Math.ceil(bottom - visibleBottom);
}

watch(floorButtonsRef, (list, _, onCleanup) => {
  const viewport = list?.parentElement;
  if (!viewport) return;
  let height = viewport.clientHeight;
  const updateEdges = () => {
    moreFloorsAbove.value = viewport.scrollTop > 1;
    moreFloorsBelow.value = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1;
  };
  const rememberVisibility = () => {
    updateEdges();
    if (viewport.clientHeight !== height || height === 0) return;
    const floor = list.querySelector(activeFloorSelector)?.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    if (floor) keepFloorVisible = floor.top >= bounds.top && floor.bottom <= bounds.bottom;
  };
  // 只在尺寸变化时维持本来可见的选中层，用户自由滚走的视图不改。
  const observer = new ResizeObserver(() => {
    const nextHeight = viewport.clientHeight;
    if (nextHeight === 0) return;
    updateEdges();
    if (nextHeight === height) return;
    height = nextHeight;
    if (keepFloorVisible) revealActiveFloor();
  });
  observer.observe(viewport);
  observer.observe(list);
  updateEdges();
  viewport.addEventListener('scroll', rememberVisibility, {passive: true});
  onCleanup(() => {
    observer.disconnect();
    viewport.removeEventListener('scroll', rememberVisibility);
  });
}, {flush: 'post'});

function chooseGroup(group) {
  selectGroup(group.key);
  closePanel(true);
  emitFocus();
  void nextTick(revealActiveFloor);
}

function chooseFloor(level) {
  const changed = level !== state.activeFloorLevel;
  selectFloor(level);
  if (changed) emitFocus();
  void nextTick(revealActiveFloor);
}

function toggleMode(event) {
  if (layerModeActive.value) {
    closePanel(false);
    exitLayers();
    return;
  }
  if (panelOpen.value) {
    closePanel(true);
    return;
  }
  enterLayers();
  if (!activeGroup.value) openPanel(event.pointerType !== 'touch');
  else {
    emitFocus();
    void nextTick(revealActiveFloor);
  }
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

// 面板打开期间接管 Escape 并将焦点还给触发按钮。经 escapeStack
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

watch(ready, (value) => {
  if (!value) closePanel(false);
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
    <div class="bar map-glass">
      <LiquidGlass variant="clear" />
      <button
        ref="modeButtonRef"
        type="button"
        class="mode"
        :class="{on: layerModeActive}"
        :aria-haspopup="layerModeActive ? undefined : 'listbox'"
        :aria-expanded="layerModeActive ? undefined : panelOpen"
        :aria-controls="!layerModeActive && panelOpen ? 'layer-group-panel' : undefined"
        aria-label="切换分层地图"
        :title="layerModeActive ? '退出分层地图（回地面）' : '进入分层地图'"
        @click="toggleMode"
      >
        <svg v-if="!layerModeActive" viewBox="0 0 24 24" class="layer-icon" aria-hidden="true">
          <path d="m12 2 10 7-10 7L2 9l10-7ZM2 14l10 7 10-7"
                fill="none" stroke="currentColor" stroke-width="1.55"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ layerModeActive ? '退出' : '分层' }}
      </button>
      <button
        v-if="layerModeActive"
        ref="groupButtonRef"
        type="button"
        class="group"
        aria-haspopup="listbox"
        :aria-expanded="panelOpen ? 'true' : 'false'"
        :aria-controls="panelOpen ? 'layer-group-panel' : undefined"
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

    <Transition :css="false" v-bind="panelMotion">
      <div v-show="panelOpen" id="layer-group-panel" class="panel map-glass"
           :inert="!panelOpen" :data-panel-open="panelOpen ? '' : undefined">
        <LiquidGlass />
        <div class="liquid-panel-body">
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
      </div>
    </Transition>

    <Teleport :to="floorHost ?? 'body'" :disabled="!floorHost">
      <div
        v-if="layerModeActive && floorOptions.length > 0"
        v-show="!panelOpen"
        class="floors map-glass"
        :class="{'more-floors-above': moreFloorsAbove, 'more-floors-below': moreFloorsBelow}"
      >
        <LiquidGlass />
        <p v-if="floorOptions.length > 1" class="floor-count">共 {{ floorOptions.length }} 层</p>
        <ScrollPane label="楼层列表滚动">
          <div ref="floorButtonsRef" class="floor-buttons" role="group" aria-label="分层楼层">
            <button
              v-for="floor in floorOptions"
              :key="floor.level"
              type="button"
              class="floor"
              :class="{active: floor.level === state.activeFloorLevel}"
              :aria-pressed="floor.level === state.activeFloorLevel ? 'true' : 'false'"
              :title="activeGroup?.unnamed ? floor.label : floor.name ?? floor.label"
              @click="chooseFloor(floor.level)"
            >{{ floor.label }}</button>
          </div>
        </ScrollPane>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.layer-picker {
  min-inline-size: 0;
}

.bar {
  display: flex;
  align-items: stretch;
  gap: var(--space-1);
  padding: 5px;
  border-radius: 19px;
}

.mode {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  height: 44px;
  min-width: 48px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, color 120ms ease;
}

.mode:not(.on) {
  min-width: 94px;
  padding-inline: 14px;
  font-size: 16px;
  font-weight: 500;
}

.layer-icon {
  width: 24px;
  height: 24px;
  flex: none;
}

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .bar {
    border-radius: var(--radius-card);
  }

  /* 窄窗隐藏图标后，两字标签（分层/退出）在 48px 宽里被 16px 内边距挤出：
     收窄内边距并放宽最小宽度，保持 ≥48px 触控目标且文字完整居中。 */
  .mode:not(.on) {
    min-width: 56px;
    padding-inline: 8px;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }

  .mode {
    border-radius: inherit;
  }

  .layer-icon {
    display: none;
  }
}

.mode:hover {
  background: var(--control-hover);
}

.mode:active {
  background-color: var(--control-active);
}

.mode.on {
  background-image: var(--control-selected);
  color: var(--text-primary);
}

.group {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-inline-size: 0;
  max-width: min(250px, 42vw);
  height: 44px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.group:hover {
  background: var(--control-hover);
}

.group:active {
  background: var(--control-active);
}

.group:focus-visible,
.mode:focus-visible {
  background-color: var(--control-focus);
}

.group-label {
  min-width: 0;
  max-width: 34vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group svg {
  flex: none;
}

.panel {
  position: absolute;
  top: calc(var(--map-toolbar-row-height) + var(--map-toolbar-row-gap));
  inset-inline-start: 0;
  width: min(320px, calc(100vw - var(--map-toolbar-left) - var(--map-toolbar-right)));
  border-radius: var(--radius-card);
}

.search {
  box-sizing: border-box;
  min-height: 44px;
  width: calc(100% - 16px);
  margin: var(--space-1) var(--space-1) 0;
  padding: 0 var(--space-1);
  border: 0;
  border-radius: var(--radius-control);
  background: var(--control-hover);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
}

.search::placeholder {
  color: var(--text-secondary);
}

.search:focus {
  background: var(--control-focus);
}

@media (pointer: coarse) {
  .search {
    font-size: 16px;
  }
}

.group-scroll {
  --pane-limit: min(320px, 46vh);
  margin-inline-end: 6px;
  padding-block-end: 10px;
}

.options {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
}

.options li {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
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
  background-image: var(--control-selected);
  color: var(--text-primary);
  font-weight: 600;
}

.no-match {
  margin: 0;
  padding: var(--space-2);
  font-size: 14px;
  color: var(--text-secondary);
}

.floors {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  --pane-limit: min(58vh, 466px);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.floors > :not(.liquid-glass) {
  animation: ui-fade-in 200ms ease-out;
}

.floors .scroll-pane {
  margin-inline: 3px;
  padding-block-end: 8px;
}

.floor-buttons {
  display: flex;
  flex-direction: column;
  padding: var(--space-1);
}

.floor-count {
  display: none;
}

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .floors {
    --floor-rail-limit: min(22dvh, 148px);
    --pane-limit: var(--floor-rail-limit);
    --floor-mask-start: #000;
    --floor-mask-end: #000;
  }

  .floor-count {
    display: block;
    margin: 0;
    line-height: 24px;
    text-align: center;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .floors:has(.floor-count) .scroll-pane {
    --pane-limit: max(44px, calc(var(--floor-rail-limit) - 24px));
  }

  .floors.more-floors-above {
    --floor-mask-start: transparent;
  }

  .floors.more-floors-below {
    --floor-mask-end: transparent;
  }

  .floors .scroll-pane {
    mask-image: linear-gradient(to bottom, var(--floor-mask-start), #000 10px,
      #000 calc(100% - 10px), var(--floor-mask-end));
  }
}

.floor {
  box-sizing: border-box;
  width: 48px;
  min-height: 44px;
  padding: 0 var(--space-1);
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
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

.floor:active {
  background-color: var(--control-active);
}

.floor:focus-visible {
  background: var(--control-focus);
}

.floor.active {
  background-image: var(--control-selected);
  color: var(--text-primary);
  font-weight: 600;
}

.floor.active:focus-visible {
  background-color: var(--control-focus);
}
</style>
