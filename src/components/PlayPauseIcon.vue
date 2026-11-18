<script setup>
import {nextTick, onBeforeUnmount, ref, useId, watch} from 'vue';
import {pauseIconPath, playbackIconFrame, playIconPath} from './playPauseShape.js';

const props = defineProps({playing: Boolean});
const surface = ref(null);
const silhouette = ref(null);
const upperNotch = ref(null);
const lowerNotch = ref(null);
const blur = ref(null);
const threshold = ref(null);
const hasMotionDefs = ref(false);
const filterId = useId();
const maskId = `${filterId}-notches`;
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const initialPath = props.playing ? pauseIconPath : playIconPath;
const duration = 515;
const turnTime = 36;
let target = Number(props.playing);
let position = target;
let speed = 0;
let frame = 0;
let lastFrame = 0;

function paint() {
  const element = silhouette.value;
  const group = surface.value;
  if (position === 0 || position === 1) {
    element.setAttribute('d', position ? pauseIconPath : playIconPath);
    element.removeAttribute('mask');
    group.removeAttribute('filter');
    return;
  }
  const {path, upperNotch: top, lowerNotch: bottom, softness = 0} = playbackIconFrame(position);
  element.setAttribute('d', path);
  if (top || bottom) {
    upperNotch.value.setAttribute('d', top);
    lowerNotch.value.setAttribute('d', bottom);
    element.setAttribute('mask', `url(#${maskId})`);
  } else {
    element.removeAttribute('mask');
  }
  if (softness <= .01) {
    group.removeAttribute('filter');
    return;
  }

  // Soften only the instant where the two already-rounded notches touch.
  const contrast = 1 + 3.7 * Math.min(1, softness / .23);
  blur.value.setAttribute('stdDeviation', softness.toFixed(3));
  threshold.value.setAttribute('slope', contrast.toFixed(3));
  threshold.value.setAttribute('intercept', ((1 - contrast) / 2).toFixed(3));
  group.setAttribute('filter', `url(#${filterId})`);
}

function advance(now) {
  const elapsed = Math.min(40, Math.max(0, now - lastFrame));
  const nextSpeed = (target ? 1 : -1) / duration;
  const carry = Math.exp(-elapsed / turnTime);
  // Reversing the target changes the velocity continuously and keeps the current silhouette.
  position = Math.min(1, Math.max(0,
    position + nextSpeed * elapsed + (speed - nextSpeed) * turnTime * (1 - carry),
  ));
  speed = nextSpeed + (speed - nextSpeed) * carry;
  lastFrame = now;
  paint();
  if (position === target) {
    stopMotion();
  } else {
    frame = requestAnimationFrame(advance);
  }
}

function stopMotion() {
  cancelAnimationFrame(frame);
  motionPreference.removeEventListener('change', updateMotionPreference);
  frame = 0;
  speed = 0;
}

function settle() {
  stopMotion();
  position = target;
  paint();
}

function updateMotionPreference(event) {
  if (event.matches) settle();
}

watch(() => props.playing, async (playing) => {
  target = Number(playing);
  if (motionPreference.matches) {
    settle();
    return;
  }
  if (frame || position === target) return;
  // List rows only allocate the mask and filter the first time they animate.
  if (!hasMotionDefs.value) {
    hasMotionDefs.value = true;
    await nextTick();
  }
  if (!silhouette.value || frame || position === target) return;
  if (motionPreference.matches) {
    settle();
    return;
  }
  motionPreference.addEventListener('change', updateMotionPreference);
  lastFrame = performance.now();
  frame = requestAnimationFrame(advance);
}, {flush: 'post'});

onBeforeUnmount(stopMotion);
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <defs v-if="hasMotionDefs">
      <mask :id="maskId" x="-2" y="-2" width="28" height="28" maskUnits="userSpaceOnUse"
            maskContentUnits="userSpaceOnUse">
        <rect x="-2" y="-2" width="28" height="28" fill="white" stroke="none" />
        <path ref="upperNotch" fill="black" stroke="none" />
        <path ref="lowerNotch" fill="black" stroke="none" />
      </mask>
      <filter :id="filterId" x="-2" y="-2" width="28" height="28"
              filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feGaussianBlur ref="blur" stdDeviation="0" />
        <feComponentTransfer>
          <feFuncA ref="threshold" type="linear" slope="1" intercept="0" />
        </feComponentTransfer>
      </filter>
    </defs>
    <g ref="surface" fill="currentColor" stroke="none">
      <path ref="silhouette" class="play-pause-shape" :d="initialPath" />
    </g>
  </svg>
</template>
