<script setup>
import {computed, nextTick, onBeforeUnmount, ref, useId, watch} from 'vue';
import {playlistTracks, tracksForPlaylist} from '../features/bgm/playlistLibrary.js';
import {decodePlaylistShareCode, encodePlaylistShareCode} from '../features/bgm/playlistShareCode.js';
import {pushEscapeHandler} from './escapeStack.js';
import FavoriteHeart from './FavoriteHeart.vue';
import GlassPanel from './GlassPanel.vue';
import LiquidGlass from './LiquidGlass.vue';
import PlayPauseIcon from './PlayPauseIcon.vue';
import {useAnchoredPanel} from './panelMotion.js';

const props = defineProps({
  library: {type: Object, required: true},
  readBackdrop: {type: Function, required: true},
  playback: {type: Object, default: null},
});
const emit = defineEmits(['play', 'page-open']);
const id = useId();
const mobileQuery = matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 500px)');
const mobile = ref(mobileQuery.matches);
const opener = ref(null);
const pane = ref(null);
const heading = ref(null);
const backButton = ref(null);
const tabStrip = ref(null);
const pageContent = ref(null);
const more = ref(null);
const menu = ref(null);
const menuStyle = ref({});
const scroll = ref(null);
const field = ref(null);
const opened = ref(false);
const menuOpen = ref(false);
const tab = ref('playlists');
const tabDestination = ref(null);
const view = ref('library');
const selectedListId = ref(null);
const draft = ref('');
const search = ref('');
const checking = ref(new Set());
const message = ref('');
const pageBackground = ref({});
const resultStep = 60;
const visibleLimit = ref(resultStep);
const {playlists, favorites, storageFailed, savePlaylist, removePlaylist, toggleFavorite} =
  props.library;
const paneMotion = useAnchoredPanel(() => opener.value);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let viewMotion;

const current = computed(() => playlists.value.find((list) => list.id === selectedListId.value));
const favoriteIds = computed(() => new Set(favorites.value));
const highlightedTab = computed(() => tabDestination.value ?? tab.value);
const isFavorites = computed(() => view.value === 'library' && tab.value === 'favorites');
const playingTrackId = computed(() => {
  const id = isFavorites.value ? 'favorites' : current.value?.id;
  return props.playback?.playing && props.playback.key === 'playlist-' + id
    ? props.playback.trackId : null;
});
const selectsTracks = computed(() => ['new-tracks', 'add', 'edit'].includes(view.value));
const displaysTracks = computed(() => selectsTracks.value || isFavorites.value || view.value === 'detail');
const titles = {
  library: '歌单',
  new: '新建歌单',
  'new-tracks': '选择收藏歌曲',
  rename: '重命名',
  add: '添加歌曲',
  edit: '编辑曲目',
  import: '导入歌单',
  share: '分享歌单',
  delete: '删除歌单',
};
const title = computed(() => view.value === 'detail' ? current.value?.name : titles[view.value]);
const tracks = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (view.value === 'add') {
    const existing = new Set(current.value?.trackIds ?? []);
    return playlistTracks.filter((track) =>
      !existing.has(track.neteaseId) && track.displayName.toLowerCase().includes(query));
  }
  const ids = isFavorites.value || view.value === 'new-tracks'
    ? favorites.value : current.value?.trackIds ?? [];
  return tracksForPlaylist(ids).filter((track) => track.displayName.toLowerCase().includes(query));
});
const visibleTracks = computed(() => tracks.value.slice(0, visibleLimit.value));
const shareCode = computed(() => view.value === 'share' && current.value?.trackIds.length
  ? encodePlaylistShareCode(current.value.trackIds) : '');

function updateMobile(event) {
  cancelViewMotion();
  mobile.value = event.matches;
  if (opened.value && mobile.value) capturePageBackground();
  if (menuOpen.value) closeMenu();
}
mobileQuery.addEventListener('change', updateMobile);
onBeforeUnmount(() => mobileQuery.removeEventListener('change', updateMobile));

function reveal() {
  if (opened.value) {
    close();
    return;
  }
  if (mobile.value) capturePageBackground();
  opened.value = true;
  void nextTick(focusHeading);
}

function capturePageBackground() {
  const sky = document.querySelector('.globe-surface');
  const background = sky
    ? {'--playlist-sky': getComputedStyle(sky).getPropertyValue('--presented-sky')} : {};
  const source = props.readBackdrop();
  if (source?.width && source.height) {
    // Keep one small, softly filtered sample of the settled map for this page visit.
    const sample = document.createElement('canvas');
    const scale = Math.min(1, 192 / Math.max(source.width, source.height));
    sample.width = Math.max(1, Math.round(source.width * scale));
    sample.height = Math.max(1, Math.round(source.height * scale));
    const context = sample.getContext('2d');
    if (context) {
      try {
        const zoom = 1.14;
        const extraWidth = sample.width * (zoom - 1);
        const extraHeight = sample.height * (zoom - 1);
        context.imageSmoothingQuality = 'high';
        context.filter = 'blur(5px) saturate(110%)';
        context.drawImage(source, -extraWidth / 2, -extraHeight / 2,
          sample.width + extraWidth, sample.height + extraHeight);
        background['--playlist-map'] = 'url("' + sample.toDataURL() + '")';
      } catch {
        // The sky remains available if the map cannot be sampled.
      }
    }
  }
  pageBackground.value = background;
}

