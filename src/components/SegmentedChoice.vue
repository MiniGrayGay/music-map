<script setup>
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import FluidSourceSurface from './FluidSourceSurface.vue';

const props = defineProps({
  label: {type: String, required: true},
  choices: {type: Array, required: true},
  value: {type: [String, Number], default: null},
  wrap: {type: Boolean, default: false},
});
const emit = defineEmits(['select']);
const toggle = ref(null);
const indicator = ref(null);
const renderedIndicator = ref(null);
const visible = ref(false);
const ready = ref(false);
const selectedIndex = computed(() => props.choices.findIndex((choice) => choice.key === props.value));
const nextChoice = computed(() => props.choices[(selectedIndex.value + 1) % props.choices.length]);
const description = computed(() => {
  const current = props.choices[selectedIndex.value];
  const next = nextChoice.value;
  if (!next) return undefined;
  if (!current) return `切换到${next.label}`;
  return current.key === next.key ? `当前${current.label}` : `当前${current.label}，切换到${next.label}`;
});
let observer;
let reducedMotion;
let target;
let pose;
let frame = 0;
let lastFrame;

function paintIndicator() {
  const {x, y, width, height, stretch, angle} = pose;
  const left = x - target.width / 2;
  const top = y - target.height / 2;
  indicator.value.style.transform = [
    `translate3d(${left}px, ${top}px, 0)`,
    `scale(${width / target.width}, ${height / target.height})`,
    `rotate(${angle}rad) scale(${stretch}, ${1 / Math.sqrt(stretch)}) rotate(${-angle}rad)`,
  ].join(' ');
}

function settleIndicator() {
  cancelAnimationFrame(frame);
  frame = 0;
  if (!target) return;
  pose = {...target, vx: 0, vy: 0, stretch: 1, stretchVelocity: 0, angle: 0};
  paintIndicator();
  renderedIndicator.value?.refresh();
}

function moveIndicator(now) {
  const dt = Math.min(.048, (now - lastFrame) / 1000);
  lastFrame = now;
  const steps = Math.max(1, Math.ceil(dt * 240));
  const step = dt / steps;
  // Fluid Glass uses a damped spring for travel and a second one for velocity-driven stretch.
  const travelFrequency = 14;
  const stretchFrequency = 16;
  for (let i = 0; i < steps; i += 1) {
    pose.vx += (travelFrequency ** 2 * (target.x - pose.x)
      - 2 * .86 * travelFrequency * pose.vx) * step;
    pose.vy += (travelFrequency ** 2 * (target.y - pose.y)
      - 2 * .86 * travelFrequency * pose.vy) * step;
    pose.x += pose.vx * step;
    pose.y += pose.vy * step;
    const velocity = Math.hypot(pose.vx, pose.vy);
    if (velocity > 6) pose.angle = Math.atan2(pose.vy, pose.vx);
    const stretchTarget = 1 + Math.min(.38, velocity / 960);
    pose.stretchVelocity += (stretchFrequency ** 2 * (stretchTarget - pose.stretch)
      - 2 * .43 * stretchFrequency * pose.stretchVelocity) * step;
    pose.stretch += pose.stretchVelocity * step;
  }
  const sizeBlend = 1 - Math.exp(-14 * dt);
  pose.width += (target.width - pose.width) * sizeBlend;
  pose.height += (target.height - pose.height) * sizeBlend;
  const remainingDistance = Math.hypot(target.x - pose.x, target.y - pose.y);
  const remainingSize = Math.abs(target.width - pose.width) + Math.abs(target.height - pose.height);
  if (remainingDistance < .12 && remainingSize < .12 && Math.hypot(pose.vx, pose.vy) < 1
      && Math.abs(pose.stretch - 1) < .005 && Math.abs(pose.stretchVelocity) < .04) {
    settleIndicator();
    return;
  }
  paintIndicator();
  frame = requestAnimationFrame(moveIndicator);
}

function alignIndicator(animate = false) {
  const selected = toggle.value?.querySelector('.mode-option--selected');
  const width = selected?.offsetWidth;
  const wasVisible = visible.value;
  visible.value = Boolean(width);
  if (!width) {
    settleIndicator();
    return;
  }

  const height = selected.offsetHeight;
  const x = selected.offsetLeft + width / 2;
  const y = selected.offsetTop + height / 2;
  if (wasVisible && target?.x === x && target.y === y
      && target.width === width && target.height === height) return;

  target = {x, y, width, height};
  indicator.value.style.width = `${width}px`;
  indicator.value.style.height = `${height}px`;
  ready.value = true;
  if (!wasVisible || (!animate && !frame) || reducedMotion.matches) {
    settleIndicator();
    return;
  }

  paintIndicator();
  if (!frame) {
    lastFrame = performance.now();
    frame = requestAnimationFrame(moveIndicator);
  }
}

function observeLayout() {
  observer?.disconnect();
  if (toggle.value && observer) {
    observer.observe(toggle.value);
    for (const option of toggle.value.querySelectorAll('.mode-option')) observer.observe(option);
  }
}

watch([() => props.value, () => props.choices], ([value, choices], [previousValue, previousChoices]) => {
  if (choices !== previousChoices) observeLayout();
  alignIndicator(value !== previousValue);
}, {flush: 'post'});
onMounted(() => {
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.addEventListener('change', settleIndicator);
  observer = new ResizeObserver(() => alignIndicator());
  observeLayout();
  alignIndicator();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  reducedMotion?.removeEventListener('change', settleIndicator);
  cancelAnimationFrame(frame);
});
</script>

<template>
  <div class="modes" :class="{'modes--wrap': wrap}">
    <button ref="toggle" type="button" class="modes-toggle" :aria-label="label"
            :aria-description="description" :data-value="value"
            :disabled="!nextChoice || nextChoice.key === value"
            @click="emit('select', nextChoice.key)">
      <span v-for="choice in choices" :key="choice.key" class="mode-option"
            :class="{'mode-option--selected': value === choice.key}"
            :data-value="choice.key" aria-hidden="true">{{ choice.label }}</span>
      <span ref="indicator" class="mode-indicator" :class="{'mode-indicator--visible': visible}"
            aria-hidden="true">
        <FluidSourceSurface v-if="ready" ref="renderedIndicator" shape="pill" centered />
      </span>
    </button>
  </div>
</template>

<style scoped>
.modes {
  display: inline-flex;
  border-radius: 999px;
  background-color: rgb(245 240 236 / .06);
}

.modes--wrap {
  border-radius: 16px;
}

button.modes-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: 2px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;
  transition: background-color 150ms ease-out;
}

.modes--wrap .modes-toggle {
  flex-wrap: wrap;
}

.mode-indicator {
  position: absolute;
  inset: 0 auto auto 0;
  border-radius: 999px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease;
}

.mode-indicator--visible {
  opacity: 1;
}

.mode-option {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  min-height: 32px;
  min-width: 57px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--player-secondary);
  font: inherit;
  text-align: center;
  text-shadow: inherit;
  white-space: nowrap;
  transition: color 160ms ease;
}

.mode-option--selected {
  color: var(--player-text);
}

button.modes-toggle:focus-visible {
  outline: 2px solid var(--player-text);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .mode-indicator, .mode-option, button.modes-toggle {
    transition: none;
  }
}

@media (forced-colors: active) {
  .mode-indicator {
    display: none;
  }

  .mode-option--selected {
    outline: 1px solid Highlight;
    color: Highlight;
  }
}
</style>
