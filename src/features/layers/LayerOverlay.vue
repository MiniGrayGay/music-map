<script setup>
import {computed} from 'vue';
import {rasterPosition} from '../map/mapModel.js';

const props = defineProps({
  pieces: {type: Array, required: true},
  contextPieces: {type: Array, default: () => []},
  transform: {type: Object, required: true},
});
defineEmits(['loaded']);
const images = computed(() => [
  ...props.contextPieces.map(piece => ({...piece, context: true})),
  ...props.pieces,
]);
</script>

<template>
  <img
    v-for="{layerId, url, rect, context} in images"
    :key="layerId"
    class="layer-piece"
    :class="{'layer-piece-context': context}"
    :src="url"
    :style="rasterPosition(transform, rect.left, rect.top, rect.width, rect.height)"
    alt=""
    draggable="false"
    decoding="sync"
    @load="$emit('loaded', layerId)"
  >
</template>

<style scoped>
.layer-piece {
  position: absolute;
  pointer-events: none;
  user-select: none;
  transition-property: none;
}

.layer-piece-context {
  filter: brightness(.565);
}
</style>
