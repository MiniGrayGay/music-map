<script setup>
// 共享自绘选择控件（button + Teleport 弹层 listbox）：替代可见的原生
// <select>。触发器保留焦点，方向键/Home/End 移动活动项，Enter/Space 选中，
// Escape 经 escapeStack 只关本弹层；点外部关闭；选项列表滚动复用
// ScrollPane 的原生滚动与预留槽位。弹层 fixed 定位到 body，避免被抽屉的滚动
// 容器裁剪，空间不足时向上翻转。
import {computed, nextTick, onBeforeUnmount, ref, useId, watch} from 'vue';
import LiquidGlass from './LiquidGlass.vue';
import ScrollPane from './ScrollPane.vue';
import {pushEscapeHandler} from './escapeStack.js';
import {useAnchoredPanel} from './panelMotion.js';

const props = defineProps({
  modelValue: {type: [Number, String], default: null},
  options: {type: Array, required: true}, // [{value, label, meta?}]
  ariaLabel: {type: String, required: true},
  placeholder: {type: String, default: ''},
  glass: {type: Boolean, default: false},
  // 'auto' 优先下方、空间不足翻上；'top' 优先上方（下方播放器等状态需要
  // 与选项同屏可见的场景），上方空间不足才回退向下。
  placement: {type: String, default: 'auto'},
});
const emit = defineEmits(['update:modelValue']);

const listboxId = useId();
const triggerRef = ref(null);
const popupRef = ref(null);
const listRef = ref(null);
const open = ref(false);
const activeIndex = ref(0);
const popupStyle = ref(null);
const popupMotion = useAnchoredPanel(() => triggerRef.value);

const selected = computed(() =>
  props.options.find((option) => option.value === props.modelValue) ?? null);
const triggerLabel = computed(() => selected.value?.label ?? props.placeholder);

let releaseEscape = null;
let trackRafId = 0;

function optionId(index) {
  return `${listboxId}-opt-${index}`;
}

// 触发器可能因兄弟内容增删而移动（如播放器昼/夜行消失）：弹层打开期间
// 逐帧跟随触发器位置，避免 fixed 弹层与触发器错位。
function trackTrigger() {
  cancelAnimationFrame(trackRafId);
  let lastTop = -1;
  let lastLeft = -1;
  const tick = () => {
    const rect = triggerRef.value?.getBoundingClientRect();
    if (rect && open.value && (rect.top !== lastTop || rect.left !== lastLeft)) {
      lastTop = rect.top;
      lastLeft = rect.left;
      positionPopup();
    }
    if (open.value) trackRafId = requestAnimationFrame(tick);
  };
  trackRafId = requestAnimationFrame(tick);
}

function positionPopup() {
  const trigger = triggerRef.value;
  if (!trigger || !trigger.isConnected) {
    close();
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const gap = 6;
  const width = Math.max(rect.width, 168);
  const maxList = Math.min(320, window.innerHeight - 24);
  const below = window.innerHeight - rect.bottom - gap - 12;
  const above = rect.top - gap - 12;
  const minUsable = 160;
  const upward = props.placement === 'top'
    ? above >= minUsable
    : below < minUsable && above > below;
  const listHeight = Math.max(96, Math.min(maxList, upward ? above : below));
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  popupStyle.value = {
    left: `${left}px`,
    width: `${width}px`,
    '--pane-limit': `${Math.max(72, listHeight - 10)}px`,
    ...(upward
      ? {bottom: `${window.innerHeight - rect.top + gap}px`}
      : {top: `${rect.bottom + gap}px`}),
  };
}

function scrollActiveIntoView() {
  listRef.value?.querySelectorAll('li[role="option"]')[activeIndex.value]
    ?.scrollIntoView({block: 'nearest'});
}

async function openPopup() {
  if (open.value) return;
  open.value = true;
  activeIndex.value = Math.max(0, props.options.findIndex(
    (option) => option.value === props.modelValue));
  positionPopup();
  trackTrigger();
  await nextTick();
  scrollActiveIntoView();
  releaseEscape = pushEscapeHandler(() => {
    if (!open.value) return false;
    close();
    return true;
  });
}

function close() {
  if (!open.value) return;
  open.value = false;
  cancelAnimationFrame(trackRafId);
  releaseEscape?.();
  releaseEscape = null;
}

function toggle() {
  if (open.value) close();
  else void openPopup();
}

function choose(option) {
  close();
  if (option.value !== props.modelValue) emit('update:modelValue', option.value);
  triggerRef.value?.focus({preventScroll: true});
}

function onTriggerKeydown(event) {
  const count = props.options.length;
  const move = (delta) => {
    event.preventDefault();
    activeIndex.value = Math.min(count - 1, Math.max(0, activeIndex.value + delta));
    scrollActiveIntoView();
  };
  switch (event.key) {
    case 'ArrowDown': event.preventDefault(); if (!open.value) void openPopup(); else move(1); break;
    case 'ArrowUp': event.preventDefault(); if (!open.value) void openPopup(); else move(-1); break;
    case 'Home': if (open.value) { event.preventDefault(); activeIndex.value = 0; scrollActiveIntoView(); } break;
    case 'End': if (open.value) { event.preventDefault(); activeIndex.value = Math.max(0, count - 1); scrollActiveIntoView(); } break;
    case 'Enter': if (open.value) { event.preventDefault(); choose(props.options[activeIndex.value]); } break;
    case ' ': if (open.value) { event.preventDefault(); choose(props.options[activeIndex.value]); } break;
    case 'Tab': if (open.value) close(); break;
    default: break;
  }
}

// 外部点击（含其他弹层）关闭；弹层内部 pointerdown 阻止焦点转移。
function onDocPointerDown(event) {
  if (open.value && !popupRef.value?.contains(event.target)
    && event.target !== triggerRef.value && !triggerRef.value?.contains(event.target)) {
    close();
  }
}

watch(() => props.options, () => {
  if (!open.value) return;
  activeIndex.value = Math.min(activeIndex.value, Math.max(0, props.options.length - 1));
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('scroll', onAnyScroll, true);
  window.removeEventListener('resize', positionPopup);
  cancelAnimationFrame(trackRafId);
  releaseEscape?.();
});

function onAnyScroll() {
  if (open.value) positionPopup();
}

watch(open, (value) => {
  if (value) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('scroll', onAnyScroll, true);
    window.addEventListener('resize', positionPopup);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('scroll', onAnyScroll, true);
    window.removeEventListener('resize', positionPopup);
  }
});
</script>