function close() {
  cancelViewMotion();
  closeMenu(false);
  opened.value = false;
}

function focusHeading() {
  heading.value?.focus({preventScroll: true});
}

function finishClosing() {
  if (opened.value) return;
  pageBackground.value = {};
  emit('page-open', false);
  void nextTick(() => opener.value?.focus({preventScroll: true}));
}

function suspend(element) {
  element.inert = true;
}

function resume(element) {
  element.inert = false;
}

function showView(target, nextTab, clearSelection) {
  view.value = target;
  tab.value = nextTab;
  search.value = '';
  message.value = '';
  visibleLimit.value = resultStep;
  if (clearSelection) checking.value = new Set();
}

function cancelViewMotion() {
  if (!viewMotion) return;
  const {panel, content, animations, fades, frame} = viewMotion;
  viewMotion = null;
  cancelAnimationFrame(frame);
  for (const {finish} of animations) finish();
  for (const element of fades) element.style.opacity = '';
  panel.style.blockSize = '';
  content.style.translate = '';
  content.inert = false;
  tabDestination.value = null;
}
onBeforeUnmount(cancelViewMotion);

function durationInMilliseconds(style, property) {
  const value = style.getPropertyValue(property).trim();
  return parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
}

async function navigate(target, clearSelection = true, nextTab = tab.value) {
  closeMenu(false);
  const panel = pane.value;
  const content = pageContent.value;
  const pageChanges = target !== view.value;
  if (!panel || !content || reducedMotion.matches || (!pageChanges && nextTab === tab.value && !viewMotion)) {
    cancelViewMotion();
    showView(target, nextTab, clearSelection);
    await nextTick();
    if (scroll.value) scroll.value.scrollTop = 0;
    if (pageChanges) focusHeading();
    return;
  }

  // Tabs keep the header and slide their corresponding list in the direction of selection.
  const direction = pageChanges ? 0 : nextTab === 'favorites' ? 1 : -1;
  const startOffset = parseFloat(content.style.translate) || 0;
  const parts = () => [content, ...(pageChanges
    ? [heading.value, backButton.value, more.value, tabStrip.value] : [])].filter(Boolean);
  const leaving = parts().map((element) => [element, Number(getComputedStyle(element).opacity)]);
  const fromHeight = panel.getBoundingClientRect().height;
  const style = getComputedStyle(panel);
  const dismiss = durationInMilliseconds(style, '--glass-dismiss-duration');
  const reveal = durationInMilliseconds(style, '--glass-reveal-duration');
  cancelViewMotion();
  const motion = {panel, content, animations: [], fades: new Set(), frame: 0, last: 0};
  viewMotion = motion;
  if (!pageChanges) tabDestination.value = nextTab;
  content.inert = true;
  if (!mobile.value) panel.style.blockSize = fromHeight + 'px';

  function animate(duration, update) {
    update(0);
    return new Promise((finish) => {
      motion.animations.push({update, duration, elapsed: 0, finish});
      if (motion.frame) return;
      motion.last = performance.now();
      motion.frame = requestAnimationFrame(paint);
    });
  }

  function paint(now) {
    if (viewMotion !== motion) return;
    motion.frame = 0;
    // Match the glass transition clock so a slow map frame cannot skip the resize.
    const delta = Math.min(40, Math.max(0, now - motion.last));
    motion.last = now;
    for (const item of motion.animations) {
      if (item.elapsed >= item.duration) continue;
      item.elapsed = Math.min(item.elapsed + delta, item.duration);
      item.update(item.elapsed / item.duration);
      if (item.elapsed === item.duration) item.finish();
    }
    if (motion.animations.some(({elapsed, duration}) => elapsed < duration)) {
      motion.frame = requestAnimationFrame(paint);
    }
  }

  const easeOut = (progress) => 1 - (1 - progress) ** 3;
  function fade(element, from, to, duration, travel) {
    motion.fades.add(element);
    return animate(duration, (progress) => {
      const eased = to > from ? easeOut(progress) : progress ** 2;
      element.style.opacity = from + (to - from) * eased;
      if (travel) {
        const [start, end] = travel;
        element.style.translate = (start + (end - start) * eased) + 'px';
      }
    });
  }

  try {
    await Promise.all(leaving.map(([element, opacity]) =>
      fade(element, opacity, 0, dismiss * .65,
        direction && element === content ? [startOffset, -direction * 10] : null)));
    if (viewMotion !== motion) return;
    showView(target, nextTab, clearSelection);
    await nextTick();
    if (viewMotion !== motion) return;
    if (scroll.value) scroll.value.scrollTop = 0;

    const entering = parts();
    // Measure the incoming layout without painting it at the new height yet.
    let toHeight = fromHeight;
    if (!mobile.value) {
      panel.style.blockSize = '';
      toHeight = panel.getBoundingClientRect().height;
      panel.style.blockSize = fromHeight + 'px';
    }
    const growth = toHeight > fromHeight + 1;
    const resizing = Math.abs(toHeight - fromHeight) > 1
      ? animate(reveal * .7, (progress) => {
        panel.style.blockSize = fromHeight + (toHeight - fromHeight) * easeOut(progress) + 'px';
      })
      : Promise.resolve();
    const chrome = entering.filter((element) => element !== content).map((element) =>
      fade(element, 0, 1, reveal * .7));
    if (growth) await resizing;
    if (viewMotion !== motion) return;
    await Promise.all([resizing, ...chrome,
      fade(content, 0, 1, reveal * .85, direction ? [direction * 12, 0] : null),
    ]);
    if (viewMotion === motion && pageChanges) focusHeading();
  } finally {
    if (viewMotion === motion) cancelViewMotion();
  }
}

