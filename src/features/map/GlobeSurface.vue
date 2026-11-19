<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch} from 'vue';
import GlassPanel from '../../components/GlassPanel.vue';
import {pushEscapeHandler} from '../../components/escapeStack.js';
import {musicView} from '../bgm/bgmStatus.js';
import {fontaineSeaRect, groundPatch, loadFontaineSeaPatch, loadGroundPatch} from './ground-patch.js';
import {Globe} from './globe/globe.js';
import {atlasAngles, clipAtlasRing, direction, fullSpan} from './globe/projection.js';
import {
  containsMapRings, loadMoonCanonPatch, loadMoonCanonSafety, moonCanonPatch, moonCanonZoneAnchor,
} from './mooncanonSafety.js';
import fragment from './globe/sphere.frag?raw';

const props = defineProps({
  mapData: {type: Object, required: true},
  mapName: {type: String, required: true},
  showOverviewGuide: {type: Boolean, default: false},
  bgm: {type: Object, required: true},
  activeZone: {type: Object, default: null},
  availableMaps: {type: Array, required: true},
  searchHost: {type: HTMLElement, default: null},
  toolbarCovered: {type: Boolean, default: false},
  reliefTarget: {type: HTMLElement, default: null},
  reliefAspect: {type: Number, default: null},
  initialViewport: {type: Object, default: null},
  reliefEnabled: {type: Boolean, default: false},
  mobileDevice: {type: Boolean, default: false},
  smoothBoundaries: {type: Boolean, default: true},
});
const emit = defineEmits([
  'handoff-ready', 'view', 'zone-activate', 'zone-focus', 'select-map', 'unavailable',
  'canvas-frame', 'relief-reveal', 'world-error', 'overview-dismiss',
]);
const atlas = import.meta.glob(['./globe/atlas/Teyvat.webp', './globe/atlas/MoonCanon.webp'], {eager: true, query: '?url', import: 'default'});
// 球面只承载提瓦特与霜月；层岩巨渊、旧日之海、远古圣山等独立场景走平面 MapSurface。
const chart = {
  Teyvat: {home: [.43, -.16], span: [4.03, 2.43], sea: [21, 60, 76], oceanRelief: true},
  MoonCanon: {home: [.08, .01], span: fullSpan, sea: [28, 48, 71], projection: 2},
};
const canvas = ref(null);
const moon = ref(null);
const lunarLayer = ref(null);
const signals = ref(null);
const stars = ref(null);
const labels = ref(null);
const moonLink = ref(null);
const query = ref('');
const searchForm = ref(null);
const searchField = ref(null);
const searchResults = ref(null);
const searchOpen = ref(false);
const searchIndex = ref(0);
const resultListId = useId();
const overviewGuideId = useId();
const overviewGuide = ref(null);
const status = ref('正在加载地图');
const renderedMap = ref(props.mapName);
const overviewGuideVisible = computed(() => props.showOverviewGuide && renderedMap.value === 'Teyvat' && !status.value);
watch(overviewGuide, (dialog) => {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}, {flush: 'post'});
const images = new Map();
const zones = computed(() => musicView(props.bgm, props.mapName, [], false));
const moonSafety = shallowRef(null);
const moonZoneAnchors = computed(() => {
  const anchors = new Map();
  if (!moonSafety.value) return anchors;
  for (const zone of musicView(props.bgm, 'MoonCanon', [], false)) {
    const anchor = moonCanonZoneAnchor(moonSafety.value, zone);
    if (anchor) anchors.set(zone.key, anchor);
  }
  return anchors;
});
const catalog = computed(() => props.availableMaps.flatMap(({value, label}) => {
  if (props.mobileDevice && value !== props.mapName
    && (value === 'MoonCanon' || props.mapName === 'MoonCanon')) return [];
  const seen = new Set();
  return musicView(props.bgm, value, [], false).flatMap(({key, name, musicState}) => {
    if (value === 'MoonCanon' && !moonZoneAnchors.value.has(key)) return [];
    const identity = musicState == null ? null : JSON.stringify([name, musicState]);
    if (identity && seen.has(identity)) return [];
    if (identity) seen.add(identity);
    return [{key, name, map: value, label}];
  });
}));
const results = computed(() => {
  const name = query.value.trim();
  return name ? catalog.value.filter((zone) => zone.name.includes(name)).sort((a, b) =>
    Number(b.map === props.mapName) - Number(a.map === props.mapName),
  ).slice(0, 10) : [];
});
let globe;
let request = 0;
let installedMap;
let lastView;
let pendingSelection;

