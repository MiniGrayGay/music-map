<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, useId, watch} from 'vue';
import {resolveRegionalQueue} from '../features/bgm/regionalPlaylist.js';
import {albumForTrack} from '../features/bgm/albumCovers.js';
import {useMusicPlayback} from '../features/bgm/useMusicPlayback.js';
import {useToyFollow} from '../features/bgm/toyFollow.js';
import FluidSourceSurface, {fluidBackdropKey} from './FluidSourceSurface.vue';
import LiquidGlass from './LiquidGlass.vue';
import RevealPanel from './RevealPanel.vue';
import SegmentedChoice from './SegmentedChoice.vue';
import {pushEscapeHandler} from './escapeStack.js';
import ToyFollowPrompt from './ToyFollowPrompt.vue';

const props = defineProps({
  zone: {type: Object, required: true},
  preview: {type: Boolean, default: false},
});
const emit = defineEmits(['close']);

const uid = useId();
const glass = ref(null);
const fluidBackdrop = shallowRef(null);
provide(fluidBackdropKey, fluidBackdrop);
let pendingBackdrop;
let backdropTimer = 0;
const detailsToggle = ref(null);
const volumeToggle = ref(null);
const volumePopover = ref(null);
const volumeInput = ref(null);
const detailsOpen = ref(false);
const titleLine = ref(null);
const departingTitle = ref(null);
const trackCount = ref(null);
const queueFrame = ref(null);
const queueScroll = ref(null);
const detailsBody = ref(null);
const volumeOpen = ref(false);
const mobileVolume = matchMedia('(max-width: 700px), (pointer: coarse)');
const systemVolume = ref(mobileVolume.matches);
const selectedId = ref(null);
const overrides = shallowRef({});
const browse = shallowRef(overrides.value);
const zone = computed(() => props.zone);
const music = computed(() => resolveRegionalQueue(zone.value, overrides.value));
const tracks = computed(() => music.value.tracks);
const browseMusic = computed(() => browse.value === overrides.value
  ? music.value : resolveRegionalQueue(zone.value, browse.value));
const browseTracks = computed(() => browseMusic.value.tracks);
const queueKey = computed(() => `${zone.value.key}:${browseTracks.value.map(({id}) => id).join(',')}`);
let queueHeightMotion;
const activeIndex = computed(() => Math.max(
  0,
  tracks.value.findIndex(({id}) => id === selectedId.value),
));
const track = computed(() => tracks.value[activeIndex.value] ?? null);
const title = computed(() => track.value?.displayName ?? '暂无曲目');
const cover = computed(() => track.value ? albumForTrack(track.value.id) : null);
// 图片加载失败时回退音符占位；封面地址一变就重置，切歌不误报别的封面。
const coverFailed = ref(false);
watch(() => cover.value?.url, () => {
  coverFailed.value = false;
});
let trackNavigation;
let titleMotion;
let departureMotion;
let countMotion;
const browseMatchesPlayback = computed(() => browseMusic.value.conditions.length === music.value.conditions.length
  && browseMusic.value.conditions.every(({id, value}) =>
    music.value.conditions.some((condition) => condition.id === id && condition.value === value)));

const toyFollow = useToyFollow(props.preview);
const {prompt: followAuthor} = toyFollow;
const {
  audio, progressInput, volume, muted, repeatMode, nativeLoop, toggleRepeat, elapsed, duration, mediaDuration, failure, canPause,
  copyFailureReport,
  play, pause, seek, readPosition, onPause, onPlaying, onSeeking, onSeeked, onEnded, onError, stopProgress,
} = useMusicPlayback({track, zone, preview: props.preview, advance, systemVolume, toyFollow});

function dismissFollowPrompt() {
  followAuthor.value = null;
}

watch(followAuthor, (next, previous) => {
  if (!next && previous) play();
}, {flush: 'sync'});

const repeatLabel = computed(() => repeatMode.value === 'one' ? '单曲循环' : '列表循环');

// 失败通知的“复制报错”：一次复制页面会话内全部失败诊断；成功/失败都有短暂反馈。
const copyState = ref(''); // '' | 'copied' | 'failed'
let copyStateTimer = 0;

async function copyFailureToClipboard() {
  clearTimeout(copyStateTimer);
  const ok = await copyFailureReport();
  copyState.value = ok ? 'copied' : 'failed';
  copyStateTimer = window.setTimeout(() => {
    copyStateTimer = 0;
    copyState.value = '';
  }, 2000);
}

