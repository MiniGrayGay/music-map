<script setup>
import {computed, onBeforeUnmount, onMounted, ref, useId} from 'vue';

defineProps({label: {type: String, required: true}});

const paneId = useId();
const viewport = ref(null);
const content = ref(null);
const rail = ref(null);
const height = ref(0);
const extent = ref(0);
const offset = ref(0);
let observer;
let drag = null;

const maximum = computed(() => Math.max(0, extent.value - height.value));
const thumbHeight = computed(() => Math.max(28, height.value ** 2 / (extent.value || 1)));
const thumbTravel = computed(() => Math.max(0, height.value - thumbHeight.value));
const thumbTop = computed(() => maximum.value ? offset.value / maximum.value * thumbTravel.value : 0);

function measure() {
  const element = viewport.value;
  height.value = element.clientHeight;
  extent.value = element.scrollHeight;
  offset.value = element.scrollTop;
}

onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  observer.observe(viewport.value);
  observer.observe(content.value);
});
onBeforeUnmount(() => observer?.disconnect());

function scrollTo(point) {
  viewport.value.scrollTop = Math.max(0, Math.min(maximum.value, point));
  offset.value = viewport.value.scrollTop;
}

function jump(clientY, grip) {
  if (thumbTravel.value <= 0) return;
  const y = clientY - rail.value.getBoundingClientRect().top - grip;
  scrollTo(y / thumbTravel.value * maximum.value);
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const mouseY = event.clientY - rail.value.getBoundingClientRect().top;
  const inThumb = mouseY >= thumbTop.value && mouseY <= thumbTop.value + thumbHeight.value;
  const grip = inThumb ? mouseY - thumbTop.value : thumbHeight.value / 2;
  drag = {id: event.pointerId, grip};
  rail.value.setPointerCapture(event.pointerId);
  if (!inThumb) jump(event.clientY, grip);
}

function onPointerMove(event) {
  if (drag?.id === event.pointerId) jump(event.clientY, drag.grip);
}

function endDrag() {
  drag = null;
}

function onWheel(event) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height.value : 1;
  scrollTo(offset.value + event.deltaY * unit);
}

function onKeydown(event) {
  const movement = {
    ArrowUp: offset.value - 32,
    ArrowDown: offset.value + 32,
    PageUp: offset.value - height.value,
    PageDown: offset.value + height.value,
    Home: 0,
    End: maximum.value,
  }[event.key];
  if (movement === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  scrollTo(movement);
}
</script>

<template>
  <div class="scroll-pane">
    <div :id="paneId" ref="viewport" class="scroll-viewport" @scroll.passive="measure">
      <div ref="content" class="scroll-content">
        <slot />
      </div>
    </div>
    <div
      v-if="maximum > 0.5"
      ref="rail"
      class="scroll-rail"
      role="scrollbar"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="label"
      :aria-controls="paneId"
      :aria-valuemin="0"
      :aria-valuemax="Math.ceil(maximum)"
      :aria-valuenow="Math.round(offset)"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @lostpointercapture="endDrag"
      @wheel.prevent="onWheel"
      @keydown="onKeydown"
    >
      <div
        class="scroll-thumb"
        :style="{height: `${thumbHeight}px`, transform: `translateY(${thumbTop}px)`}"
      />
    </div>
  </div>
</template>

<style scoped>
.scroll-pane {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
}

.scroll-viewport {
  min-width: 0;
  min-height: 0;
  max-height: var(--pane-limit, 320px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.scroll-rail {
  position: relative;
  width: 18px;
  margin-inline-start: 3px;
  border-inline-start: 1px solid var(--surface-overlay-border);
  background: rgb(0 0 0 / 0.12);
  cursor: pointer;
  touch-action: none;
}

.scroll-thumb {
  position: absolute;
  inset-inline: 4px;
  top: 0;
  border-radius: 5px;
  background: #637e8d;
  pointer-events: none;
}

.scroll-rail:hover .scroll-thumb,
.scroll-rail:focus-visible .scroll-thumb {
  background: #9db4be;
}

.scroll-rail:focus-visible {
  outline: none;
}

.scroll-rail:focus-visible .scroll-thumb {
  outline: 2px solid var(--control-focus);
  outline-offset: 1px;
}

@media (forced-colors: active) {
  .scroll-viewport { scrollbar-width: auto; }
  .scroll-rail { display: none; }
}
</style>