function resultId(index) {
  return `${resultListId}-${index}`;
}

function dismissSearch() {
  searchOpen.value = false;
}

function dismissOutsideSearch(event) {
  if (searchOpen.value && !searchForm.value?.contains(event.target)) dismissSearch();
}

function openSearch() {
  searchOpen.value = !props.toolbarCovered && Boolean(query.value.trim());
}

function onSearchKeydown(event) {
  if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (!searchOpen.value && event.key === 'ArrowDown' && query.value.trim()) {
    event.preventDefault();
    openSearch();
    return;
  }
  if (!searchOpen.value || !results.value.length) return;
  event.preventDefault();
  const last = results.value.length - 1;
  switch (event.key) {
    case 'ArrowDown': searchIndex.value = Math.min(last, searchIndex.value + 1); break;
    case 'ArrowUp': searchIndex.value = Math.max(0, searchIndex.value - 1); break;
    case 'Home': searchIndex.value = 0; break;
    case 'End': searchIndex.value = last; break;
  }
  void nextTick(() => {
    const list = searchResults.value?.parentElement;
    const option = searchResults.value?.children[searchIndex.value];
    if (!list || !option) return;
    const listBounds = list.getBoundingClientRect();
    const itemBounds = option.getBoundingClientRect();
    // Scroll the list in place, without asking the browser to pan the map behind it.
    list.scrollTop += Math.min(0, itemBounds.top - listBounds.top)
      + Math.max(0, itemBounds.bottom - listBounds.bottom);
  });
}

watch(query, () => {
  searchIndex.value = 0;
  openSearch();
  if (query.value.trim() && !moonSafety.value
    && props.availableMaps.some(({value}) => value === 'MoonCanon')) {
    loadMoonCanonSafety().then((safety) => { moonSafety.value = safety; }).catch(() => {});
  }
});
watch(results, ({length}) => {
  searchIndex.value = Math.min(searchIndex.value, Math.max(0, length - 1));
});
watch(() => props.toolbarCovered, covered => {
  if (covered) dismissSearch();
});
watch(searchOpen, (open, _, cleanup) => {
  if (!open) return;
  cleanup(pushEscapeHandler(() => {
    dismissSearch();
    return true;
  }));
});

function texture(file) {
  if (!images.has(file)) {
    const image = new Image();
    const task = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => { images.delete(file); reject(new Error('地图贴图无法加载')); };
      image.src = atlas[`./globe/atlas/${file}`];
    });
    images.set(file, task);
  }
  return images.get(file);
}

function regionPosition(rings) {
  const center = rings.reduce((largest, ring) => {
    let x = 0, y = 0, cross = 0;
    for (const [i, a] of ring.entries()) {
      const b = ring[(i + 1) % ring.length];
      const weight = a[0] * b[1] - b[0] * a[1];
      x += (a[0] + b[0]) * weight;
      y += (a[1] + b[1]) * weight;
      cross += weight;
    }
    const area = Math.abs(cross);
    return area > largest.area ? {area, xy: [x / (3 * cross), y / (3 * cross)]} : largest;
  }, {area: 0, xy: rings[0][0]});
  return {uv: center.xy, size: Math.sqrt(center.area * .5)};
}

function markers(world) {
  const {imageWidth, imageHeight} = world.pyramid;
  return zones.value.flatMap((zone) => {
    const rings = zone.pixelRings.map((ring) =>
      clipAtlasRing(ring.map(([x, y]) => [x * 4 / imageWidth, y * 4 / imageHeight])))
      .filter((ring) => ring.length >= 3);
    if (!rings.length) return [];
    const {uv: center, size} = regionPosition(rings);
    const uv = world.safety ? moonZoneAnchors.value.get(zone.key) : center;
    if (!uv || uv.some((value) => value < 0 || value > 1)) return [];
    const [lon, lat] = atlasAngles(world, ...uv);
    // Split long edges before projecting so a straight atlas edge follows the curve of the globe.
    let outlines;
    const points = rings.flat();
    const x = points.map(([u]) => u);
    const y = points.map(([, v]) => v);
    const bounds = [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)];
    const ratio = imageHeight / imageWidth;
    return [{zone, uv, lon, lat, bounds,
      vector: direction(lon, lat), angularSize: size * Math.sqrt(ratio) * world.span[0],
      contains: (u, v) => u >= bounds[0] && u <= bounds[2] && v >= bounds[1] && v <= bounds[3]
        && containsMapRings(rings, u, v),
      get outlines() {
        // Only the selected area needs a subdivided outline on the curved map.
        outlines ??= rings.map((ring) => ring.flatMap((a, i) => {
          const b = ring[(i + 1) % ring.length];
          const n = Math.min(36, Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 88)));
          return Array.from({length: n}, (_, j) => {
            const uv = a.map((value, axis) => value + (b[axis] - value) * j / n);
            return {uv, vector: direction(...atlasAngles(world, ...uv))};
          });
        }));
        return outlines;
      },
    }];
  });
}