// 音源读取失败改为页面短通知：监听 failure，Teleport 到页面顶部，约 4 秒自动消失。
const failureToast = ref(false);
let failureToastTimer = 0;

function closeFailureToast() {
  clearTimeout(failureToastTimer);
  failureToastTimer = 0;
  clearTimeout(copyStateTimer);
  copyStateTimer = 0;
  copyState.value = '';
  failureToast.value = false;
}

function showFailureToast() {
  if (!failure.value) {
    // 重试/恢复会把 failure 清空，立即收起通知，避免留下空文字的 toast。
    closeFailureToast();
    return;
  }
  failureToast.value = true;
  clearTimeout(failureToastTimer);
  failureToastTimer = window.setTimeout(() => {
    failureToastTimer = 0;
    failureToast.value = false;
  }, 4000);
}

watch(failure, showFailureToast, {flush: 'post'});
// 换曲后不再保留旧通知。
watch(track, closeFailureToast, {flush: 'post'});

const elapsedLabel = computed(() => timeLabel(elapsed.value));
const volumeStyle = computed(() => ({'--range-fill': `${volume.value * 100}%`}));

watch(() => zone.value.key, () => {
  selectedId.value = null;
  overrides.value = {};
  browse.value = overrides.value;
  volumeOpen.value = false;
}, {flush: 'sync'});

// 记录真正解析出的音轨；切换条件时尽量保留仍在当前曲单里的曲目。
watch(track, (next) => {
  if (next) selectedId.value = next.id;
}, {flush: 'post'});

function cancelTrackMotion() {
  titleMotion?.cancel();
  departureMotion?.cancel();
  countMotion?.cancel();
  departureMotion = undefined;
  departingTitle.value?.removeAttribute('data-title');
}

watch([() => zone.value.key, () => track.value?.id, title, activeIndex],
  ([zoneKey, id, , index], [previousZone, previousId, previousTitle, previousIndex]) => {
    const navigation = trackNavigation;
    trackNavigation = undefined;
    if (zoneKey !== previousZone || id == null || previousId == null
        || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cancelTrackMotion();
      return;
    }
    if (id === previousId || !titleLine.value || !departingTitle.value) return;

    const direction = navigation?.id === id
      ? navigation.direction
      : Math.sign(index - previousIndex) || 1;
    const current = titleLine.value;
    const ghost = departingTitle.value;
    const currentStyle = getComputedStyle(current);
    const ghostStyle = getComputedStyle(ghost);
    // On a rapid skip, continue from whichever of the two titles is most visible.
    const keepGhost = ghost.dataset.title && Number(ghostStyle.opacity) > Number(currentStyle.opacity);
    const visibleTitle = keepGhost ? ghost.dataset.title : previousTitle;
    const {opacity, transform} = keepGhost ? ghostStyle : currentStyle;
    const offset = 10 * direction;
    cancelTrackMotion();

    const easing = 'cubic-bezier(.2,.65,.27,1)';
    ghost.dataset.title = visibleTitle;
    const outgoing = ghost.animate([
      {opacity, transform},
      {opacity: 0, transform: `translateY(${-offset}px)`},
    ], {duration: 150, easing});
    departureMotion = outgoing;
    outgoing.onfinish = () => {
      if (departureMotion === outgoing) ghost.removeAttribute('data-title');
    };
    titleMotion = current.animate([
      {opacity: 0, transform: `translateY(${offset}px)`},
      {opacity: 1, transform: 'translateY(0)'},
    ], {delay: 32, duration: 215, easing, fill: 'backwards'});
    countMotion = trackCount.value?.animate([
      {opacity: .45, transform: `translateY(${offset * .24}px)`},
      {opacity: 1, transform: 'translateY(0)'},
    ], {duration: 200, easing});
  }, {flush: 'post'});

function advance(delta, wrap = false) {
  const length = tracks.value.length;
  if (length < 2) return false;
  const next = activeIndex.value + delta;
  if (!wrap && (next < 0 || next >= length)) return false;
  const {id} = tracks.value[(next + length) % length];
  trackNavigation = {id, direction: delta};
  selectedId.value = id;
  return true;
}