function back() {
  if (view.value === 'library') close();
  else if (view.value === 'new-tracks') navigate('new', false);
  else if (['detail', 'new', 'import'].includes(view.value)) navigate('library');
  else navigate('detail');
}

function showLibraryTab(next) {
  if (next !== highlightedTab.value) navigate('library', true, next);
}

function openList(list) {
  selectedListId.value = list.id;
  navigate('detail');
}

function updateMenuPosition() {
  const trigger = more.value?.getBoundingClientRect();
  if (!trigger) return;
  const top = trigger.bottom + 4;
  const panel = pane.value?.getBoundingClientRect();
  const minHeight = Math.min(219, innerHeight - 158);
  const bottom = !mobile.value && panel
    ? Math.max(panel.bottom, panel.top + minHeight)
    : panel?.bottom ?? innerHeight;
  menuStyle.value = {
    top: top + 'px',
    right: (innerWidth - trigger.right) + 'px',
    '--menu-max-height': Math.max(40, bottom - top - 4) + 'px',
  };
}

function toggleMenu() {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  updateMenuPosition();
  menuOpen.value = true;
  void nextTick(() => {
    menu.value?.element?.querySelector('button:not(:disabled)')?.focus({preventScroll: true});
  });
}

function closeMenu(restoreFocus = true) {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  if (restoreFocus) void nextTick(() => more.value?.focus());
}

watch(opened, (open, _, cleanup) => {
  if (!open) return;
  cleanup(pushEscapeHandler(() => {
    if (!opened.value) return false;
    if (view.value === 'library') close();
    else back();
    return true;
  }));
});

watch([opened, mobile], ([open, narrow]) => {
  if (open) emit('page-open', narrow);
});
onBeforeUnmount(() => emit('page-open', false));

watch(menuOpen, (open, _, cleanup) => {
  if (!open) return;
  const stopEscape = pushEscapeHandler(() => {
    if (!menuOpen.value) return false;
    closeMenu();
    return true;
  });
  function closeOutside(event) {
    if (menu.value?.element?.contains(event.target) || more.value?.contains(event.target)) return;
    closeMenu(false);
  }
  window.addEventListener('pointerdown', closeOutside, true);
  window.addEventListener('resize', updateMenuPosition);
  cleanup(() => {
    stopEscape();
    window.removeEventListener('pointerdown', closeOutside, true);
    window.removeEventListener('resize', updateMenuPosition);
  });
});

function beginForm(target) {
  draft.value = target === 'rename' ? current.value.name : '';
  navigate(target);
}

function submitName() {
  const name = draft.value.trim();
  if (!name) return;
  if (view.value === 'new') {
    navigate('new-tracks', false);
    return;
  }
  const saved = savePlaylist({...current.value, name});
  if (saved) openList(saved);
}

function createPlaylist() {
  const trackIds = [...checking.value].filter((id) => favoriteIds.value.has(id));
  const saved = savePlaylist({name: draft.value, trackIds});
  if (saved) openList(saved);
}

