<script setup>
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
  switching: {type: Boolean, default: false},
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
const panelOpen = ref(false);
const panelMotion = useAnchoredPanel(() => groupButtonRef.value ?? modeButtonRef.value);
const query = ref('');
const openedViewport = ref(null);
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
  panelOpen.value = true;
  query.value = '';
  const chosen = visibleGroups.value.findIndex((group) => group.key === activeGroupId.value);
  highlightIndex.value = chosen >= 0 ? chosen : 0;
  if (focusSearch) void nextTick(() => searchRef.value?.focus({preventScroll: true}));
}

function closePanel(restoreFocus) {
  if (!panelOpen.value) return;
  panelOpen.value = false;
  if (restoreFocus) (groupButtonRef.value ?? modeButtonRef.value)?.focus({preventScroll: true});
}

function togglePanel(event) {
  if (panelOpen.value) closePanel(false);
  else openPanel(event.pointerType !== 'touch');
}

// ---- 选择 ----
function revealActiveFloor() {
  const list = floorButtonsRef.value;
  const selected = list?.querySelector('[aria-pressed="true"]');
  if (!selected) return;
  const bounds = list.getBoundingClientRect();
  const {left, right} = selected.getBoundingClientRect();
  if (left < bounds.left) list.scrollLeft += Math.floor(left - bounds.left);
  else if (right > bounds.right) list.scrollLeft += Math.ceil(right - bounds.right);
}

function chooseGroup(group) {
  if (props.switching) return;
  closePanel(true);
  if (group.key === activeGroupId.value) return;
  if (!layerModeActive.value && group.key === state.lastGroupKey) enterLayers();
  else selectGroup(group.key);
  emitFocus();
  void nextTick(revealActiveFloor);
}

function chooseFloor(level) {
  if (props.switching || level === state.activeFloorLevel) return;
  selectFloor(level);
  emitFocus();
  void nextTick(revealActiveFloor);
}

function returnToSurface() {
  closePanel(false);
  exitLayers();
  void nextTick(() => modeButtonRef.value?.focus({preventScroll: true}));
}

function toggleMode(event) {
  if (layerModeActive.value) {
    returnToSurface();
    return;
  }
  if (props.switching) return;
  if (!panelOpen.value) {
    enterLayers();
    if (activeGroup.value) {
      emitFocus();
      void nextTick(revealActiveFloor);
      return;
    }
  }
  togglePanel(event);
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
  if (event.key === 'Escape' && !panelOpen.value && layerModeActive.value) {
    event.preventDefault();
    returnToSurface();
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
        :aria-expanded="layerModeActive ? undefined : panelOpen"
        :aria-controls="layerModeActive ? undefined : 'layer-group-panel'"
        :aria-label="layerModeActive ? '退出分层' : '切换分层地图'"
        :aria-disabled="!layerModeActive && switching || undefined"
        @click="toggleMode"
      >
        <svg v-if="!layerModeActive" viewBox="0 0 24 24" class="layer-icon" aria-hidden="true">
          <path d="m12 2 10 7-10 7L2 9l10-7ZM2 14l10 7 10-7"
                fill="none" stroke="currentColor" stroke-width="1.55"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ layerModeActive ? '退出' : '分层' }}
        <svg v-if="!layerModeActive" :class="{rotated: panelOpen}" viewBox="0 0 16 16" class="caret" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        v-if="layerModeActive"
        ref="groupButtonRef"
        type="button"
        class="group"
        aria-label="分层区域"
        :title="activeGroup?.label"
        :aria-disabled="switching || undefined"
        :aria-expanded="panelOpen"
        aria-controls="layer-group-panel"
        @click="!switching && togglePanel($event)"
      >
        <span class="group-label">{{ activeGroup?.label }}</span>
        <svg :class="{rotated: panelOpen}" viewBox="0 0 16 16" class="caret" aria-hidden="true">
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
      <Transition name="floor-tools">
        <div
          v-if="layerModeActive && floorOptions.length > 0"
          v-show="!panelOpen"
          class="floors map-glass"
          :inert="panelOpen || !layerModeActive"
          @pointerdown.stop
          @wheel.stop
          @keydown="onRootKeydown"
        >
          <LiquidGlass />
          <div ref="floorButtonsRef" class="floor-buttons" role="group" aria-label="地图楼层">
            <button
              v-for="floor in floorOptions"
              :key="floor.level"
              type="button"
              class="floor"
              :aria-pressed="floor.level === state.activeFloorLevel"
              :aria-disabled="switching || undefined"
              :title="activeGroup?.unnamed ? floor.label : floor.name ?? floor.label"
              @click="chooseFloor(floor.level)"
            >{{ floor.label }}</button>
          </div>
          <span v-if="floorOptions.length > 1" class="floor-count">共 {{ floorOptions.length }} 层</span>
        </div>
      </Transition>
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
  gap: 4px;
  padding: 5px;
  border-radius: 19px;
}

.mode,
.group {
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

.mode {
  flex: none;
  min-width: 66px;
  padding-inline: 12px;
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

  .mode,
  .group {
    padding-inline: 9px;
    gap: 5px;
    font-size: 14px;
  }

  .layer-icon {
    display: none;
  }
}

.mode:hover:not([aria-disabled="true"]),
.group:hover:not([aria-disabled="true"]) {
  background: var(--control-hover);
}

.mode:active,
.group:active {
  background-color: var(--control-active);
}

.mode:focus-visible,
.group:focus-visible {
  background-color: var(--control-focus);
}

.group {
  min-width: 0;
  max-width: min(180px, 36vw);
  gap: 6px;
  font-weight: 500;
}

.group-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  flex: none;
  width: 14px;
  height: 14px;
  transition: transform 200ms ease;
}

.caret.rotated {
  transform: rotate(180deg);
}

[aria-disabled="true"] {
  cursor: default;
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
  top: var(--floor-tools-top, 83px);
  inset-inline-start: var(--floor-tools-left, var(--map-inline-inset));
  max-inline-size: min(360px, calc(100% - var(--floor-tools-left, var(--map-inline-inset)) - var(--floor-tools-right, 20px)));
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: max-content;
  padding: 5px;
  border-radius: var(--radius-card);
}

.floor-tools-enter-active,
.floor-tools-leave-active {
  transition: opacity 180ms ease, translate 180ms ease;
}

.floor-tools-enter-from,
.floor-tools-leave-to {
  opacity: 0;
  translate: 0 -4px;
}

.floor-tools-leave-active {
  pointer-events: none;
}

.floor-count {
  flex: none;
  padding-inline: 3px 6px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 20px;
}

.floor-buttons {
  display: flex;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--control-focus) transparent;
}

@media (pointer: coarse) {
  .floor-buttons { scrollbar-width: none; }
}

@media (prefers-reduced-motion: reduce) {
  .floor-tools-enter-active,
  .floor-tools-leave-active,
  .caret {
    transition: none;
  }
}

.floor {
  box-sizing: border-box;
  flex: none;
  min-width: 44px;
  min-height: 44px;
  padding: 0 var(--space-1);
  border: 0;
  border-radius: var(--radius-control);
  background: var(--control-hover);
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

.floor:hover:not([aria-disabled="true"]) {
  background: var(--control-focus);
  color: var(--text-primary);
}

.floor:active {
  background-color: var(--control-active);
}

.floor:focus-visible {
  background: var(--control-focus);
}

.floor[aria-pressed="true"] {
  background-image: var(--control-selected);
  color: var(--text-primary);
  font-weight: 600;
}

.floor[aria-pressed="true"]:focus-visible {
  background-color: var(--control-focus);
}
</style>
