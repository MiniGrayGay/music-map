<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch} from 'vue';
import LiquidGlass from '../../components/LiquidGlass.vue';
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
  bgm: {type: Object, required: true},
  activeZone: {type: Object, default: null},
  availableMaps: {type: Array, required: true},
  searchHost: {type: HTMLElement, default: null},
  reliefTarget: {type: HTMLElement, default: null},
  reliefAspect: {type: Number, default: null},
  mobileDevice: {type: Boolean, default: false},
  smoothBoundaries: {type: Boolean, default: true},
});
const emit = defineEmits([
  'view', 'zone-activate', 'zone-focus', 'select-map', 'unavailable', 'canvas-frame', 'relief-reveal',
]);
const atlas = import.meta.glob('./globe/atlas/*', {eager: true, query: '?url', import: 'default'});
const chart = {
  Teyvat: {home: [.43, -.16], span: [4.03, 2.43], sea: [21, 60, 76], oceanRelief: true},
  SeaOfBygoneEras: {home: [0, .02], span: [3.25, 2.2], sea: [18, 61, 78]},
  AncientSacredMountain: {home: [0, .04], span: [3.13, 2.25], sea: [20, 64, 79]},
  TempleOfSpace: {home: [0, .03], span: [2.6, 2.42], sea: [33, 48, 68]},
  MoonCanon: {home: [.08, .01], span: fullSpan, sea: [28, 48, 71], projection: 2},
};
// Atlas positions over the settlements used to locate each region on the overview.
const regionAnchors = [
  ['蒙德', [.763, .514]],
  ['璃月', [.7159, .6582]],
  ['稻妻', [.9271, .7983]],
  ['须弥', [.603, .6526]],
  ['枫丹', [.5254, .4499]],
  ['纳塔', [.3251, .7292]],
  ['至冬', [.4386, .1291]],
  ['挪德卡莱', [.3086, .5529]],
];
const canvas = ref(null);
const moon = ref(null);
const lunarLayer = ref(null);
const signals = ref(null);
const stars = ref(null);
const labels = ref(null);
const moonLink = ref(null);
const query = ref('');
const searchForm = ref(null);
const searchResults = ref(null);
const searchOpen = ref(false);
const searchIndex = ref(0);
const resultListId = useId();
const status = ref('正在加载地图');
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
  searchOpen.value = Boolean(query.value.trim());
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
  void nextTick(() => searchResults.value?.children[searchIndex.value]?.scrollIntoView({block: 'nearest'}));
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
  if (result.map === props.mapName) {
    jumpToZone(result.key);
  } else {
    pendingSelection = {map: result.map, key: result.key};
    emit('select-map', result.map);
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
      world.regions = id === 'Teyvat' ? regionAnchors.map(([name, uv]) => {
        const [lon, lat] = atlasAngles(world, ...uv);
        return {name, uv, lon, lat, vector: direction(lon, lat)};
      }) : [];
      installedMap = id;
      globe.setWorld(world, image, items);
    }
    status.value = '';
    if (pendingSelection && items.some(({zone}) => zone.key === pendingSelection.key)) {
      jumpToZone(pendingSelection.key);
      pendingSelection = undefined;
    } else if (props.activeZone) {
      globe.select(items.find(({zone}) => zone.key === props.activeZone.key) ?? null);
    }
  } catch (error) {
    if (revision === request) status.value = error.message;
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
      lunarLayer: lunarLayer.value,
      signals: signals.value, stars: stars.value, labels: labels.value, fragment,
      onFrame: (element) => emit('canvas-frame', element),
      onReliefReveal: key => emit('relief-reveal', key),
      reliefTarget(key) {
        const target = props.reliefTarget;
        const aspect = props.reliefAspect;
        return aspect != null && target?.dataset.reliefZone === String(key) ? {target, aspect} : null;
      },
      labelObstacles(includeRelief = false) {
        const overlays = document.querySelectorAll(
          '.app-controls, .map-toolbar-row, .layer-picker .panel[data-panel-open], .globe-search, .music-player:not([inert])',
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
  // 装饰月球的 0.44MB 纹理只在不建第二 WebGL 上下文的桌面端预载。
  if (!globe.compact) texture('lroc-color-2k.jpg').then((image) => globe?.setMoon(image)).catch(() => {});
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
  focusZone: () => canvas.value?.focus({preventScroll: true}), jumpToZone,
});
</script>

<template>
  <div class="globe-surface">
    <canvas ref="stars" aria-hidden="true" />
    <canvas ref="canvas" class="globe-canvas" tabindex="0"
            aria-label="球面地图，可拖动或用方向键旋转，滚轮缩放，回车选择地点" />
    <canvas ref="moon" aria-hidden="true" hidden />
    <canvas ref="lunarLayer" class="lunar-transition" aria-hidden="true" hidden />
    <canvas ref="signals" aria-hidden="true" />
    <div ref="labels" class="globe-labels" role="group" aria-label="提瓦特地区" />
    <button v-if="!mobileDevice" ref="moonLink" type="button" class="moon-link"
            aria-label="进入霜月" title="进入霜月" hidden @click="emit('select-map', 'MoonCanon')" />
    <p v-if="status" class="globe-status" role="status">{{ status }}</p>
    <Teleport v-if="searchHost" :to="searchHost">
      <form ref="searchForm" class="globe-search"
            @submit.prevent="searchOpen && chooseResult(results[searchIndex])">
        <div class="globe-search-field map-glass">
          <LiquidGlass variant="clear" :light="1.55" />
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
        </div>
        <div v-if="searchOpen" class="globe-results map-glass scroll-viewport">
          <LiquidGlass />
          <div :id="resultListId" ref="searchResults" role="listbox" aria-label="地点搜索结果">
            <button v-for="(zone, index) in results" :id="resultId(index)" :key="zone.map + '/' + zone.key"
                    type="button" role="option" tabindex="-1" :aria-selected="index === searchIndex"
                    @mousedown.prevent @click="chooseResult(zone)">
              <span>{{ zone.name }}</span><small v-if="zone.map !== mapName">{{ zone.label }}</small>
            </button>
          </div>
          <p v-if="!results.length" role="status">没有匹配的分区</p>
        </div>
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
  background:
    radial-gradient(ellipse at 35% 43%, #28494c 0%, #172e3b 36%, transparent 72%),
    radial-gradient(ellipse at 82% 10%, #25334e 0%, transparent 62%),
    linear-gradient(150deg, #0a1525 4%, #101b2d 47%, #070b17 96%);
}
.globe-surface > canvas, .globe-labels { position: absolute; inset: 0; width: 100%; height: 100%; }
.globe-surface > canvas:not(.globe-canvas), .globe-labels { pointer-events: none; }
.globe-canvas { cursor: grab; touch-action: none; }
.globe-canvas:active { cursor: grabbing; }
.globe-canvas.target { cursor: pointer; }
.globe-labels :deep(:is(.place, .active-zone-label)) {
  position: absolute; left: 0; top: 0; background: transparent;
  color: #e1eddf; border: 0; font-weight: 600; font-size: 14px; line-height: 1.2;
  padding: 6px 5px 6px 16px; text-align: left; white-space: nowrap;
  text-shadow: 0 1px 4px #020b0d, 0 0 8px #000, 0 0 14px #121e1dc9;
}
.globe-labels :deep(.place) { pointer-events: auto; touch-action: none; cursor: pointer; }
.globe-labels :deep(.active-zone-label) { color: #ffbd98; font-weight: 700; }
.globe-labels :deep(:is(.place, .active-zone-label)::before) {
  content: ''; position: absolute; height: 1px; top: 50%; background: #d7efe5a1;
  width: calc(10px + var(--region-label-gap)); left: calc(2px - var(--region-label-gap));
}
.globe-labels :deep(.label-left) { padding-inline: 5px 16px; }
.globe-labels :deep(.label-left::before) { left: auto; right: calc(2px - var(--region-label-gap)); }
.globe-labels :deep(.active-zone-label::before) { background: #ffbd98; }
.globe-labels :deep(.active-zone-label.label-above) { padding-inline: 10px; text-align: center; }
.globe-labels :deep(.active-zone-label.label-above::before) {
  left: var(--label-anchor-x); top: 100%; width: 1px; height: 9px;
}
.globe-labels :deep(.place:hover) { color: #ffb393; }
.globe-labels :deep(.place:focus-visible) { outline: 2px solid #ff976d; }
@media (max-width: 650px) {
  .globe-labels :deep(:is(.place, .active-zone-label)) { font-size: 12px; }
}
.moon-link {
  position: absolute; z-index: 1; translate: -50% -50%; width: var(--moon-size, 32px);
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
.globe-search { contain: inline-size; margin: 0; transition-property: none; }
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
.globe-search input { width: 100%; height: 48px; padding-inline: 53px 14px; font: inherit;
  color: var(--text-primary); background: transparent; border: 0; border-radius: inherit; }
.globe-search input::placeholder { color: var(--text-secondary); }
.globe-results { margin-top: 5px; max-height: min(40vh, 360px); overflow: auto; padding: 4px; }
.globe-results button { border: 0; border-radius: 5px; width: 100%; background: transparent;
  min-height: 38px; text-align: start; padding-inline: 8px; cursor: pointer; }
.globe-results small { display: block; color: var(--text-secondary); font-size: 12px; }
.globe-results button:hover, .globe-results button:focus-visible { background: var(--control-hover); }
.globe-results button[aria-selected='true'] { background: var(--control-active); }
.globe-results p { margin: 8px; }
@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .globe-search-field {
    border-radius: var(--radius-card);
  }

  .globe-search input {
    height: var(--mobile-control-size, 44px);
    padding-inline-start: 44px;
    font-size: 16px;
  }
}
</style>