function locate(marker, reframe = true) {
  const renderer = globe;
  if (!marker || !renderer?.world) return false;
  renderer.select(marker);
  emit('zone-focus', marker.zone);
  if (reframe) {
    void nextTick(() => {
      if (globe === renderer && renderer.selected?.zone.key === marker.zone.key) renderer.frameSelection();
    });
  }
  return true;
}

function select(marker) {
  if (!locate(marker, globe?.selected?.zone.key !== marker?.zone.key)) return;
  query.value = '';
  dismissSearch();
  emit('zone-activate', marker.zone);
}

function clearSelection() {
  globe?.select(null);
  emit('zone-focus', null);
}

function resetView() {
  if (!globe?.world || installedMap !== props.mapName) return;
  if (installedMap === 'MoonCanon' && !globe.magnified) emit('select-map', 'Teyvat');
  else globe.reset();
}

function jumpToZone(key) {
  const item = globe?.zones?.find(({zone}) => zone.key === key);
  if (item) locate(item);
  else pendingSelection = {map: props.mapName, key};
}

function chooseResult(result) {
  if (!result) return;
  query.value = '';
  dismissSearch();
  if (props.mobileDevice) searchForm.value?.querySelector('input')?.blur();
  if (result.map === props.mapName) {
    jumpToZone(result.key);
  } else {
    pendingSelection = {map: result.map, key: result.key};
    emit('select-map', result.map, result.key);
  }
}

async function showWorld() {
  if (!globe) return;
  const id = props.mapName;
  if (pendingSelection?.map !== id) pendingSelection = undefined;
  const revision = ++request;
  const settings = chart[id];
  const world = {...settings, id, projection: settings.projection ?? 0,
    pyramid: props.mapData.pyramid, sea: settings.sea.map((value) => value / 255)};
  try {
    const lunar = id === 'MoonCanon';
    const [image, safety, patch] = await Promise.all([
      texture(`${id}.webp`), lunar && loadMoonCanonSafety(), lunar && loadMoonCanonPatch(),
    ]);
    if (revision !== request) return;
    if (safety) {
      moonSafety.value = safety;
      world.safety = safety;
      globe.setGroundPatch(patch, moonCanonPatch);
    }
    const items = markers(world);
    if (installedMap === id) {
      globe.setZones(items);
    } else {
      installedMap = id;
      globe.setWorld(world, image, items);
      if (props.initialViewport) {
        const ready = () => emit('handoff-ready');
        if (!globe.alignViewport(props.initialViewport, props.mapData.canvas, false, ready)) ready();
      }
    }
    status.value = '';
    if (pendingSelection && items.some(({zone}) => zone.key === pendingSelection.key)) {
      jumpToZone(pendingSelection.key);
      pendingSelection = undefined;
    } else if (props.activeZone) {
      globe.select(items.find(({zone}) => zone.key === props.activeZone.key) ?? null);
    }
  } catch (error) {
    if (revision === request) {
      status.value = error.message;
      emit('world-error', id);
      if (props.initialViewport) emit('unavailable', error.message);
    }
  }
}

