<script setup>
import {computed} from 'vue';
import {buildRegionLinework} from './regionLinework.js';

const props = defineProps({
  regions: {type: Array, required: true},
  activeRegion: {type: Object, default: null},
  transform: {type: Object, required: true},
  smooth: {type: Boolean, default: true},
  highlightFootprint: {type: Boolean, default: false},
});

const linework = computed(() => buildRegionLinework(props.regions, props.smooth));

const strokes = computed(() => {
  const regular = [];
  const active = [];
  for (const {path, owners} of linework.value.segments) {
    const target = owners.has(props.activeRegion?.id1) ? active : regular;
    target.push(path);
  }
  return {regular: regular.join(''), active: active.join('')};
});

const activeFill = computed(() => props.activeRegion
  ? linework.value.outline(props.activeRegion) : '');

// 没有常驻楼层边线的足迹，仅在悬停或选中时描出轮廓。
const activeOutline = computed(() => {
  const region = props.activeRegion;
  return props.highlightFootprint && region?.lines?.length === 0 ? activeFill.value : '';
});

const position = computed(() => {
  const {tx, ty, scale} = props.transform;
  return `translate(${tx} ${ty}) scale(${scale})`;
});
</script>

<template>
  <svg class="region-lines" aria-hidden="true">
    <g :transform="position">
      <path v-if="activeRegion" class="region-wash" :d="activeFill" fill-rule="evenodd" />
      <path class="region-boundaries" :d="strokes.regular" />
      <path v-if="strokes.active || activeOutline" class="region-focus-edge"
            :d="strokes.active + activeOutline" />
    </g>
  </svg>
</template>

<style scoped>
.region-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.region-wash {
  fill: var(--region-fill-selected);
}

.region-boundaries,
.region-focus-edge {
  fill: none;
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.region-boundaries {
  stroke: var(--region-stroke);
  stroke-width: 1;
}

.region-focus-edge {
  stroke: var(--region-stroke-hover);
  stroke-width: 1.5;
}
</style>
