<script setup>
import {nextTick, onBeforeUnmount, onMounted, ref, shallowRef} from 'vue';
import {loadRegionBgm} from '../features/bgm/bgmStatus.js';
import {SUPPORTED_DATA_VERSION} from '../features/map/mapData.js';
import MusicPlayer from './MusicPlayer.vue';

const opticalChart = new URLSearchParams(location.search).has('glass-check');
const selectedMode = ref('exploration');
const region = shallowRef(null);
const surface = ref(null);
const player = ref(null);
const loadFailed = ref(false);

function paintScene() {
  const canvas = surface.value;
  const width = opticalChart ? canvas.clientWidth : 1;
  const height = opticalChart ? canvas.clientHeight : 1;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {alpha: false});
  context.fillStyle = getComputedStyle(document.body).backgroundColor;
  context.fillRect(0, 0, width, height);

  if (opticalChart) {
    // Angled lines and color transitions reveal the lens displacement without map imagery.
    const color = context.createLinearGradient(width * .30, 0, width, height);
    color.addColorStop(0, '#2d454d');
    color.addColorStop(.43, '#5b7283');
    color.addColorStop(.62, '#c27c72');
    color.addColorStop(.79, '#d2ae75');
    color.addColorStop(1, '#37646e');
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = 'rgb(231 238 235 / .28)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = -height; x < width; x += 32) {
      context.moveTo(x, 0);
      context.lineTo(x + height, height);
    }
    context.stroke();
  }

  player.value?.updateBackdrop(canvas);
}

async function chooseRegion() {
  loadFailed.value = false;
  const data = await loadRegionBgm(SUPPORTED_DATA_VERSION);
  const musicState = data.payload?.music?.State_FD40_City?.wwiseId;
  region.value = musicState == null ? null
    : data.zones.find((entry) => entry.graph && entry.musicState === musicState);
  loadFailed.value = !region.value;
  await nextTick();
  if (surface.value) paintScene();
}

onMounted(() => {
  void chooseRegion();
  if (opticalChart) window.addEventListener('resize', paintScene);
});
onBeforeUnmount(() => window.removeEventListener('resize', paintScene));
</script>

<template>
  <main class="player-lab">
    <canvas ref="surface" aria-hidden="true" />
    <MusicPlayer v-if="region" ref="player" v-model:mode="selectedMode" :zone="region" preview />
    <button v-else-if="loadFailed" class="load-retry" type="button" @click="chooseRegion">
      重试加载音乐
    </button>
  </main>
</template>

<style scoped>
.player-lab {
  --player-width: clamp(340px, 28vw, 428px);
  --map-inline-end: 22px;
  position: relative;
  inline-size: 100%;
  block-size: 100%;
}

.player-lab > canvas {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  pointer-events: none;
}

.load-retry {
  position: absolute;
  inset: 0;
  inline-size: max-content;
  block-size: 44px;
  margin: auto;
  padding-inline: 16px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-overlay);
  cursor: pointer;
}
</style>