watch([() => props.mapName, zones], showWorld);
watch(() => props.smoothBoundaries, (enabled) => globe?.setBoundarySmoothing(enabled));
watch([() => props.reliefTarget, () => props.reliefAspect], () => globe?.requestFrame(), {flush: 'post'});
watch(() => props.activeZone, (zone) => {
  globe?.setPlaying(Boolean(zone));
  if (!zone && globe?.selected) clearSelection();
});
onMounted(() => {
  try {
    globe = new Globe({canvas: canvas.value, satellite: moon.value, moonLink: moonLink.value,
      lunarLayer: lunarLayer.value, mobileDevice: props.mobileDevice,
      signals: signals.value, stars: stars.value, labels: labels.value, fragment,
      onFrame: (element) => {
        renderedMap.value = installedMap;
        emit('canvas-frame', element, installedMap);
      },
      onReliefReveal: key => emit('relief-reveal', key),
      reliefEnabled: () => props.reliefEnabled,
      reliefTarget(key) {
        const target = props.reliefTarget;
        const aspect = props.reliefAspect;
        return aspect != null && target?.dataset.reliefZone === String(key) ? target : null;
      },
      labelObstacles(includeRelief = false) {
        const overlays = document.querySelectorAll(
          '.app-controls, .map-toolbar-row, .layer-picker .panel[data-panel-open], ' +
          '.globe-search-field[data-panel-open], .globe-results[data-panel-open], .music-player:not([inert])',
        );
        const bounds = Array.from(overlays, element => element.getBoundingClientRect());
        const relief = props.reliefTarget;
        if (includeRelief && relief?.hasAttribute('data-relief-placed')) {
          bounds.push(relief.getBoundingClientRect());
        }
        return bounds.filter(rect => rect.width > 0 && rect.height > 0);
      },
      onSelect: select, onView(canZoomIn, canZoomOut, magnified) {
        const key = [installedMap, canZoomIn, canZoomOut, magnified].join(':');
        if (key === lastView) return;
        lastView = key;
        emit('view', {canZoomIn, canZoomOut, magnified, globeMap: installedMap});
      },
      onContextLost: () => emit('unavailable', '球面渲染已中断，已切换为平面地图')});
  } catch (error) {
    emit('unavailable', error.message);
    return;
  }
  globe.setBoundarySmoothing(props.smoothBoundaries);
  document.addEventListener('pointerdown', dismissOutsideSearch, true);
  document.addEventListener('focusin', dismissOutsideSearch);
  void showWorld();
  loadGroundPatch().then((image) => globe?.setGroundPatch(image, groundPatch)).catch(console.warn);
  // 默认世界即提瓦特；rect 只在提瓦特渲染中生效，其余世界传零矩形。
  loadFontaineSeaPatch().then((image) => globe?.setFontaineSeaPatch(image, fontaineSeaRect)).catch(console.warn);
  // 桌面轨道月球和进入后的地图共用同一份霜月图集。
  if (!globe.compact) texture('MoonCanon.webp').then((image) => globe?.setMoon(image)).catch(() => {});
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismissOutsideSearch, true);
  document.removeEventListener('focusin', dismissOutsideSearch);
  request += 1;
  globe?.dispose();
  globe = null;
});
defineExpose({zoomIn: () => globe?.zoomBy(1.22), zoomOut: () => globe?.zoomBy(1 / 1.22),
  resetView, clearSelection,
  refreshRelief: () => globe?.requestFrame(),
  viewportRect: () => globe?.viewportRect(props.mapData.canvas),
  alignViewport: (rect, done) => globe?.alignViewport(rect, props.mapData.canvas, true, done),
  cancelViewportAlignment: () => globe?.cancelViewportAlignment(),
  focusZone: () => canvas.value?.focus({preventScroll: true}), jumpToZone,
});
</script>

