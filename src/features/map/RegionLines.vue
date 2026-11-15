<script setup>
import {computed} from 'vue';

const props = defineProps({
  regions: {type: Array, required: true},
  activeRegion: {type: Object, default: null},
  transform: {type: Object, required: true},
});

// Each shared segment is painted once, including when one of its regions is active.
const edges = computed(() => {
  const unique = new Map();
  for (const region of props.regions) {
    const contours = region.lines ?? region.rings.map((ring) => [...ring, ring[0]]);
    for (const ring of contours) {
      const points = ring.map(([x, y]) => `${x} ${y}`);
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        if (start === end) continue;
        const path = start < end ? `M${start}L${end}` : `M${end}L${start}`;
        if (!unique.has(path)) unique.set(path, new Set());
        unique.get(path).add(region.id1);
      }
    }
  }
  return unique;
});

const strokes = computed(() => {
  const regular = [];
  const active = [];
  for (const [path, owners] of edges.value) {
    const target = owners.has(props.activeRegion?.id1) ? active : regular;
    target.push(path);
  }
  return {regular: regular.join(''), active: active.join('')};
});

// 选中/悬停高亮外廓与游戏边线分职责：该分区有实证 lines 时高亮沿用边线
// 分段（strokes.active，与共享单线层一致）；lines 为空时用分区 rings 描出
// 足迹范围——仅作高亮边界，不进入共享边线层、不冒充游戏边线。
const activeOutline = computed(() => {
  const region = props.activeRegion;
  if (!region || (region.lines?.length ?? 0) > 0) return '';
  return region.rings.map((ring) => {
    const closed = [...ring, ring[0]];
    return `M${closed.map(([x, y]) => `${x} ${y}`).join('L')}Z`;
  }).join('');
});

const position = computed(() => {
  const {tx, ty, scale} = props.transform;
  return `translate(${tx} ${ty}) scale(${scale})`;
});
</script>

<template>
  <svg class="region-lines" aria-hidden="true">
    <g :transform="position">
      <path v-if="activeRegion" class="region-wash" :d="activeRegion.path" fill-rule="evenodd" />
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
  fill: rgb(229 66 132 / 0.42);
}

.region-boundaries,
.region-focus-edge {
  fill: none;
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.region-boundaries {
  stroke: rgb(230 237 240 / 0.76);
  stroke-width: 1;
}

.region-focus-edge {
  stroke: #ffb6db;
  stroke-width: 1.5;
}
</style>
