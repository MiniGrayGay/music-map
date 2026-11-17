<script setup>
import {onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {loadReliefPoints} from './reliefData.js';
import {mountReliefPreview} from './reliefPreview.js';
import {fitPoints} from './fitReliefPoints.js';

const props = defineProps({
  zone: {type: Object, required: true},
  active: {type: Boolean, default: true},
});
const emit = defineEmits(['unavailable', 'empty', 'aspect']);
const canvas = ref(null);
let preview;
let worker;
let generation = 0;

// The fit worker is reused across zone switches while idle; a fit result
// carries the id of its request so stale replies from an aborted zone are
// simply dropped. Input is a bounded copy (`positions.slice()`) whose buffer
// is transferred — shared packed ranges / completeBuffer are never detached.
// rings are flattened to plain arrays because a reactive Proxy cannot be
// structurally cloned (DataCloneError).
function plainRings(rings) {
  return (rings ?? []).map((ring) => ring.map(([x, z]) => [x, z]));
}

function ensureWorker() {
  worker ??= new Worker(new URL('./reliefFitWorker.js', import.meta.url), {type: 'module'});
  return worker;
}

function retireWorker(current) {
  current.terminate();
  if (worker === current) worker = null;
}

function fitInWorker(copy, rings, id, signal) {
  return new Promise((resolve, reject) => {
    const current = ensureWorker();
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      current.removeEventListener('message', onMessage);
      current.removeEventListener('messageerror', onError);
      current.removeEventListener('error', onError);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      // Kill this stale task outright so the next zone never queues behind it.
      retireWorker(current);
      settle(reject, new Error('点阵拟合已取消'));
    };
    const onMessage = ({data}) => {
      if (data?.id !== id) return;
      if (data.ok) settle(resolve, data);
      else settle(reject, new Error(data.message));
    };
    const onError = (event) => {
      // The worker is broken; drop it so the next attempt spawns a fresh one.
      retireWorker(current);
      settle(reject, event.error ?? new Error('点阵拟合 Worker 失败'));
    };
    signal.addEventListener('abort', onAbort);
    current.addEventListener('message', onMessage);
    current.addEventListener('messageerror', onError);
    current.addEventListener('error', onError);
    try {
      current.postMessage({id, positions: copy, rings}, [copy.buffer]);
    } catch (error) {
      retireWorker(current);
      settle(reject, error);
    }
  });
}

onMounted(() => {
  try {
    preview = mountReliefPreview(canvas.value, props.active);
  } catch (error) {
    console.warn('高程点阵无法显示', error);
    emit('unavailable');
    return;
  }
  watch(() => props.active, active => preview.setActive(active));
  watch(() => props.zone.key, async (key, previous, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const id = ++generation;
    preview.setPoints(null);
    try {
      const points = await loadReliefPoints(key, controller.signal);
      if (controller.signal.aborted || id !== generation) return;
      if (!points) {
        emit('empty', key);
        return;
      }
      let fitted;
      try {
        fitted = await fitInWorker(points.positions.slice(), plainRings(props.zone.rings), id, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || id !== generation) return;
        console.warn('点阵拟合 Worker 失败，改用主线程拟合', error);
        fitted = fitPoints(points.positions, props.zone.rings);
      }
      if (controller.signal.aborted || id !== generation) return;
      emit('aspect', preview.setPoints(fitted, points.spacing));
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('分区点阵读取失败', error);
      emit('empty', key);
    }
  }, {immediate: true});
});
onBeforeUnmount(() => {
  generation++;
  worker?.terminate();
  worker = null;
  preview?.dispose();
});
</script>

<template>
  <canvas ref="canvas" role="img" :aria-label="`${zone.name}地形高程点阵`" />
</template>

<style scoped>
canvas { display: block; inline-size: 100%; block-size: 100%; }
</style>
