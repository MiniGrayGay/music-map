<script setup>
// 地图控制：放大 / 缩小 / 复位。制图工具式紧凑竖排：+/− 成对一格，复位
// 独立一格；命中区 44×44 满足触屏最低标准。复位按钮的名称跟随真实行为：
// 地表模式复位到全图，分层模式复位到当前楼层的贴片范围。
import {computed} from 'vue';

const props = defineProps({
  canZoomIn: {type: Boolean, required: true},
  canZoomOut: {type: Boolean, required: true},
  layerMode: {type: Boolean, default: false},
});
const emit = defineEmits(['zoom-in', 'zoom-out', 'reset']);
const resetLabel = computed(() => props.layerMode ? '复位到当前楼层' : '复位到全图');
</script>

<template>
  <div class="zoom-controls" role="group" aria-label="地图缩放控制">
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
  </div>
</template>

<style scoped>
.zoom-controls {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 5px;
  border-radius: 12px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-overlay-border);
  backdrop-filter: blur(6px);
  box-shadow: 0 8px 24px rgba(4, 8, 14, 0.4);
}

/* 工具格：+ / − 共享一格，发丝线分隔；复位独立一格。 */
.pair,
.reset {
  border-radius: 8px;
  background: rgba(214, 226, 240, 0.04);
}

.pair {
  display: flex;
  flex-direction: column;
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
  transition: background-color 120ms ease, color 120ms ease;
}

.pair button + button {
  border-top: 1px solid var(--surface-overlay-border);
}

.pair button:first-child {
  border-radius: 8px 8px 0 0;
}

.pair button:last-child {
  border-radius: 0 0 8px 8px;
}

button:hover:not(:disabled) {
  background: var(--control-hover);
}

button:active:not(:disabled) {
  background: rgba(155, 232, 241, 0.24);
}

button:focus-visible {
  outline: 2px solid var(--control-focus);
  outline-offset: -2px;
  background: var(--control-hover);
}

button:disabled {
  color: var(--text-secondary);
  opacity: 0.4;
  cursor: default;
}
</style>