<template>
  <div class="globe-surface" :class="{'teyvat-sky': renderedMap === 'Teyvat'}">
    <canvas ref="stars" aria-hidden="true" />
    <canvas ref="canvas" class="globe-canvas" tabindex="0"
            aria-label="球面地图，可拖动或用方向键旋转，滚轮缩放，回车选择地点" />
    <canvas ref="signals" aria-hidden="true" />
    <canvas ref="moon" class="globe-satellite" aria-hidden="true" hidden />
    <canvas ref="lunarLayer" class="lunar-transition" aria-hidden="true" hidden />
    <div ref="labels" class="globe-labels" role="group" aria-label="提瓦特地区" />
    <Transition name="overview-guide">
      <dialog v-if="overviewGuideVisible" ref="overviewGuide" class="overview-guide"
              :aria-labelledby="overviewGuideId" @cancel.stop.prevent="emit('overview-dismiss')"
              @keydown.enter.prevent="emit('overview-dismiss')"
              @pointerdown.stop @pointerup.stop @keydown.stop @wheel.stop.prevent>
        <button class="overview-guide-trigger" type="button" :aria-labelledby="overviewGuideId"
                @click.stop.prevent="emit('overview-dismiss')" />
        <svg class="overview-guide-ring" viewBox="0 0 1000 1000" fill="none" aria-hidden="true">
          <circle cx="500" cy="500" r="498" stroke="currentColor" stroke-width="1.6"
                  stroke-dasharray="10 8" vector-effect="non-scaling-stroke" />
        </svg>
        <p :id="overviewGuideId" class="overview-guide-copy" tabindex="-1" autofocus>点击地图区域开始体验</p>
      </dialog>
    </Transition>
    <button v-if="!mobileDevice" ref="moonLink" type="button" class="moon-link"
            aria-label="进入霜月" title="进入霜月" hidden @click="emit('select-map', 'MoonCanon')" />
    <p v-if="status" class="globe-status" role="status">{{ status }}</p>
    <Teleport v-if="searchHost" :to="searchHost">
      <form ref="searchForm" class="globe-search"
            @submit.prevent="searchOpen && chooseResult(results[searchIndex])">
        <GlassPanel
          ref="searchField"
          :open="!toolbarCovered"
          class="globe-search-field"
          variant="clear"
          :light="1.55"
          inline
          appear
        >
          <svg viewBox="0 0 24 24" class="globe-search-icon" aria-hidden="true">
            <path d="m16 16 4.5 4.5M18 11A7 7 0 1 1 4 11a7 7 0 0 1 14 0Z"
                  fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          </svg>
          <input v-model="query" type="search" role="combobox" aria-label="跳转到地点"
                 aria-autocomplete="list" :aria-expanded="searchOpen"
                 :aria-controls="searchOpen ? resultListId : undefined"
                 :aria-activedescendant="searchOpen && results.length ? resultId(searchIndex) : undefined"
                 placeholder="搜索地点" @focus="openSearch" @click="openSearch"
                 @keydown="onSearchKeydown" />
        </GlassPanel>
        <GlassPanel :open="searchOpen && !toolbarCovered" :anchor="searchField?.element" class="globe-results">
          <div class="globe-result-list scroll-viewport">
            <div :id="resultListId" ref="searchResults" role="listbox" aria-label="地点搜索结果">
              <button v-for="(zone, index) in results" :id="resultId(index)" :key="zone.map + '/' + zone.key"
                      type="button" role="option" tabindex="-1" :aria-selected="index === searchIndex"
                      @mousedown.prevent @click="chooseResult(zone)">
                <span>{{ zone.name }}</span><small v-if="zone.map !== mapName">{{ zone.label }}</small>
              </button>
            </div>
            <p v-if="!results.length" role="status">没有匹配的分区</p>
          </div>
        </GlassPanel>
      </form>
    </Teleport>
  </div>
</template>