function toggleDetails() {
  if (!detailsOpen.value) browse.value = overrides.value;
  detailsOpen.value = !detailsOpen.value;
}

function updateVolumeMode({matches}) {
  systemVolume.value = matches;
  if (matches) volumeOpen.value = false;
}

function browseCondition(id, value) {
  browse.value = {...browse.value, [id]: value};
}

function queueScrollOwner() {
  const scroll = queueScroll.value;
  if (!scroll || getComputedStyle(scroll).overflowY !== 'visible') return scroll;
  return detailsBody.value;
}

function prepareQueueExit(outgoing) {
  outgoing.inert = true;
  outgoing.setAttribute('aria-hidden', 'true');
  const scroll = queueScrollOwner();
  if (!queueFrame.value || !scroll) return;
  const height = queueFrame.value.getBoundingClientRect().height;
  queueHeightMotion?.cancel();
  queueFrame.value.style.height = `${height}px`;
  outgoing.style.setProperty('--queue-exit-top', `${-scroll.scrollTop}px`);
}

function revealQueue(incoming) {
  incoming.inert = false;
  incoming.removeAttribute('aria-hidden');
  const frame = queueFrame.value;
  const scroll = queueScrollOwner();
  if (!frame || !scroll) return;
  const previousHeight = frame.getBoundingClientRect().height;
  frame.style.height = '';
  scroll.scrollTop = 0;
  const nextHeight = frame.getBoundingClientRect().height;
  if (!previousHeight || Math.abs(previousHeight - nextHeight) < 1
      || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  queueHeightMotion = frame.animate(
    [{height: `${previousHeight}px`}, {height: `${nextHeight}px`}],
    {duration: 210, easing: 'cubic-bezier(.2,.65,.27,1)'},
  );
}

async function playFromList(item) {
  overrides.value = browse.value;
  selectedId.value = item.id;
  await nextTick();
  if (track.value?.id === item.id && !canPause.value) play();
}

function timeLabel(seconds) {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function seekWithArrow(event) {
  const steps = {ArrowLeft: -.25, ArrowDown: -.25, ArrowRight: .25, ArrowUp: .25};
  const step = steps[event.key];
  if (step === undefined) return;
  event.preventDefault();
  seek(event.currentTarget.valueAsNumber + step);
}

function setVolume(event) {
  volume.value = event.target.valueAsNumber;
  muted.value = volume.value === 0;
}

function focusVolume() {
  const active = document.activeElement;
  if (active === volumeToggle.value || active === document.body) {
    volumeInput.value?.focus({preventScroll: true});
  }
}

function toggleMute() {
  if (volume.value === 0) {
    volume.value = 0.65;
    muted.value = false;
  } else {
    muted.value = !muted.value;
  }
}

function closeOnEscape(open, opener) {
  return pushEscapeHandler(() => {
    if (!open.value) return false;
    open.value = false;
    void nextTick(() => opener.value?.focus({preventScroll: true}));
    return true;
  });
}

watch(detailsOpen, (open, _, cleanup) => {
  if (open) cleanup(closeOnEscape(detailsOpen, detailsToggle));
}, {flush: 'sync'});

watch(volumeOpen, (open, _, cleanup) => {
  if (!open) return;
  const release = closeOnEscape(volumeOpen, volumeToggle);
  function dismiss(event) {
    if (volumePopover.value?.contains(event.target) || volumeToggle.value?.contains(event.target)) return;
    volumeOpen.value = false;
  }
  document.addEventListener('pointerdown', dismiss, true);
  cleanup(() => {
    release();
    document.removeEventListener('pointerdown', dismiss, true);
  });
}, {flush: 'post'});

function reactToControl(event) {
  if (systemVolume.value || !(event.target instanceof Element)) return;
  const clicked = event.type === 'click';
  const control = event.target.closest(clicked ? 'button' : 'input[type="range"]');
  if (!control || control.disabled || control.matches('.icon-button:not(.play-toggle)')) return;
  glass.value?.reactAt(control, clicked && event.detail ? event : null);
}

function updateBackdrop(canvas) {
  // 移动端不用 WebGL 玻璃按钮，跳过背景采样，避免多余的画布与编码开销。
  if (mobileVolume.matches) return;
  pendingBackdrop = canvas;
  if (!fluidBackdrop.value) {
    fluidBackdrop.value = {canvas};
  } else if (!backdropTimer) {
    backdropTimer = window.setTimeout(() => {
      backdropTimer = 0;
      fluidBackdrop.value = {canvas: pendingBackdrop};
    }, 90);
  }
}

defineExpose({updateBackdrop, pause});
onMounted(() => mobileVolume.addEventListener('change', updateVolumeMode));
onBeforeUnmount(() => {
  mobileVolume.removeEventListener('change', updateVolumeMode);
  clearTimeout(failureToastTimer);
  clearTimeout(copyStateTimer);
  clearTimeout(backdropTimer);
  queueHeightMotion?.cancel();
  cancelTrackMotion();
});
</script>

<template>
  <section
    class="music-player"
    :class="{'music-player--preview': preview}"
    aria-label="区域音乐播放器"
    @pointerdown.stop
    @click.capture="reactToControl"
    @click.stop
    @change="reactToControl"
    @dblclick.stop
    @contextmenu.stop
    @wheel.stop
    @keydown.stop
  >
    <LiquidGlass ref="glass" />
    <div class="player-body liquid-panel-body">
      <header class="player-heading">
        <div class="cover-slot" aria-hidden="true">
          <img v-if="cover && !coverFailed" class="album-cover" :src="cover.url" alt="" draggable="false"
               @error="coverFailed = true">
          <svg v-else class="cover-placeholder" viewBox="0 0 24 24">
            <path d="M9 5v9.6a3 3 0 1 0 2 2.8V8.6l8-1.8v6.8a3 3 0 1 0 2 2.8V4L9 6.4V5Z" />
          </svg>
        </div>
        <div class="track-heading">
          <div class="track-title-row">
            <h2 ref="titleLine" class="track-name" :title="track?.displayName" :data-source="track?.id">
              {{ title }}
            </h2>
            <span ref="departingTitle" class="track-title-outgoing" aria-hidden="true" />
          </div>
          <div class="zone-row">
            <p class="zone-name" :title="zone.name">{{ zone.name }}</p>
            <span v-if="tracks.length > 1" ref="trackCount" class="count">
              {{ activeIndex + 1 }} / {{ tracks.length }}
            </span>
          </div>
          <p v-if="track" class="album-row" :title="track.album">
            {{ track.album }}
          </p>
          <p v-else class="album-row album-row--empty" aria-hidden="true"></p>
        </div>
        <button
          v-if="!preview"
          type="button"
          class="icon-button"
          aria-label="关闭播放器"
          title="关闭播放器"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <div class="seek-row">
        <span aria-hidden="true">{{ elapsedLabel }}</span>
        <input
          ref="progressInput"
          class="player-range progress"
          type="range"
          min="0"
          :max="duration || 1"
          step="any"
          value="0"
          :disabled="!mediaDuration || !!failure"
          aria-label="播放进度"
          :aria-valuetext="`${elapsedLabel} / ${timeLabel(duration)}`"
          @input="seek($event.target.valueAsNumber)"
          @keydown="seekWithArrow"
        >
        <span aria-hidden="true">{{ duration ? timeLabel(duration) : '–:–' }}</span>
      </div>

      <div class="transport">
        <div v-if="!systemVolume" class="volume-control">
          <button
            ref="volumeToggle"
            type="button"
            class="icon-button"
            aria-label="音量设置"
            title="音量设置"
            :aria-expanded="volumeOpen"
            :aria-controls="volumeOpen ? `${uid}-volume` : undefined"
            @click="volumeOpen = !volumeOpen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 9v6h4l5 4V5L7 9H3Z" />
              <path v-if="muted || volume === 0" d="m16 10 5 5m0-5-5 5" />
              <path v-else d="M16 9a4 4 0 0 1 0 6m2.7-8.6a8 8 0 0 1 0 11.2" />
            </svg>
          </button>
          <Transition name="volume-float" @after-enter="focusVolume">
            <div
              v-show="volumeOpen"
              :id="`${uid}-volume`"
              ref="volumePopover"
              class="volume-popover volume-panel"
              :inert="!volumeOpen"
              role="group"
              aria-label="音量设置"
            >
              <LiquidGlass />
              <button
                type="button"
                class="text-button mute-button"
                :aria-pressed="muted"
                @click="toggleMute"
              >
                <FluidSourceSurface shape="pill" />
                <span class="mute-label">静音</span>
              </button>
              <input
                class="player-range volume-slider"
                ref="volumeInput"
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="volume"
                :style="volumeStyle"
                aria-label="音量"
                :aria-valuetext="`${Math.round(volume * 100)}%`"
                @input="setVolume"
              >
              <span class="volume-value">{{ Math.round(volume * 100) }}%</span>
            </div>
          </Transition>
        </div>

        <div class="playback">
          <button
            type="button"
            class="icon-button previous-track"
            aria-label="上一首"
            title="上一首"
            :disabled="activeIndex === 0"
            @click="advance(-1)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 4v16m16-16L8 12l12 8V4Z" />
            </svg>
          </button>
          <button
            type="button"
            class="icon-button play-toggle"
            :aria-label="canPause ? '暂停' : '播放'"
            :title="canPause ? '暂停' : '播放'"
            :disabled="!track"
            @click="canPause ? pause() : play()"
          >
            <LiquidGlass variant="lens" />
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path v-if="canPause" d="M9 6v12m6-12v12" stroke-width="2.5" />
              <path v-else d="M9 5.8 19 12 9 18.2V5.8Z" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <button
            type="button"
            class="icon-button next-track"
            aria-label="下一首"
            title="下一首"
            :disabled="activeIndex >= tracks.length - 1"
            @click="advance(1)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 4v16M4 4l12 8-12 8V4Z" />
            </svg>
          </button>
        </div>

        <button
          type="button"
          class="icon-button repeat-toggle"
          :aria-label="repeatMode === 'one' ? '单曲循环，切换到列表循环' : '列表循环，切换到单曲循环'"
          :title="repeatLabel"
          :data-mode="repeatMode"
          @click="toggleRepeat"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m16 4 4 3-4 3M4 11v-1a3 3 0 0 1 3-3h13m-12 7-4 3 4 3M20 13v1a3 3 0 0 1-3 3H4" />
            <path v-if="repeatMode === 'one'" data-repeat-one d="M10.25 10.8 12 9.5V15m-1.65 0h3.3" />
          </svg>
        </button>
        <button
          ref="detailsToggle"
          type="button"
          class="icon-button details-toggle"
          aria-label="歌曲列表"
          :title="detailsOpen ? '收起歌曲列表' : '歌曲列表'"
          :aria-expanded="detailsOpen"
          :aria-controls="detailsOpen ? `${uid}-details` : undefined"
          @click="toggleDetails"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h15M4 10h10M4 15h7m6 1.5V10l4-1" />
            <ellipse cx="15.5" cy="17" rx="1.5" ry="1.1" />
          </svg>
        </button>
      </div>

      <Teleport to="body">
        <Transition name="failure-toast">
          <div v-if="failureToast" class="failure-toast" role="status">
            <span>{{ failure }}</span>
            <button
              type="button"
              class="retry-button"
              :aria-label="copyState === 'copied' ? '报错已复制' : '复制报错诊断信息'"
              @click="copyFailureToClipboard"
            >{{ copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制报错' }}</button>
          </div>
        </Transition>
      </Teleport>

      <RevealPanel :open="detailsOpen" liquid class="details-reveal">
        <div :id="`${uid}-details`" ref="detailsBody" class="player-details player-drawer scroll-viewport">
          <SegmentedChoice
            v-for="condition in browseMusic.conditions"
            :key="condition.id"
            :label="condition.title"
            :choices="condition.entries"
            :value="condition.value"
            wrap
            @select="browseCondition(condition.id, $event)"
          />
          <p v-if="zone.inheritedFromName" class="track-source">曲目来源于「{{ zone.inheritedFromName }}」</p>
          <div ref="queueFrame" class="queue-frame">
            <div ref="queueScroll" class="queue-scroll scroll-viewport">
              <div class="queue-content">
                <Transition name="queue-switch" @before-leave="prepareQueueExit" @enter="revealQueue">
                  <ul v-if="browseTracks.length" :key="queueKey" class="track-list" aria-label="歌曲列表">
                    <li v-for="item in browseTracks" :key="item.id">
                      <button
                        type="button"
                        :aria-current="browseMatchesPlayback && item.id === track?.id ? 'true' : undefined"
                        :title="item.displayName"
                        @click="playFromList(item)"
                      >
                        <svg class="queue-marker" viewBox="0 0 16 16" aria-hidden="true">
                          <path v-if="browseMatchesPlayback && item.id === track?.id" d="M3 6v4m5-7v10m5-8v6" />
                          <path v-else d="M5 3.5 12 8l-7 4.5z" />
                        </svg>
                        <span class="queue-name">{{ item.displayName }}</span>
                        <span v-if="item.duration" class="queue-duration">{{ timeLabel(item.duration) }}</span>
                      </button>
                    </li>
                  </ul>
                  <p v-else :key="queueKey" class="track-source">
                    暂无曲目
                  </p>
                </Transition>
              </div>
            </div>
          </div>
        </div>
      </RevealPanel>
    </div>
    <audio
      ref="audio"
      preload="metadata"
      :loop="nativeLoop"
      @loadedmetadata="readPosition"
      @durationchange="readPosition"
      @timeupdate="readPosition"
      @playing="onPlaying"
      @waiting="stopProgress"
      @pause="onPause"
      @seeking="onSeeking"
      @seeked="onSeeked"
      @ended="onEnded"
      @error="onError"
    />
    <ToyFollowPrompt v-if="followAuthor" :author="followAuthor" @dismiss="dismissFollowPrompt" />
  </section>
</template>

<style scoped>
.music-player {
  --player-text: #fff;
  --scroll-thumb: rgb(226 218 209 / .38);
  --scroll-thumb-hover: rgb(226 218 209 / .55);
  --player-secondary: rgb(255 255 255 / .8);
  --player-selection: linear-gradient(145deg, rgb(231 211 192 / .28), rgb(210 200 195 / .13));
  --player-hover: rgb(255 249 244 / .1);
  position: absolute;
  inset-block-start: var(--player-top, 18px);
  inset-inline-end: var(--map-inline-end, 18px);
  width: min(var(--player-width, clamp(340px, 28vw, 428px)), calc(100% - 36px));
  box-sizing: border-box;
  border-radius: 32px;
  color: var(--player-text);
  color-scheme: dark;
  text-shadow: 0 2px 12px rgb(0 0 0 / .4);
  font-size: 14px;
  line-height: 1.4;
  touch-action: auto;
}

.player-body {
  position: relative;
  display: grid;
  row-gap: 8px;
  min-width: 0;
  padding: 17px 17px 14px;
  z-index: 1;
}

.player-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.cover-slot {
  flex: none;
  width: 72px;
  height: 72px;
  overflow: clip;
  border-radius: 12px;
  background: rgb(10 30 38 / .55);
  box-shadow: 0 4px 14px rgb(0 0 0 / .35);
}

.album-cover {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  padding: 21px;
  box-sizing: border-box;
  fill: #63d3e8;
  opacity: .85;
}

.album-row {
  min-height: 17px;
  margin: 1px 0 0;
  overflow: hidden;
  color: var(--player-secondary);
  font-size: 12px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-heading {
  flex: 1;
  min-width: 0;
  padding: 1px 7px 0 0;
  text-shadow: none;
}

.track-title-row {
  position: relative;
  overflow: clip;
}

.track-name, .track-title-outgoing, .zone-name {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-name, .track-title-outgoing {
  font-size: 18px;
  font-weight: 620;
  line-height: 24px;
}

.track-title-outgoing {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
}

.track-title-outgoing::before {
  content: attr(data-title);
}

.zone-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin-top: 2px;
  color: var(--player-secondary);
  font-size: 13px;
  line-height: 19px;
}

.zone-name {
  min-width: 0;
}

.count {
  flex: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.music-player button {
  min-width: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-shadow: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease,
    transform 170ms var(--ease-glass-in);
}

.music-player button:active:not(:disabled) {
  transform: scale(.965);
}

.music-player button:hover:not(:disabled, .icon-button, :has(.fluid-source-surface)) {
  background-color: var(--player-hover);
}

.music-player button[aria-pressed="true"] {
  background-image: var(--player-selection);
}

.music-player :is(button, input):focus-visible {
  outline: 2px solid var(--player-text);
  outline-offset: 2px;
}

.music-player button:disabled {
  opacity: .35;
  cursor: default;
}

.music-player .icon-button {
  position: relative;
  isolation: isolate;
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  padding: 0;
}

.music-player .icon-button:not(.play-toggle) {
  color: var(--player-secondary);
}

.music-player .icon-button:not(.play-toggle):is(:hover:not(:disabled), [aria-expanded="true"], [data-mode="one"]) {
  color: var(--player-text);
}

.icon-button svg {
  position: relative;
  z-index: 1;
  display: block;
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.seek-row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 38px;
  align-items: center;
  gap: 8px;
  min-height: 25px;
  color: var(--player-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.seek-row > :last-child {
  text-align: end;
}

.player-range {
  --range-fill: 0%;
  appearance: none;
  display: block;
  width: 100%;
  min-width: 0;
  height: 25px;
  margin: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.player-range:disabled {
  opacity: .43;
  cursor: default;
}

.player-range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 10px;
  background: linear-gradient(to right, #e1d7ce var(--range-fill), rgb(248 242 236 / .23) 0);
}

.player-range::-moz-range-track {
  height: 3px;
  border-radius: 10px;
  background: linear-gradient(to right, #e1d7ce var(--range-fill), rgb(248 242 236 / .23) 0);
}

.player-range::-webkit-slider-thumb {
  appearance: none;
  width: 10px;
  height: 10px;
  margin-top: -3.5px;
  border: 0;
  border-radius: 50%;
  background: #f1ebe7;
}

.player-range::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border: 0;
  border-radius: 50%;
  background: #f1ebe7;
}

.transport {
  --transport-button-size: 36px;
  --transport-gap: 6px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
}

.details-toggle {
  grid-area: 1 / 3;
  justify-self: end;
}

.volume-control {
  position: relative;
  grid-area: 1 / 1;
  justify-self: start;
  z-index: 2;
}

.volume-popover {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-end: calc(100% + 10px);
  translate: 0 -50%;
  inline-size: 204px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 37px;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 18px;
  box-sizing: border-box;
}

.volume-popover > :not(.liquid-glass) {
  position: relative;
}

@media (prefers-reduced-motion: no-preference) {
  .volume-float-enter-active,
  .volume-float-leave-active {
    transform-origin: right center;
    transition: transform 200ms var(--ease-glass-in), opacity 150ms ease;
  }

  .volume-float-enter-from,
  .volume-float-leave-to {
    transform: translateX(6px) scale(.94);
    opacity: 0;
  }
}

.mute-button {
  isolation: isolate;
}

.mute-label {
  position: relative;
}

.volume-value {
  text-align: end;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.music-player .text-button {
  min-height: 34px;
  padding: 0 10px;
  white-space: nowrap;
}

.playback {
  display: contents;
}

.previous-track {
  grid-area: 1 / 1;
  justify-self: end;
  margin-inline-end: var(--transport-gap);
}

.next-track {
  grid-area: 1 / 3;
  justify-self: start;
  margin-inline-start: var(--transport-gap);
}

.music-player .play-toggle {
  grid-area: 1 / 2;
  width: 54px;
  height: 54px;
}

.play-toggle > svg {
  width: 26px;
  height: 26px;
}

.repeat-toggle {
  grid-area: 1 / 3;
  justify-self: start;
  margin-inline-start: calc(var(--transport-button-size) + var(--transport-gap) * 2);
}

.failure-toast {
  position: fixed;
  inset-block-start: max(12px, env(safe-area-inset-top));
  inset-inline: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: max-content;
  max-width: min(420px, calc(100% - 24px));
  margin-inline: auto;
  padding: 9px 16px;
  border-radius: 999px;
  background: rgb(12 24 34 / .78);
  box-shadow: 0 6px 18px rgb(0 0 0 / .35);
  color: #fff;
  font-size: 13px;
  text-shadow: none;
  pointer-events: auto;
  backdrop-filter: blur(8px);
}

/* Teleport 到 body 后继承不到播放器内的按钮样式，通知按钮独立成套。 */
.failure-toast .retry-button {
  min-height: 0;
  padding: 0;
  border: none;
  background: none;
  color: #ffd9a8;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (prefers-reduced-motion: no-preference) {
  .failure-toast-enter-active,
  .failure-toast-leave-active {
    transition: opacity 180ms ease, transform 180ms ease;
  }

  .failure-toast-enter-from,
  .failure-toast-leave-to {
    opacity: 0;
    transform: translateY(-8px);
  }
}

.details-reveal {
  --reveal-gap: 8px;
}

.player-details {
  display: grid;
  gap: 7px;
  min-width: 0;
  padding-top: 2px;
}

.track-source {
  margin: 0;
  color: var(--player-secondary);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.queue-frame {
  overflow: clip;
}

.queue-scroll {
  min-width: 0;
  max-height: clamp(48px, calc(100dvh - 270px), 190px);
  padding: 2px;
  overflow: hidden auto;
  overscroll-behavior: contain;
}

.queue-content {
  position: relative;
  /* Keep the entering transform and outgoing list out of the native scroll range. */
  overflow: clip;
}

.track-list {
  display: grid;
  align-content: start;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.queue-switch-enter-active,
.queue-switch-leave-active {
  transition: opacity 160ms ease, transform 210ms var(--ease-glass-in);
}

.queue-switch-enter-from {
  transform: translateY(7px);
  opacity: 0;
}

.queue-switch-leave-active {
  position: absolute;
  inset: var(--queue-exit-top, 0) 0 auto;
  pointer-events: none;
}

.queue-switch-leave-to {
  transform: translateY(-5px);
  opacity: 0;
}

.track-list li, .queue-name {
  min-width: 0;
}

.track-list button {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 5px 9px;
  border-radius: 10px;
  text-align: start;
}

.track-list button:focus-visible {
  outline-offset: -2px;
}

.queue-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-duration {
  color: var(--player-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.queue-marker {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: .66;
}

.track-list button[aria-current="true"] {
  background-image: var(--player-selection);
}

.music-player audio {
  display: none;
}

@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .music-player {
    --player-bottom: max(10px, env(safe-area-inset-bottom));
    --player-left: max(8px, env(safe-area-inset-left));
    --player-right: max(8px, env(safe-area-inset-right));
    inset-block-start: auto;
    inset-block-end: var(--player-bottom);
    inset-inline: var(--player-left) var(--player-right);
    display: flex;
    flex-direction: column;
    width: min(calc(100% - var(--player-left) - var(--player-right)), 428px);
    max-block-size: calc(100dvh - var(--player-top-clearance, 12px) - var(--player-bottom));
    margin-inline: auto;
    -webkit-tap-highlight-color: transparent;
  }

  .player-body {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    padding: 20px 20px 18px;
  }

  .player-body > :not(.details-reveal) {
    flex: none;
  }

  .transport {
    --transport-button-size: 44px;
    --transport-gap: 7px;
  }

  .details-toggle {
    grid-area: 1 / 1;
    justify-self: start;
  }

  .track-name, .track-title-outgoing {
    font-size: 26px;
    line-height: 32px;
  }

  .cover-slot {
    width: 56px;
    height: 56px;
    border-radius: 10px;
  }

  .cover-placeholder {
    padding: 16px;
  }

  .music-player .icon-button {
    width: 44px;
    height: 44px;
  }

  .music-player .play-toggle {
    width: 54px;
    height: 54px;
  }

  .player-range {
    height: 36px;
  }

  .details-reveal {
    min-block-size: 0;
  }

  .details-reveal > :deep(.reveal-content) {
    display: flex;
  }

  .player-details {
    flex: 1;
    min-block-size: 0;
    max-block-size: min(304px, 46dvh);
    gap: 8px;
    padding: 4px 0 2px;
    align-content: start;
    overflow: hidden auto;
    overscroll-behavior: contain;
  }

  .player-details :deep(.mode-option) {
    min-height: 40px;
  }

  .queue-scroll {
    max-height: none;
    padding: 0 0 2px;
    overflow: visible;
  }

  .track-list button {
    min-height: 44px;
  }
}

@media (min-width: 520px) and (orientation: landscape) and (pointer: coarse) and (max-height: 500px) {
  .music-player {
    inset-inline-start: auto;
    width: min(356px, 49vw);
    margin-inline: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .music-player button,
  .queue-switch-enter-active,
  .queue-switch-leave-active {
    transition: none;
  }

  .queue-switch-enter-from {
    transform: none;
    opacity: 1;
  }

  .queue-switch-leave-active {
    visibility: hidden;
  }

  .music-player button:active:not(:disabled) {
    transform: none;
  }
}

@media (forced-colors: active) {
  .music-player, .volume-popover {
    border: 1px solid CanvasText;
    background: Canvas;
    color: CanvasText;
  }

  .music-player button[aria-pressed="true"] {
    outline: 1px solid Highlight;
    color: Highlight;
  }

  .player-range {
    appearance: auto;
  }
}
</style>
