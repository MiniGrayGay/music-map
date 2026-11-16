<script setup>
// 地图控制：放大 / 缩小 / 复位 / 平滑边线。+/− 成对一格，复位
// 独立一格；命中区 44×44 满足触屏最低标准。复位按钮的名称跟随真实行为：
// 地表模式复位到全图，分层模式复位到当前楼层的贴片范围。
import {computed, ref} from 'vue';
import LiquidGlass from './LiquidGlass.vue';

const props = defineProps({
  canZoomIn: {type: Boolean, required: true},
  canZoomOut: {type: Boolean, required: true},
  layerMode: {type: Boolean, default: false},
  globeMode: {type: Boolean, default: false},
  resetLabel: {type: String, default: ''},
});
const smoothBoundaries = defineModel('smoothBoundaries', {type: Boolean, required: true});
const emit = defineEmits(['zoom-in', 'zoom-out', 'reset']);
const resetLabel = computed(() => props.resetLabel
  || (props.globeMode ? '复位星球' : props.layerMode ? '复位到当前楼层' : '复位到全图'));
const glass = ref(null);
function reactToControl(event) {
  const button = event.target.closest('button');
  if (button && !button.disabled) glass.value?.reactAt(button, event.detail ? event : null);
}
</script>

<template>
  <div class="zoom-controls map-glass" role="group" aria-label="地图视图控制" @click="reactToControl">
    <LiquidGlass ref="glass" variant="clear" />
    <div class="pair">
      <button type="button" :disabled="!canZoomIn" aria-label="放大" title="放大" @click="emit('zoom-in')">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" />
        </svg>
      </button>
      <button type="button" :disabled="!canZoomOut" aria-label="缩小" title="缩小" @click="emit('zoom-out')">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <button type="button" class="reset" :aria-label="resetLabel" :title="resetLabel" @click="emit('reset')">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3"
              fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
              stroke-linejoin="round" />
      </svg>
    </button>
    <button
      v-if="!globeMode"
      type="button"
      class="smoothing"
      aria-label="平滑边线"
      :aria-pressed="smoothBoundaries"
      :title="smoothBoundaries ? '关闭边线平滑' : '开启边线平滑'"
      @click="smoothBoundaries = !smoothBoundaries"
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path :d="smoothBoundaries ? 'M2 12h2a4 4 0 0 0 4-4 4 4 0 0 1 4-4h2' : 'M2 12h6V4h6'"
              fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.zoom-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  border-radius: var(--radius-card);
}

/* 放大和缩小为一组，复位与其留出间距。 */
.pair,
.reset,
.smoothing {
  border-radius: var(--radius-control);
}

.pair {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

@media (max-width: 700px), (pointer: coarse) {
  .zoom-controls .pair {
    display: none;
  }
}

@media (min-width: 701px) and (min-height: 560px) and (pointer: fine) {
  .zoom-controls {
    gap: 0;
    padding: 1px 0;
    border-radius: 20px;
  }

  .pair {
    gap: 0;
  }

  .zoom-controls button {
    width: 60px;
    height: 60px;
  }

  .zoom-controls button svg {
    width: 22px;
    height: 22px;
  }
}

button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, color 120ms ease, transform 150ms var(--ease-glass-in);
}

.pair button {
  border-radius: var(--radius-control);
}

button:hover:not(:disabled) {
  background: var(--control-hover);
}

button:active:not(:disabled) {
  background: var(--control-active);
  transform: scale(.94);
}

button:focus-visible {
  background: var(--control-focus);
}

.smoothing[aria-pressed='true'] {
  background-image: var(--control-selected);
}

.smoothing:focus-visible {
  background: var(--control-focus);
}

button:disabled {
  color: var(--text-secondary);
  opacity: 0.4;
  cursor: default;
}
</style>
