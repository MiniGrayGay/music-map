<script setup>
import {onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {loadReliefPoints} from './reliefData.js';
import {mountReliefPreview} from './reliefPreview.js';

const props = defineProps({zone: {type: Object, required: true}});
const emit = defineEmits(['unavailable', 'empty', 'aspect']);
const canvas = ref(null);
let preview;
onMounted(() => {
  try {
    preview = mountReliefPreview(canvas.value);
  } catch (error) {
    console.warn('高程点阵无法显示', error);
    emit('unavailable');
    return;
  }
  watch(() => props.zone.key, async (key, previous, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    preview.setPoints(null);
    try {
      const points = await loadReliefPoints(key, controller.signal);
      if (controller.signal.aborted) return;
      if (points) emit('aspect', preview.setPoints(points.positions, props.zone.rings, points.spacing));
      else emit('empty', key);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('分区点阵读取失败', error);
      emit('empty', key);
    }
  }, {immediate: true});
});
onBeforeUnmount(() => preview?.dispose());
</script>

<template>
  <canvas ref="canvas" role="img" :aria-label="`${zone.name}地形高程点阵`" />
</template>

<style scoped>
canvas { display: block; inline-size: 100%; block-size: 100%; }
</style>