function toggleChecked(id) {
  const next = new Set(checking.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  checking.value = next;
}

function addChecked(list) {
  if (!list || !checking.value.size) return;
  const updated = savePlaylist({...list, trackIds: [...list.trackIds, ...checking.value]});
  if (updated) openList(updated);
}

function removeChecked() {
  if (!current.value) return;
  const updated = savePlaylist({...current.value,
    trackIds: current.value.trackIds.filter((id) => !checking.value.has(id))});
  if (updated) openList(updated);
}

function deleteList() {
  if (!current.value) return;
  removePlaylist(current.value.id);
  selectedListId.value = null;
  showLibraryTab('playlists');
}

function searchTracks(event) {
  search.value = event.target.value;
  visibleLimit.value = resultStep;
  if (scroll.value) scroll.value.scrollTop = 0;
}

function loadMore(event) {
  const list = event.currentTarget;
  if (visibleLimit.value < tracks.value.length
    && list.scrollTop + list.clientHeight >= list.scrollHeight - 200) {
    visibleLimit.value += resultStep;
  }
}

function play(trackId) {
  const list = isFavorites.value
    ? {id: 'favorites', name: '收藏歌曲', trackIds: favorites.value} : current.value;
  if (!list?.trackIds.length) return;
  const tracks = tracksForPlaylist(list.trackIds);
  if (!tracks.length) return;
  const fromRow = trackId != null;
  emit('play', {id: list.id, name: list.name, tracks, trackId: trackId ?? tracks[0].neteaseId, fromRow});
  if (mobile.value && !fromRow) close();
}

function timeLabel(duration) {
  const seconds = Math.round(duration);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

async function copyShareCode() {
  try {
    await navigator.clipboard.writeText(shareCode.value);
    message.value = '已复制';
  } catch {
    field.value?.focus();
    field.value?.select();
    message.value = '请手动复制';
  }
}

async function pasteShareCode() {
  try {
    draft.value = await navigator.clipboard.readText();
  } catch {
    field.value?.focus();
  }
}

function importList() {
  try {
    const trackIds = decodePlaylistShareCode(draft.value.trim());
    const names = new Set(playlists.value.map((list) => list.name));
    let title = '导入的歌单';
    for (let number = 2; names.has(title); number += 1) title = '导入的歌单 ' + number;
    const saved = savePlaylist({name: title, trackIds});
    if (saved) openList(saved);
  } catch {
    message.value = '分享码无效';
    field.value?.focus();
  }
}
</script>

<template>
  <button
    ref="opener"
    type="button"
    class="playlist-entry map-glass"
    :aria-controls="id"
    :aria-expanded="opened"
    @click="reveal"
  >
    <LiquidGlass variant="clear" />
    <span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h10" />
      </svg>
      歌单
    </span>
  </button>

  <Teleport to=".app">
    <Transition
      name="playlist-page"
      :css="mobile"
      v-bind="mobile ? {} : paneMotion"
      @before-enter="resume"
      @before-leave="suspend"
      @after-leave="finishClosing"
    >
      <component
        :is="mobile ? 'main' : 'aside'"
        v-if="opened"
        :id="id"
        ref="pane"
        class="playlist-pane map-glass"
        :class="{'playlist-pane--page': mobile, 'playlist-pane--detail': view === 'detail'}"
        :style="mobile ? pageBackground : undefined"
        aria-label="歌单"
      >
        <LiquidGlass v-if="!mobile" />
        <div class="playlist-body liquid-panel-body">
          <header class="playlist-header">
            <button
              v-if="mobile || view !== 'library'"
              ref="backButton"
              type="button"
              class="playlist-icon playlist-back"
              :aria-label="view === 'library' ? '返回地图' : '返回'"
              @click="back"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15.5 5.6L11.6 8.72C10.616 9.507 9.304 10.557 9.304 12
                  C9.304 13.443 10.616 14.493 11.6 15.28L15.5 18.4" stroke-width="2.4" />
              </svg>
            </button>
            <h2 ref="heading" tabindex="-1" :title="title">{{ title }}</h2>
            <button
              v-if="view === 'detail'"
              ref="more"
              type="button"
              class="playlist-icon"
              aria-label="更多歌单操作"
              :aria-controls="id + '-menu'"
              :aria-expanded="menuOpen"
              @click="toggleMenu"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <g fill="currentColor" stroke="none">
                  <circle cx="5" cy="12" r="1.55" />
                  <circle cx="12" cy="12" r="1.55" />
                  <circle cx="19" cy="12" r="1.55" />
                </g>
              </svg>
            </button>
            <button v-if="!mobile" type="button" class="playlist-icon" aria-label="关闭歌单" @click="close">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
            </button>
          </header>

          <nav v-if="view === 'library'" ref="tabStrip" class="playlist-tabs" aria-label="歌单管理">
            <button type="button" :aria-pressed="highlightedTab === 'playlists'" @click="showLibraryTab('playlists')">
              我的歌单
            </button>
            <button type="button" :aria-pressed="highlightedTab === 'favorites'" @click="showLibraryTab('favorites')">
              收藏歌曲
            </button>
          </nav>

          <section ref="pageContent" class="playlist-view">
            <div v-if="view === 'library' && tab === 'playlists'" class="playlist-scroll scroll-viewport">
              <nav v-if="playlists.length" aria-label="我的歌单">
                <button
                  v-for="list in playlists"
                  :key="list.id"
                  type="button"
                  class="playlist-list-item"
                  @click="openList(list)"
                >
                  <svg class="playlist-disc" viewBox="0 0 24 24" aria-hidden="true">
                    <circle class="playlist-disc-face" cx="12" cy="12" r="9" />
                    <circle cx="12" cy="12" r="2" />
                    <path d="M6.3 11.1a5.8 5.8 0 0 1 4.8-4.8m6.6 6.6a5.8 5.8 0 0 1-4.8 4.8" />
                  </svg>
                  <span>{{ list.name }}</span>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
                </button>
              </nav>
              <p v-else class="playlist-empty">暂无歌单</p>
            </div>

            <template v-if="displaysTracks">
              <label v-if="view === 'add' || isFavorites || (view === 'new-tracks' && favorites.length)"
                     class="playlist-search">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" />
                </svg>
                <input
                  type="search"
                  aria-label="搜索歌曲"
                  placeholder="搜索歌曲"
                  :value="search"
                  @input="searchTracks"
                >
              </label>
              <div ref="scroll" class="playlist-scroll scroll-viewport" @scroll.passive="loadMore">
                <ul class="playlist-tracks" aria-label="歌单曲目">
                  <li v-for="track in visibleTracks" :key="track.neteaseId" class="playlist-track-row">
                    <component
                      :is="selectsTracks ? 'label' : 'button'"
                      class="playlist-track"
                      :class="selectsTracks ? 'playlist-track--selectable' : 'playlist-track-play'"
                      :type="selectsTracks ? undefined : 'button'"
                      :aria-label="selectsTracks ? undefined
                        : (playingTrackId === track.neteaseId ? '暂停 ' : '播放 ') + track.displayName"
                      @click="!selectsTracks && play(track.neteaseId)"
                    >
                      <span v-if="selectsTracks" class="playlist-track-select">
                        <input
                          type="checkbox"
                          :aria-label="'选择 ' + track.displayName"
                          :checked="checking.has(track.neteaseId)"
                          @change="toggleChecked(track.neteaseId)"
                        >
                        <svg viewBox="0 0 24 24" class="playlist-checkbox" aria-hidden="true">
                          <rect x="4" y="4" width="16" height="16" rx="5.5" stroke-width="2" />
                          <path class="playlist-checkmark" pathLength="1" stroke-width="2"
                                d="m8.25 12 1.95 1.95q.55.55 1.1 0l4.45-4.45" />
                        </svg>
                      </span>
                      <span v-else class="playlist-play-mark" aria-hidden="true">
                        <PlayPauseIcon :playing="playingTrackId === track.neteaseId" />
                      </span>
                      <span class="playlist-track-name" :title="track.displayName">{{ track.displayName }}</span>
                      <span class="playlist-track-time">{{ timeLabel(track.duration) }}</span>
                    </component>
                    <button
                      v-if="isFavorites"
                      type="button"
                      class="playlist-heart"
                      :aria-label="(favoriteIds.has(track.neteaseId) ? '取消收藏 ' : '收藏 ') + track.displayName"
                      :aria-pressed="favoriteIds.has(track.neteaseId)"
                      @click="toggleFavorite(track.neteaseId)"
                    >
                      <FavoriteHeart :filled="favoriteIds.has(track.neteaseId)" />
                    </button>
                  </li>
                </ul>
                <p v-if="!tracks.length && view !== 'detail'" class="playlist-empty">
                  {{ search ? '未找到歌曲' : isFavorites || view === 'new-tracks' ? '暂无收藏' : '暂无歌曲' }}
                </p>
              </div>
            </template>

            <form v-if="view === 'new' || view === 'rename'" id="playlist-name-form" @submit.prevent="submitName">
              <input v-model="draft" class="playlist-input" aria-label="歌单名称" placeholder="歌单名称"
                     maxlength="40" required>
            </form>

            <form v-if="view === 'import'" id="playlist-import-form" @submit.prevent="importList">
              <div class="playlist-code-row">
                <input ref="field" v-model="draft" class="playlist-input" aria-label="分享码"
                       placeholder="输入分享码" maxlength="180" autocomplete="off"
                       autocapitalize="off" spellcheck="false" @input="message = ''">
                <button type="button" class="playlist-quiet" @click="pasteShareCode">粘贴</button>
              </div>
            </form>

            <input v-if="view === 'share'" ref="field" :value="shareCode" class="playlist-input"
                   aria-label="分享码" readonly @focus="$event.target.select()">

            <p v-if="view === 'delete'" class="playlist-confirm">删除「{{ current?.name }}」？</p>

            <p v-if="message || storageFailed" role="status" class="playlist-message">
              {{ message || '暂时无法保存到此浏览器' }}
            </p>

            <footer
              v-if="!isFavorites"
              class="playlist-footer"
            >
              <template v-if="view === 'library' && !isFavorites">
                <button type="button" class="playlist-text-action playlist-library-action"
                        @click="beginForm('import')">导入</button>
                <button type="button" class="playlist-text-action playlist-library-action playlist-create"
                        @click="beginForm('new')">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" stroke="none"
                          d="M12 4a1.25 1.25 0 0 1 1.25 1.25v4.9q0 .6.6.6h4.9a1.25 1.25 0 0 1 0 2.5
                            h-4.9q-.6 0-.6.6v4.9a1.25 1.25 0 0 1-2.5 0v-4.9q0-.6-.6-.6h-4.9
                            a1.25 1.25 0 0 1 0-2.5h4.9q.6 0 .6-.6v-4.9A1.25 1.25 0 0 1 12 4Z" />
                  </svg>
                  新建
                </button>
              </template>
              <template v-else-if="view === 'detail'">
                <button type="button" class="playlist-add" @click="navigate('add')">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                  添加歌曲
                </button>
                <button v-if="tracks.length" type="button" class="playlist-text-action" @click="play()">
                  播放
                </button>
              </template>
              <button v-else-if="view === 'new-tracks'" type="button" class="playlist-text-action"
                      @click="createPlaylist">
                确认创建
              </button>
              <button v-else-if="view === 'add' || view === 'edit'" type="button"
                      class="playlist-action map-glass" :disabled="!checking.size"
                      @click="view === 'add' ? addChecked(current) : removeChecked()">
                <LiquidGlass variant="clear" /><span>{{ view === 'add' ? '添加' : '移除' }}</span>
              </button>
              <button v-else-if="view === 'new'" type="submit" form="playlist-name-form"
                      class="playlist-text-action" :disabled="!draft.trim()">
                选歌
              </button>
              <button v-else-if="view === 'rename'" type="submit"
                      form="playlist-name-form" class="playlist-action map-glass" :disabled="!draft.trim()">
                <LiquidGlass variant="clear" /><span>保存</span>
              </button>
              <button v-else-if="view === 'import'" type="submit" form="playlist-import-form"
                      class="playlist-action map-glass" :disabled="!draft.trim()">
                <LiquidGlass variant="clear" /><span>导入</span>
              </button>
              <button v-else-if="view === 'share'" type="button" class="playlist-action map-glass"
                      @click="copyShareCode">
                <LiquidGlass variant="clear" /><span>复制分享码</span>
              </button>
              <template v-else-if="view === 'delete'">
                <button type="button" class="playlist-quiet" @click="navigate('detail')">取消</button>
                <button type="button" class="playlist-action map-glass" @click="deleteList">
                  <LiquidGlass variant="clear" /><span>删除</span>
                </button>
              </template>
            </footer>
          </section>
        </div>
      </component>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <GlassPanel
      :id="id + '-menu'"
      ref="menu"
      class="playlist-menu"
      :class="{'playlist-menu--touch': mobile}"
      :open="opened && menuOpen"
      :anchor="more"
      :style="menuStyle"
      role="group"
      aria-label="歌单操作"
    >
      <button type="button" :disabled="!current?.trackIds.length" @click="navigate('share')">
        分享歌单
      </button>
      <button type="button" @click="beginForm('rename')">重命名</button>
      <button type="button" :disabled="!current?.trackIds.length" @click="navigate('edit')">
        编辑曲目
      </button>
      <button type="button" @click="navigate('delete')">删除歌单</button>
    </GlassPanel>
  </Teleport>
</template>

<style scoped>
.playlist-entry, .playlist-pane, .playlist-menu {
  font-family: inherit;
}

.playlist-entry, .playlist-pane button, .playlist-menu button {
  background: transparent;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.playlist-entry {
  min-height: var(--map-toolbar-row-height, 54px);
  padding: 0 14px;
  border-radius: var(--radius-card);
  color: var(--text-primary);
}

:is(.playlist-entry, .playlist-action) > span {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  white-space: nowrap;
}

:is(.playlist-entry, .playlist-pane, .playlist-menu) svg {
  width: 17px;
  height: 17px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.playlist-pane {
  position: absolute;
  z-index: 7;
  inset-block-start: 142px;
  inset-inline-start: var(--map-inline-inset, 22px);
  width: min(330px, calc(100% - 2 * var(--map-inline-inset, 22px)));
  max-height: min(510px, calc(100dvh - 158px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: var(--radius-card);
  padding: 14px 16px 13px;
}

.playlist-pane:not(.playlist-pane--page) > :deep(.liquid-glass),
.playlist-menu > :deep(.liquid-glass) {
  backdrop-filter: blur(20px) saturate(140%);
}

.playlist-body, .playlist-view {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.playlist-body, .playlist-view {
  gap: 8px;
}

.playlist-page-enter-active {
  transition: opacity var(--glass-reveal-duration) var(--ease-glass-in),
    transform var(--glass-reveal-duration) var(--ease-glass-in);
}

.playlist-page-leave-active {
  transition: opacity var(--glass-dismiss-duration) ease-in,
    transform var(--glass-dismiss-duration) ease-in;
}

.playlist-page-enter-from, .playlist-page-leave-to {
  opacity: 0;
  transform: scale(.98);
}

.playlist-pane--detail:not(.playlist-pane--page) {
  min-height: min(219px, calc(100dvh - 158px));
}

.playlist-header {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
}

.playlist-header h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 21px;
  line-height: 1.5;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  outline: 0;
}

.playlist-pane .playlist-icon {
  display: grid;
  place-items: center;
  width: 29px;
  min-height: 32px;
  flex: none;
  border-radius: var(--radius-control);
}

.playlist-pane .playlist-icon:not(.playlist-back):hover,
.playlist-pane .playlist-icon[aria-expanded='true'] {
  background: var(--control-hover);
}

.playlist-pane .playlist-back {
  width: 36px;
  min-height: 36px;
  padding: 0;
}

.playlist-back svg {
  width: 26px;
  height: 26px;
  stroke-width: 2;
}

.playlist-pane :is(.playlist-back, .playlist-text-action, .playlist-list-item, .playlist-add,
  .playlist-quiet, .playlist-tabs button):focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -2px;
  background: transparent;
}

.playlist-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  padding: 2px;
}

.playlist-tabs button {
  min-height: 37px;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  transition: color var(--glass-dismiss-duration) ease;
}

.playlist-tabs button[aria-pressed='true'] {
  color: var(--text-primary);
  font-weight: 650;
}

@media (forced-colors: active) {
  .playlist-tabs button[aria-pressed='true'] { outline: 1px solid Highlight; }
}

.playlist-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.playlist-scroll:has(.playlist-empty) {
  display: flex;
  flex-direction: column;
  min-height: 138px;
}

.playlist-empty {
  margin: auto;
  padding: 20px 0;
  color: var(--text-secondary);
}

.playlist-tracks {
  list-style: none;
  margin: 0;
  padding: 0;
}

.playlist-track-row {
  display: flex;
}

.playlist-track {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  min-height: 38px;
}

.playlist-track--selectable {
  padding-inline: 4px 8px;
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: background-color var(--glass-dismiss-duration) ease;
}

.playlist-track--selectable:has(input:checked) {
  background-color: rgb(255 255 255 / .13);
}

.playlist-track--selectable:has(input:focus-visible) {
  outline: 2px solid var(--text-primary);
  outline-offset: -2px;
}

.playlist-track-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playlist-track-time {
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.playlist-pane .playlist-heart {
  flex: none;
  display: grid;
  place-items: center;
  width: 27px;
  padding: 0;
  color: var(--text-secondary);
}

.playlist-pane .playlist-track-play {
  padding: 0;
  border-radius: var(--radius-control);
  text-align: start;
  user-select: none;
}

.playlist-play-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background-color: rgb(220 245 244 / .08);
  color: var(--text-primary);
  transition: background-color var(--glass-dismiss-duration) ease;
}

.playlist-play-mark svg {
  width: 22px;
  height: 22px;
  fill: currentColor;
  stroke-width: 1.6;
}

@media (hover: hover) {
  .playlist-track-play:hover .playlist-play-mark {
    background-color: var(--control-hover);
  }
}

.playlist-pane .playlist-track-play:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: -2px;
  background: transparent;
}

.playlist-track-play:active .playlist-play-mark { background-color: var(--control-active); }

.playlist-track-select {
  display: grid;
  place-items: center;
  min-width: 26px;
  min-height: 35px;
  cursor: pointer;
}

.playlist-track-select input {
  grid-area: 1 / 1;
  inline-size: 20px;
  block-size: 20px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.playlist-track-select .playlist-checkbox {
  grid-area: 1 / 1;
  inline-size: 24px;
  block-size: 24px;
  color: var(--text-secondary);
  pointer-events: none;
  transition: color var(--glass-dismiss-duration) ease;
}

.playlist-checkbox .playlist-checkmark {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  opacity: 0;
  transition: stroke-dashoffset var(--glass-dismiss-duration) ease-in,
    opacity var(--glass-dismiss-duration) step-end;
}

.playlist-track-select input:checked + .playlist-checkbox {
  color: var(--text-primary);
}

.playlist-track-select input:checked + .playlist-checkbox .playlist-checkmark {
  stroke-dashoffset: 0;
  opacity: 1;
  transition: stroke-dashoffset 205ms var(--ease-glass-in);
}

@media (forced-colors: active) {
  .playlist-track--selectable:has(input:checked) {
    outline: 1px solid Highlight;
    outline-offset: -1px;
  }

  .playlist-track-select input { opacity: 1; }
  .playlist-track-select .playlist-checkbox { display: none; }
}

.playlist-pane .playlist-list-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 42px;
  padding: 0 5px;
  border-radius: var(--radius-control);
  text-align: start;
}

.playlist-pane .playlist-add {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 44px;
  margin-inline-end: auto;
  padding-inline: 5px;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
}
.playlist-list-item .playlist-disc {
  width: 25px;
  height: 25px;
  color: var(--text-secondary);
  stroke-width: 1.4;
}

.playlist-disc-face {
  fill: currentColor;
  fill-opacity: .09;
}

.playlist-list-item span { flex: 1; min-width: 0; overflow-wrap: anywhere; }

.playlist-search, .playlist-input {
  min-width: 0;
  min-height: 40px;
  padding: 0 10px;
  background: var(--control-hover);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--text-primary);
}

.playlist-search {
  display: flex;
  align-items: center;
  gap: 7px;
  background: transparent;
}
.playlist-search:focus-within { border-color: var(--text-secondary); }
.playlist-search input {
  width: 100%;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: 0;
  color: inherit;
  font: inherit;
}

.playlist-search input::placeholder,
.playlist-input::placeholder {
  color: var(--text-primary);
  opacity: 1;
  text-shadow: 0 1px 2px rgb(0 0 0 / .45);
}

.playlist-input { width: 100%; font: inherit; }
.playlist-code-row { display: flex; gap: 7px; }
.playlist-code-row .playlist-quiet { flex: none; }
.playlist-confirm, .playlist-message { margin: 4px 0; overflow-wrap: anywhere; }
.playlist-message { color: var(--text-secondary); font-size: 13px; }

.playlist-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: none;
  gap: 8px;
  border-block-start: 1px solid var(--control-hover);
  padding-block-start: 10px;
}

.playlist-pane :is(.playlist-action, .playlist-quiet) {
  min-height: 38px;
  padding: 0 12px;
  border-radius: var(--radius-control);
  font-size: 14px;
}

.playlist-pane .playlist-text-action {
  min-height: 44px;
  padding-inline: 12px;
  color: var(--text-primary);
  font-size: 17px;
  font-weight: 650;
  -webkit-tap-highlight-color: transparent;
}

.playlist-pane .playlist-library-action {
  font-size: 16px;
  font-weight: 400;
}

.playlist-pane .playlist-create {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.playlist-pane button:disabled, .playlist-menu button:disabled {
  opacity: .4;
  cursor: default;
}

.playlist-menu {
  --menu-inset: 5px;
  position: fixed;
  z-index: 60;
  min-width: 124px;
  padding: var(--menu-inset);
  border-radius: var(--radius-card);
}

.playlist-menu > :deep(.liquid-panel-body) {
  display: grid;
  gap: 2px;
  max-height: calc(var(--menu-max-height, 210px) - 2 * var(--menu-inset));
  overflow-y: auto;
}

.playlist-menu button {
  min-height: 36px;
  padding-inline: 11px;
  text-align: start;
  font-size: 13px;
  white-space: nowrap;
  border-radius: calc(var(--radius-card) - var(--menu-inset));
}

.playlist-menu button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -2px;
  background: transparent;
}

.playlist-menu--touch button { min-height: 44px; }

.playlist-pane--page {
  position: fixed;
  z-index: 30;
  inset: var(--visible-viewport-top, 0px) 0 auto;
  width: auto;
  max-height: none;
  height: var(--visible-viewport-height, 100dvh);
  border-radius: 0;
  background-color: #131a20;
  background-image: linear-gradient(180deg, rgb(9 14 18 / .5), rgb(9 14 18 / .63) 56%, rgb(9 14 18 / .76)),
    var(--playlist-map, none), var(--playlist-sky, none);
  background-size: cover;
  background-position: center;
  backdrop-filter: none;
  padding: max(15px, env(safe-area-inset-top)) max(19px, env(safe-area-inset-right))
    max(15px, env(safe-area-inset-bottom)) max(19px, env(safe-area-inset-left));
}

.playlist-pane--page :is(.playlist-body, .playlist-view) { gap: 10px; }
.playlist-pane--page .playlist-footer { margin-block-start: auto; }

.playlist-pane--page .playlist-tabs {
  --text-primary: #f5f5f5;
  --text-secondary: rgb(245 245 245 / .74);
}

.playlist-pane--page .playlist-header { min-height: 56px; }
.playlist-pane--page .playlist-header h2 { font-size: 25px; }
.playlist-pane--page .playlist-track { min-height: 52px; font-size: 16px; }
.playlist-pane--page :is(.playlist-action, .playlist-quiet, .playlist-list-item) {
  min-height: 44px;
}
.playlist-pane--page :is(.playlist-icon, .playlist-track-select) {
  min-width: 38px;
  min-height: 44px;
}
.playlist-pane--page .playlist-back { width: 44px; }
.playlist-pane--page .playlist-play-mark { width: 44px; height: 44px; }
.playlist-pane--page .playlist-heart { width: 44px; }
.playlist-pane--page :is(input[type="search"], .playlist-input) { font-size: 16px; }

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .playlist-entry { padding: 0 10px; font-size: 14px; }
}
</style>
