<script setup>
import {rasterPosition} from '../map/mapModel.js';

defineProps({
  pieces: {type: Array, required: true},
  transform: {type: Object, required: true},
});
defineEmits(['loaded']);
</script>

<template>
  <img
    v-for="{layerId, url, rect} in pieces"
    :key="layerId"
    class="layer-piece"
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
}
</style>
