<script setup>
import {computed} from 'vue';
import {rasterPosition} from '../map/mapModel.js';

const props = defineProps({
  pieces: {type: Array, required: true},
  contextPieces: {type: Array, default: () => []},
  stagedPieces: {type: Array, required: true},
  readyIds: {type: Set, required: true},
  transform: {type: Object, required: true},
});
defineEmits(['loaded', 'failed']);
const images = computed(() => {
  const shown = new Set([...props.contextPieces, ...props.pieces].map(({layerId}) => layerId));
  return [
    ...props.contextPieces.map(piece => ({...piece, context: true})),
    ...props.pieces,
    ...props.stagedPieces.filter(({layerId}) => !shown.has(layerId))
      .map(piece => ({...piece, staged: true})),
  ];
});
</script>

<template>
  <TransitionGroup name="layer-art">
    <img
      v-for="{layerId, url, rect, context, staged} in images"
      :key="layerId"
      class="layer-piece"
      :class="{'layer-piece-context': context,
        'layer-piece-pending': staged || !readyIds.has(layerId)}"
      :src="url"
      :style="rasterPosition(transform, rect.left, rect.top, rect.width, rect.height)"
      alt=""
      draggable="false"
      decoding="sync"
      @load="$emit('loaded', layerId)"
      @error="$emit('failed', layerId)"
    >
  </TransitionGroup>
</template>

<style scoped>
.layer-piece {
  position: absolute;
  pointer-events: none;
  user-select: none;
  transition: filter 180ms ease, opacity 180ms ease;
}

.layer-art-enter-from,
.layer-art-leave-to,
.layer-piece-pending {
  opacity: 0;
}

.layer-piece-context {
  filter: brightness(.565);
}
@media (prefers-reduced-motion: reduce) {
  .layer-piece { transition: none; }
}
</style>