<template>
  <div class="select-menu">
    <button
      ref="triggerRef"
      type="button"
      class="select-trigger"
      :class="{'map-glass glassed': glass}"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="open ? listboxId : null"
      :aria-activedescendant="open && options.length > 0 ? optionId(activeIndex) : null"
      :aria-label="ariaLabel"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <LiquidGlass v-if="glass" variant="clear" :light=".87" />
      <span class="select-value" :data-empty="!selected ? '' : null">{{ triggerLabel }}</span>
      <span class="select-arrow" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round" :class="{up: open}" />
        </svg>
      </span>
    </button>
    <Teleport to="body">
      <Transition :css="false" v-bind="glass ? popupMotion : {}">
        <div
          v-show="open"
          :id="listboxId"
          ref="popupRef"
          :inert="!open"
          class="select-popup"
          :class="{'map-glass glassed': glass}"
          role="listbox"
          :aria-label="ariaLabel"
          :style="popupStyle"
          @pointerdown.prevent
        >
          <LiquidGlass v-if="glass" />
          <ScrollPane class="select-scroll liquid-panel-body" :label="`${ariaLabel}选项滚动`">
            <ul ref="listRef" class="select-options">
              <li
                v-for="(option, index) in options"
                :id="optionId(index)"
                :key="option.value"
                role="option"
                :aria-selected="option.value === modelValue ? 'true' : 'false'"
                :class="{active: index === activeIndex, chosen: option.value === modelValue}"
                :title="option.label"
                @click="choose(option)"
                @pointermove="activeIndex = index"
              >
                <span class="option-label">{{ option.label }}</span>
                <span v-if="option.meta" class="option-meta">{{ option.meta }}</span>
              </li>
            </ul>
          </ScrollPane>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.select-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  background: var(--glass-light), var(--surface-overlay);
  -webkit-backdrop-filter: var(--glass-effect);
  backdrop-filter: var(--glass-effect);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.select-trigger:hover,
.select-trigger[aria-expanded='true'] { background: var(--glass-light), var(--surface-overlay-open); }
.select-trigger:active { background: var(--glass-light), var(--surface-overlay-open); }
.select-trigger:focus-visible {
  background: linear-gradient(var(--control-focus), var(--control-focus)), var(--surface-overlay-open);
}
.select-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
}
.select-value[data-empty] { color: var(--text-secondary); }
.select-arrow {
  display: grid;
  place-items: center;
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--text-secondary);
}
.select-arrow path {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform 120ms ease;
}
.select-arrow path.up { transform: rotate(180deg); }

.select-popup {
  position: fixed;
  z-index: 40;
  padding: var(--space-1);
  border-radius: var(--radius-card);
  background: var(--glass-light), var(--surface-raised);
  -webkit-backdrop-filter: var(--glass-effect);
  backdrop-filter: var(--glass-effect);
  box-shadow: var(--shadow-glass);
  transform-origin: top center;
  animation: ui-glass-pop var(--glass-reveal-duration) var(--ease-glass-in);
}
.select-options {
  list-style: none;
  margin: 0;
  padding: 0;
}
.select-options li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  min-height: 44px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  cursor: pointer;
  border: 0;
}
.select-options li .option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.select-options li .option-meta {
  flex: none;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.select-options li:hover,
.select-options li.active { background: var(--control-hover); }
.select-options li.chosen {
  background-image: var(--control-selected);
  color: var(--text-primary);
  font-weight: 600;
}
.select-trigger.glassed, .select-popup.glassed {
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: none;
}
.select-trigger.glassed { border-radius: 18px; }
.select-popup.glassed {
  position: absolute;
  z-index: auto;
  animation: none;
}
.select-trigger.glassed:focus-visible { outline: 2px solid var(--text-secondary); outline-offset: -2px; }

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .select-trigger.glassed {
    border-radius: var(--radius-card);
    padding-inline: 12px 8px;
    -webkit-tap-highlight-color: transparent;
  }

  .select-popup.glassed {
    padding: 6px;
  }

}
</style>
