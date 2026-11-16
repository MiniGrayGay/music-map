<script setup>
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, useId} from 'vue';
import {fieldSize, standardDisplacement} from './rdevStandardDisplacement.js';

const props = defineProps({
  rim: {type: Boolean, default: true},
  displacement: {type: Boolean, default: true},
  variant: {type: String, default: 'standard'},
  light: {type: Number, default: 1},
});

const clear = computed(() => props.variant === 'clear');
const sourceRim = computed(() => props.rim && !clear.value);
const filterId = useId();
const map = ref(null);
const glass = ref(null);
const water = shallowRef(null);
const firefox = navigator.userAgent.toLowerCase().includes('firefox');
let frame = 0;
let impulse;
let reducedMotion;

// User Info Card defaults from rdev/liquid-glass-react at ac48eab.
const channels = [
  {name: 'RED', scale: -100, matrix: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'},
  {name: 'GREEN', scale: -110, matrix: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'},
  {name: 'BLUE', scale: -120, matrix: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'},
];

function animateWater(now) {
  frame = 0;
  if (reducedMotion.matches) {
    water.value = null;
    return;
  }
  // Keep the tail visible if a filter frame misses a refresh deadline.
  impulse.elapsed += Math.max(0, Math.min(48, now - impulse.lastFrame));
  impulse.lastFrame = now;
  const elapsed = Math.min(1, impulse.elapsed / impulse.duration);
  if (elapsed >= 1) {
    water.value = null;
    return;
  }

  const expansion = 1 - (1 - elapsed) ** 2;
  const attack = Math.min(1, elapsed * 7);
  const energy = attack * (1 - elapsed) ** 1.55;
  const carry = 1 - attack;
  const x = impulse.x + impulse.driftX * expansion + impulse.offsetX * carry;
  const y = impulse.y + impulse.driftY * expansion + impulse.offsetY * carry;
  const width = 44 + expansion * 140 + impulse.offsetWidth * carry;
  const height = 32 + expansion * 96 + impulse.offsetHeight * carry;
  water.value = {
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    strength: 11 * energy + impulse.previousStrength * carry,
    light: .34 * energy + impulse.previousLight * carry,
    angle: impulse.angle + expansion * 24 + impulse.offsetAngle * carry,
  };
  frame = requestAnimationFrame(animateWater);
}

function reactAt(control, pointer) {
  if (!glass.value || reducedMotion?.matches) return;
  const panel = glass.value.getBoundingClientRect();
  if (!panel.width || !panel.height) return;
  const target = control.getBoundingClientRect();
  const x = (pointer?.clientX ?? target.left + target.width / 2) - panel.left;
  const y = (pointer?.clientY ?? target.top + target.height / 2) - panel.top;
  const old = water.value;
  const angle = Math.atan2(y - panel.height / 2, x - panel.width / 2) * 180 / Math.PI;
  impulse = {
    x,
    y,
    offsetX: old ? old.x + old.width / 2 - x : 0,
    offsetY: old ? old.y + old.height / 2 - y : 0,
    offsetWidth: old ? old.width - 44 : 0,
    offsetHeight: old ? old.height - 32 : 0,
    offsetAngle: old ? (old.angle - angle + 540) % 360 - 180 : 0,
    previousStrength: old?.strength ?? 0,
    previousLight: old?.light ?? 0,
    driftX: (panel.width / 2 - x) * .12,
    driftY: (panel.height / 2 - y) * .08 - 9,
    angle,
    elapsed: 0,
    lastFrame: performance.now(),
    duration: 420 + Math.min(60, Math.abs(x - panel.width / 2) * .22),
  };
  if (!frame) frame = requestAnimationFrame(animateWater);
}

defineExpose({reactAt});

onMounted(async () => {
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  if (props.displacement) map.value = await getFilterInput();
});
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<script>
let filterInput;
let waterField;

function getWaterField() {
  if (waterField) return waterField;
  const size = 72;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(size, size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const x = (column + .5) / size * 2 - 1;
      const y = (row + .5) / size * 2 - 1;
      const radius = Math.hypot(x, y);
      const angle = Math.atan2(y, x);
      const warped = radius * (1 + .12 * Math.sin(3 * angle) + .067 * Math.cos(5 * angle + .9));
      const front = (warped - .60) / .13;
      const wake = (warped - .40) / .105;
      const direction = .74 + .25 * Math.sin(angle + .6);
      const slope = (Math.exp(-front * front) - .56 * Math.exp(-wake * wake)) * direction;
      const index = (row * size + column) * 4;
      image.data[index] = 128 + 125 * slope * Math.cos(angle + .18);
      image.data[index + 1] = 128;
      image.data[index + 2] = 128 + 125 * slope * Math.sin(angle + .18);
      image.data[index + 3] = 255 * Math.min(1, Math.max(0, (1 - radius) / .18));
    }
  }
  context.putImageData(image, 0, 0);
  waterField = canvas.toDataURL();
  return waterField;
}

function getFilterInput() {
  filterInput ??= buildFilterInput();
  return filterInput;
}

async function buildFilterInput() {
  if (!window.DecompressionStream) return null;
  const bytes = Uint8Array.from(atob(standardDisplacement), (value) => value.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const field = new Uint8Array(await new Response(stream).arrayBuffer());
  if (field.length !== fieldSize * fieldSize * 3) throw new Error('Invalid rdev displacement data');

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = fieldSize;
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) return null;
  const image = context.createImageData(fieldSize, fieldSize);
  for (let src = 0, dest = 0; src < field.length; src += 3, dest += 4) {
    image.data[dest] = field[src];
    image.data[dest + 1] = field[src + 1];
    image.data[dest + 2] = field[src + 2];
    image.data[dest + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
</script>

<template>
  <div ref="glass" class="liquid-glass glass-surface"
       :class="{'is-ready': map || !displacement, 'rimless': !sourceRim, 'liquid-glass--clear': clear}"
       :style="clear ? {'--liquid-glass-light': light} : undefined" aria-hidden="true">
    <svg v-if="displacement" class="filter-definitions">
      <defs>
        <filter :id="filterId" x="-35%" y="-35%" width="170%" height="170%"
                color-interpolation-filters="sRGB">
          <feImage v-if="map" x="0" y="0" width="100%" height="100%" result="DISPLACEMENT_MAP"
                   :href="map" preserveAspectRatio="xMidYMid slice" />
          <feColorMatrix in="DISPLACEMENT_MAP" type="matrix"
                         values="0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0 0 0 1 0"
                         result="EDGE_INTENSITY" />
          <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
            <feFuncA type="discrete" tableValues="0 0.1 1" />
          </feComponentTransfer>
          <feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL" />
          <template v-for="channel in channels" :key="channel.name">
            <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" :scale="channel.scale * (sourceRim ? 1 : .52)"
                               xChannelSelector="R" yChannelSelector="B"
                               :result="channel.name + '_DISPLACED'" />
            <feColorMatrix :in="channel.name + '_DISPLACED'" type="matrix" :values="channel.matrix"
                           :result="channel.name + '_CHANNEL'" />
          </template>
          <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
          <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
          <feGaussianBlur in="RGB_COMBINED" stdDeviation="0.3" result="ABERRATED_BLURRED" />
          <feComposite in="ABERRATED_BLURRED" in2="EDGE_MASK" operator="in"
                       result="EDGE_ABERRATION" />
          <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
          <feComposite in="EDGE_ABERRATION" in2="CENTER_CLEAN" operator="over" result="MATERIAL" />
          <template v-if="water">
            <feFlood flood-color="rgb(50% 50% 50%)" result="FLAT_WATER" />
            <feImage :href="getWaterField()" :x="water.x" :y="water.y"
                     :width="water.width" :height="water.height"
                     preserveAspectRatio="none" result="RIPPLE_FIELD" />
            <feComposite in="RIPPLE_FIELD" in2="FLAT_WATER" operator="over" result="WATER_FIELD" />
            <feDisplacementMap in="MATERIAL" in2="WATER_FIELD" :scale="water.strength"
                               xChannelSelector="R" yChannelSelector="B" />
          </template>
        </filter>
      </defs>
    </svg>
    <div class="rdev-pane">
      <span class="rdev-warp" :style="{filter: map && !firefox ? 'url(#' + filterId + ')' : null}" />
      <span v-if="clear" class="clear-tint" />
      <span v-if="water" class="water-light" :style="{
        width: water.width + 'px',
        height: water.height + 'px',
        opacity: water.light,
        transform: 'translate(' + water.x + 'px,' + water.y + 'px) rotate(' + water.angle + 'deg)',
      }" />
    </div>
    <span v-if="sourceRim" class="rdev-rim rdev-rim--screen" />
    <span v-if="sourceRim" class="rdev-rim rdev-rim--overlay" />
  </div>
</template>

<style scoped>
.liquid-glass,
.filter-definitions,
.rdev-pane,
.rdev-warp,
.rdev-rim {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.liquid-glass {
  border-radius: inherit;
}

.filter-definitions {
  width: 100%;
  height: 100%;
}

.rdev-pane {
  overflow: hidden;
  border-radius: inherit;
  box-shadow: 0 12px 40px rgb(0 0 0 / .25);
}

.rimless .rdev-pane { box-shadow: 0 10px 28px rgb(0 4 16 / .18); }

.rdev-warp {
  backdrop-filter: var(--liquid-glass-backdrop, blur(20px) saturate(140%));
}

.liquid-glass--clear .rdev-warp {
  -webkit-backdrop-filter: var(--liquid-glass-clear-backdrop, blur(7px) saturate(112%));
  backdrop-filter: var(--liquid-glass-clear-backdrop, blur(7px) saturate(112%));
}

.liquid-glass--clear .rdev-pane {
  box-shadow: 0 6px 18px rgb(3 22 29 / .13);
}

.clear-tint {
  --light: var(--liquid-glass-light);
  --tint-opacity: clamp(.04, calc(.075 + (1 - var(--light)) * .32), .14);
  position: absolute;
  inset: 0;
  background:
    linear-gradient(to bottom, rgb(187 233 246 / calc(.064 * var(--light))), transparent 3px),
    linear-gradient(to top, rgb(169 222 235 / calc(.13 + (var(--light) - 1) * .07)),
      rgb(169 222 235 / .13) 1.5px,
      transparent 2.5px),
    linear-gradient(180deg, rgb(180 229 244 / .11),
      rgb(167 222 236 / .041) 27%, transparent 70%, rgb(150 211 225 / .025))
      var(--liquid-glass-tint, rgb(7 29 38 / var(--tint-opacity)));
}

.clear-tint::after {
  position: absolute;
  inset: 0;
  background-color: rgb(220 245 244 / .09);
  opacity: 0;
  transition: opacity 160ms ease;
  content: '';
}

button:is(:hover, [aria-expanded='true']) > .liquid-glass--clear .clear-tint::after {
  opacity: 1;
}

.liquid-glass--clear::after {
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: inherit;
  background: linear-gradient(180deg,
    rgb(220 246 250 / calc(.29 * var(--liquid-glass-light))),
    rgb(201 237 247 / .18) 29%, rgb(190 228 240 / .15) 62%,
    rgb(207 236 246 / clamp(.04, calc(.065 + (var(--liquid-glass-light) - 1) * .05), .1)));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  content: '';
}

@media (prefers-reduced-motion: reduce) {
  .clear-tint::after { transition: none; }
}

.water-light {
  position: absolute;
  inset: 0 auto auto 0;
  pointer-events: none;
  mix-blend-mode: screen;
  background: radial-gradient(ellipse at 32% 45%, rgb(230 248 255 / .52), transparent 42%),
    radial-gradient(ellipse at 69% 66%, rgb(255 244 225 / .32), transparent 29%);
}

.rdev-rim {
  box-sizing: border-box;
  padding: 1.5px;
  border-radius: inherit;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  box-shadow: inset 0 0 0 .5px rgb(255 255 255 / .5),
    inset 0 1px 3px rgb(255 255 255 / .25), 0 1px 4px rgb(0 0 0 / .35);
}

.rdev-rim--screen {
  mix-blend-mode: screen;
  opacity: .2;
  background: linear-gradient(135deg, rgb(255 255 255 / 0) 0%, rgb(255 255 255 / .12) 33%,
    rgb(255 255 255 / .4) 66%, rgb(255 255 255 / 0) 100%);
}

.rdev-rim--overlay {
  mix-blend-mode: overlay;
  background: linear-gradient(135deg, rgb(255 255 255 / 0) 0%, rgb(255 255 255 / .32) 33%,
    rgb(255 255 255 / .6) 66%, rgb(255 255 255 / 0) 100%);
}

@media (forced-colors: active) {
  .liquid-glass {
    display: none;
  }
}
</style>

