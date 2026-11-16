<script setup>
// 区域名提示沿指针定位，键盘焦点使用区域中心。
// id1 对查看无益，不直接展示，仅挂 data-region-id 供调试与无头验收定位；
// 音乐状态只在调用方传入实证 state 时出现，缺省不占位、不猜测。
import {computed, onBeforeUnmount, onMounted, reactive, ref} from 'vue';
import LiquidGlass from './LiquidGlass.vue';

const props = defineProps({
  label: {type: String, required: true},
  id1: {type: [Number, String], required: true},
  bgmState: {type: String, default: null},
  x: {type: Number, required: true},
  y: {type: Number, required: true},
  viewport: {type: Object, default: null},
});

const CURSOR_GAP = 28;
const MAP_INSET = 8;
const rootRef = ref(null);
const size = reactive({width: 0, height: 0});
const bounds = reactive({width: 0, height: 0});
const avoidance = ref(null);
let observer;

onMounted(() => {
  const tooltip = rootRef.value;
  const map = tooltip.offsetParent;
  if (!map) return;
  const player = map.parentElement?.querySelector('.music-player');
  const measure = () => {
    size.width = tooltip.offsetWidth;
    size.height = tooltip.offsetHeight;
    bounds.width = map.clientWidth;
    bounds.height = map.clientHeight;
    if (player?.isConnected) {
      const frame = map.getBoundingClientRect();
      const panel = player.getBoundingClientRect();
      avoidance.value = {
        left: panel.left - frame.left,
        top: panel.top - frame.top,
        right: panel.right - frame.left,
        bottom: panel.bottom - frame.top,
      };
    } else {
      avoidance.value = null;
    }
  };
  measure();
  observer = new ResizeObserver(measure);
  observer.observe(tooltip);
  observer.observe(map);
  if (player) observer.observe(player);
});

onBeforeUnmount(() => observer?.disconnect());

// Stay to one side of the real hotspot. Clamping the other axis keeps the
// tooltip in view without shifting it under the cursor near a corner.
const placementStyle = computed(() => {
  const {x, y} = props;
  const {width: w, height: h} = size;
  const {width, height} = props.viewport ?? bounds;
  const clamp = (value, limit) => Math.max(MAP_INSET, Math.min(value, limit - MAP_INSET));
  const maxX = width - w;
  const maxY = height - h;
  const right = x + CURSOR_GAP;
  const left = x - w - CURSOR_GAP;
  const below = y + CURSOR_GAP;
  const above = y - h - CURSOR_GAP;
  const candidates = [
    [right, clamp(below, maxY)],
    [left, clamp(below, maxY)],
    [clamp(x - w / 2, maxX), below],
    [clamp(x - w / 2, maxX), above],
  ];
  const panel = avoidance.value;
  const position = candidates.find(([px, py]) => {
    if (px < MAP_INSET || px > maxX - MAP_INSET
      || py < MAP_INSET || py > maxY - MAP_INSET) return false;
    return !panel || px + w + MAP_INSET <= panel.left || px >= panel.right + MAP_INSET
      || py + h + MAP_INSET <= panel.top || py >= panel.bottom + MAP_INSET;
  });
  if (!position || w === 0 || h === 0) return {visibility: 'hidden'};
  return {left: `${position[0]}px`, top: `${position[1]}px`};
});
</script>

<template>
  <div
    ref="rootRef"
    class="region-tooltip map-glass"
    :style="placementStyle"
    :data-region-id="id1"
    role="status"
  >
    <LiquidGlass />
    <span class="name">{{ label }}</span>
    <span v-if="bgmState" class="bgm">
      <span class="bgm-text">{{ bgmState }}</span>
    </span>
  </div>
</template>

<style scoped>
.region-tooltip {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  padding: 6px 10px;
  border-radius: var(--radius-control);
  width: max-content;
  max-width: min(220px, calc(100% - 16px));
}

.name {
  font-size: 14px;
  line-height: 1.5;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.bgm {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.bgm-text {
  overflow-wrap: anywhere;
}
</style>