<style scoped>
.globe-surface {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  --teyvat-sky: radial-gradient(ellipse at 33% 50%, #17191f, #101216 54%, #08090b);
  --lunar-sky:
    radial-gradient(ellipse at 35% 43%, #28494c 0%, #172e3b 36%, transparent 72%),
    radial-gradient(ellipse at 82% 10%, #25334e 0%, transparent 62%),
    linear-gradient(150deg, #0a1525 4%, #101b2d 47%, #070b17 96%);
  --presented-sky: var(--lunar-sky);
  background: var(--lunar-sky);
}
.globe-surface::before {
  position: absolute;
  inset: 0;
  content: '';
  pointer-events: none;
  background: var(--teyvat-sky);
  opacity: 0;
  transition: opacity var(--scene-transfer-duration) ease-in-out;
}
.teyvat-sky {
  --presented-sky: var(--teyvat-sky);
}
.teyvat-sky::before { opacity: 1; }
.globe-surface > canvas, .globe-labels { position: absolute; inset: 0; width: 100%; height: 100%; }
.globe-surface > .globe-satellite { right: auto; bottom: auto; will-change: translate; }
.globe-surface > canvas:not(.globe-canvas), .globe-labels { pointer-events: none; }
.globe-canvas { cursor: grab; touch-action: none; }
.globe-canvas:active { cursor: grabbing; }
.globe-canvas.target { cursor: pointer; }
.overview-guide {
  position: fixed;
  inset: 0;
  z-index: 100;
  inline-size: 100%;
  block-size: 100%;
  max-inline-size: none;
  max-block-size: none;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: rgb(0 0 0 / .44);
  color: #fff;
}
.overview-guide[open] { display: grid; place-items: center; }
.overview-guide::backdrop { background: transparent; }
.overview-guide-trigger {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.overview-guide-ring,
.overview-guide-copy { grid-area: 1 / 1; pointer-events: none; }
.overview-guide-ring {
  display: block;
  width: calc(var(--overview-diameter, 4px) - 4px);
  opacity: .9;
}
.overview-guide-copy {
  margin: 0;
  font-size: clamp(16px, 1.65vw, 24px);
  font-weight: 400;
  text-align: center;
  text-shadow: 0 1px 8px #000;
}
.overview-guide:focus,
.overview-guide-copy:focus,
.overview-guide-trigger:focus { outline: none; }
.overview-guide-trigger:focus-visible ~ .overview-guide-ring { opacity: 1; }
.overview-guide-enter-active,
.overview-guide-leave-active { transition: opacity 220ms ease; }
.overview-guide-enter-from,
.overview-guide-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .overview-guide-enter-active,
  .overview-guide-leave-active { transition: none; }
}
.globe-labels :deep(.active-zone-label) {
  position: absolute; left: 0; top: 0; background: transparent;
  color: #ffbd98; font-weight: 700; font-size: 14px; line-height: 1.2;
  padding: 6px 5px 6px 16px; text-align: left; white-space: nowrap;
  text-shadow: 0 1px 4px #020b0d, 0 0 8px #000, 0 0 14px #121e1dc9;
}
.globe-labels :deep(.active-zone-label::before) {
  content: ''; position: absolute; height: 1px; top: 50%; background: #ffbd98;
  width: calc(10px + var(--region-label-gap)); left: calc(2px - var(--region-label-gap));
}
.globe-labels :deep(.label-left) { padding-inline: 5px 16px; }
.globe-labels :deep(.label-left::before) { left: auto; right: calc(2px - var(--region-label-gap)); }
.globe-labels :deep(.active-zone-label.label-above) { padding-inline: 10px; text-align: center; }
.globe-labels :deep(.active-zone-label.label-above::before) {
  left: var(--label-anchor-x); top: 100%; width: 1px; height: 9px;
}
@media (max-width: 650px) {
  .globe-labels :deep(.active-zone-label) { font-size: 12px; }
}
.moon-link {
  position: absolute; z-index: 1; left: 0; top: 0; transform: translate(-50%, -50%);
  will-change: translate;
  width: var(--moon-size, 32px);
  height: var(--moon-size, 32px); border-radius: 50%; border: 0;
  padding: 0; background: transparent; color: #dbe6f5; cursor: pointer;
}
.moon-link:focus-visible { outline: 2px solid #e5eadd; outline-offset: 4px; }
.globe-status {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  inline-size: max-content;
  max-inline-size: calc(100% - 48px);
  margin: 0;
  color: #e1eddf;
  text-align: center;
}
.globe-search {
  --search-field-size: 48px;
  position: relative;
  contain: inline-size;
  min-block-size: var(--search-field-size);
  margin: 0;
}
.globe-search-field, .globe-results {
  width: 100%; border-radius: var(--radius-control);
}
.globe-search-field {
  border-radius: 24px;
}
.globe-search-field .globe-search-icon {
  position: absolute;
  z-index: 2;
  top: 50%;
  left: 15px;
  width: 24px;
  height: 24px;
  transform: translateY(-50%);
  pointer-events: none;
}
.globe-search input { display: block; width: 100%; height: var(--search-field-size);
  padding-inline: 53px 14px; font: inherit;
  color: var(--text-primary); background: transparent; border: 0; border-radius: inherit; }
.globe-search input::placeholder { color: var(--text-secondary); }
.globe-results { position: absolute; top: calc(var(--search-field-size) + 5px); }
.globe-result-list { max-height: min(40dvh, 360px); overflow: auto; padding: 4px; }
.globe-results button { border: 0; border-radius: 5px; width: 100%; background: transparent;
  min-height: 38px; text-align: start; padding-inline: 8px; cursor: pointer; }
.globe-results small { display: block; color: var(--text-secondary); font-size: 12px; }
.globe-results button:hover, .globe-results button:focus-visible { background: var(--control-hover); }
.globe-results button[aria-selected='true'] { background: var(--control-active); }
.globe-results p { margin: 8px; }
@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .globe-search { --search-field-size: var(--mobile-control-size, 44px); }
  .globe-result-list {
    max-height: min(40dvh,
      max(40px, calc(var(--visible-viewport-height, 100dvh) - var(--visible-viewport-top, 0px) - 120px)));
  }
  .globe-search-field {
    border-radius: var(--radius-card);
  }

  .globe-search input {
    padding-inline-start: 44px;
    font-size: 16px;
  }
}
</style>
