<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch} from 'vue';
import {BGM_MODES} from '../features/bgm/bgmStatus.js';
import {resolveMusic} from '../features/bgm/musicGraph.js';
import {useMusicMediaSession} from '../features/bgm/useMusicMediaSession.js';
import {useMusicTransport} from '../features/bgm/useMusicTransport.js';
import {pushEscapeHandler} from './escapeStack.js';
import ScrollPane from './ScrollPane.vue';
import SelectMenu from './SelectMenu.vue';

const props = defineProps({
  zone: {type: Object, required: true},
  mode: {type: String, required: true},
});
const emit = defineEmits(['close', 'update:mode']);
const modeLabels = {exploration: '探索', combat: '战斗'};
const flyoutId = useId();
const audioRef = ref(null);
const trackIndex = ref(0);
const drawer = ref(null);
const drawerTrigger = ref(null);
const seekDraft = ref(null);
const overrides = reactive({});
let loadedTrackId;

const selection = computed(() => {
  if (props.zone.graph) {
    return resolveMusic(props.zone.graph, props.zone.musicState, props.mode, overrides);
  }
  const branch = props.zone.playlists[props.mode][0];
  return {tracks: branch.tracks, conditions: [], incomplete: branch.incomplete};
});
const dayNight = computed(() => selection.value.conditions.find((group) => group.title === '昼夜'));
// 「播放条件」只收已核实的开关：组名与全部选项 label 都经证实才展示。
// 未命名开关的语义留在数据层，其变体曲目组合由「其他曲单」按曲单提供
// 试听，界面不再出现「未命名条件 N」或拿曲名冒充的条件选项。
const advanced = computed(() => selection.value.conditions.filter((group) =>
  group !== dayNight.value && group.named && group.entries.every((entry) => entry.label)));
// 解析层已按源编号序列全局去重，这里直接透传，不再复制去重。
const alternatives = computed(() => selection.value.alternatives ?? []);
const alternativeId = ref(null);
const expandedAlt = ref(null);
const activeAlternative = computed(() =>
  alternatives.value.find((alt) => alt.id === alternativeId.value) ?? null);
const tracks = computed(() => activeAlternative.value?.tracks ?? selection.value.tracks);
const track = computed(() => tracks.value[trackIndex.value]);
const transport = useMusicTransport(audioRef, onEnd);
const {
  phase, requested, playing, current, duration, buffered, volume, adjustableVolume, muted, repeat,
  load, play, pause, seek, setVolume, toggleMute, toggleRepeat,
} = transport;
const position = computed(() => seekDraft.value ?? current.value);
const percent = (seconds) => duration.value > 0 ? Math.min(100, seconds / duration.value * 100) : 0;
const message = computed(() => {
  if (phase.value === 'blocked') return '点播放继续试听';
  if (phase.value === 'error') return '音源读取失败';
  if (!track.value) return selection.value.incomplete ? '当前条件的音轨待核实' : '当前条件暂无音轨';
  return '';
});
const playLabel = computed(() => playing.value ? '暂停' : phase.value === 'error' ? '重试播放' : '播放');

// 曲目文案只允许两种：游戏内已核实的中文曲名，或自然的无曲名状态。
// 不用素材文件名、Wwise 状态值或「地区 · 时段」式拼接充当曲名。
function trackTitle(entry) {
  return entry?.name ?? '未核对曲名';
}

useMusicMediaSession(transport, () => ({
  track: track.value,
  title: trackTitle(track.value),
  zone: props.zone.name,
  previous: trackIndex.value > 0 ? () => selectTrack(trackIndex.value - 1) : null,
  next: trackIndex.value + 1 < tracks.value.length ? () => selectTrack(trackIndex.value + 1) : null,
}));

// 条件选项同理：已核实的语义名（白天/夜间等）优先，否则用切换后可核对
// 的首支曲名；两者都没有时保持无曲名状态，曲数在右侧独立展示。
function conditionLabel(entry) {
  return entry.label ?? entry.firstTrack ?? '未核对曲名';
}

// 曲目抽屉首行：讲清列表来历，并区分两种行为——原游戏在当前条件下如何
// 取曲（解析器实证 arrangement.selection 为 stepRandom/continuousRandom
// 时才是随机候选；scope 全为 fallback 时是游戏沿用的共用曲单），与这里
// 按列表顺序试听的手动预览。未证实的编排不推断，只用自然句。
const trackScopeLabel = computed(() => {
  if (activeAlternative.value) return '其他曲单的候选曲目，按列表顺序试听';
  const current = dayNight.value?.entries.find((entry) => entry.key === dayNight.value.value);
  const condition = `${current?.label ?? ''}${modeLabels[props.mode]}`;
  const random = tracks.value.some((track) => ['stepRandom', 'continuousRandom']
    .includes(track.arrangement?.selection));
  const shared = tracks.value.length > 0
    && tracks.value.every((track) => track.scope === 'fallback');
  if (random && shared) return `原游戏${condition}时随机播放的共用曲单，这里按列表顺序试听`;
  if (random) return `原游戏${condition}时随机播放的候选，这里按列表顺序试听`;
  if (shared) return `原游戏${condition}使用的共用曲单，这里按列表顺序试听`;
  return `${condition}条件下的候选曲目，按列表顺序试听`;
});

// 抽屉里的条件组（advanced 已保证组名与选项 label 均经证实）。选项右侧为
// 切换后的曲数；已确认无曲目的分支写明「无曲目」，与曲名未核对区分开。
const conditionGroups = computed(() => advanced.value.map((group) => ({
  ...group,
  options: group.entries.map((entry) => (entry.count === 0
    ? {value: entry.key, label: '无曲目', meta: ''}
    : {
      value: entry.key,
      label: conditionLabel(entry),
      meta: `${entry.count} 首`,
    })),
})));

// 备选曲单行：辨识文案只来自实际曲名。多曲曲单可展开查看完整曲名，
// 单曲曲单点行直接试听；不编造曲单名。
const alternativeRows = computed(() => alternatives.value.map((alt) => ({
  id: alt.id,
  label: alt.tracks.find((entry) => entry.name)?.name ?? '未核对曲名',
  tracks: alt.tracks,
  expandable: alt.tracks.length > 1,
})));

function pickDefaultCondition() {
  if (tracks.value.length || !dayNight.value || dayNight.value.value) return;
  const daytime = dayNight.value.entries.find((entry) => entry.label === '白天');
  if (daytime) overrides[dayNight.value.id] = daytime.key;
}

watch([() => props.zone, () => props.mode], ([zone], [previous]) => {
  const previousId = loadedTrackId;
  trackIndex.value = 0;
  alternativeId.value = null;
  expandedAlt.value = null;
  pickDefaultCondition();
  if (zone === previous && previousId) keepTrack(previousId);
  loadTrack(zone !== previous ? true : requested.value);
});

function keepTrack(id) {
  const index = tracks.value.findIndex((item) => String(item.id) === String(id));
  trackIndex.value = Math.max(0, index);
}

function loadTrack(autoplay = requested.value) {
  seekDraft.value = null;
  loadedTrackId = track.value?.id;
  load(track.value, {autoplay});
}

function togglePlay() {
  if (playing.value) pause();
  else void play();
}

function selectTrack(index, autoplay = true) {
  if (index < 0 || index >= tracks.value.length) return;
  trackIndex.value = index;
  loadTrack(autoplay);
}

function selectCondition(group, value) {
  // 播放备选曲单时点同一时段按钮也回到该时段主曲单，其余情况值未变则不动。
  if (group.value === value && !activeAlternative.value) return;
  const previousId = track.value?.id;
  alternativeId.value = null;
  expandedAlt.value = null;
  overrides[group.id] = value;
  keepTrack(previousId);
  loadTrack();
}

// 备选曲单选择：直接按曲单播放，不把未核实的开关反塞进播放条件。
// 单曲曲单点行即直接试听；展开行点具体曲目按该曲起播。起播后关抽屉，
// 焦点还给「其他曲单」入口。
function selectAlternative(alt, index = 0) {
  alternativeId.value = alt.id;
  expandedAlt.value = null;
  trackIndex.value = index;
  loadTrack(true);
  drawer.value = null;
  void nextTick(() => drawerTrigger.value?.focus());
}

// 一键回主曲单：曲目在主曲单中仍存在时保持当前曲目不重播，
// 播放/进度/音量等合法状态由 transport 原样保留。
function backToMain() {
  const previousId = track.value?.id;
  alternativeId.value = null;
  keepTrack(previousId);
  loadTrack();
}

function toggleAltExpand(id) {
  expandedAlt.value = expandedAlt.value === id ? null : id;
}

function onEnd() {
  const next = trackIndex.value + 1;
  if (next < tracks.value.length) selectTrack(next);
  else if (repeat.value) selectTrack(0);
}

function commitSeek(event) {
  seek(Number(event.target.value));
  seekDraft.value = null;
}

function fmt(seconds) {
  const whole = Math.floor(seconds || 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function close() {
  pause();
  drawer.value = null;
  emit('close');
}

function toggleDrawer(id, event) {
  if (drawer.value === id) {
    drawer.value = null;
    return;
  }
  drawerTrigger.value = event.currentTarget;
  drawer.value = id;
}

watch([() => tracks.value.length, () => advanced.value.length, () => alternatives.value.length],
  ([count, groups, altLists]) => {
    if ((drawer.value === 'rules' && !groups)
      || (drawer.value === 'tracks' && count < 2)
      || (drawer.value === 'alternatives' && !altLists)
      || (drawer.value === 'volume' && !count)) {
      drawer.value = null;
    }
  });

// 抽屉打开时接管 Escape：先关抽屉，不把播放器一起关掉（escapeStack LIFO）。
let releaseDrawerEscape = null;
watch(drawer, (value) => {
  releaseDrawerEscape?.();
  releaseDrawerEscape = null;
  if (value) {
    releaseDrawerEscape = pushEscapeHandler(() => {
      if (!drawer.value) return false;
      drawer.value = null;
      void nextTick(() => drawerTrigger.value?.focus());
      return true;
    });
  }
});

onMounted(() => {
  pickDefaultCondition();
  loadTrack(true);
});
onBeforeUnmount(() => {
  releaseDrawerEscape?.();
});
</script>

<template>
  <section class="music-player" role="region" aria-label="分区音乐播放器">
    <header class="player-head">
      <h2 class="zone-name" :title="zone.name">{{ zone.name }}</h2>
      <button type="button" class="icon-btn" aria-label="关闭播放器" @click="close">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" />
        </svg>
      </button>
    </header>
    <p v-if="zone.inheritedFromName" class="zone-inherit">音乐沿用{{ zone.inheritedFromName }}</p>

    <div class="modes" role="group" aria-label="音乐模式">
      <button v-for="entry in BGM_MODES" :key="entry" type="button" :aria-pressed="mode === entry"
              @click="emit('update:mode', entry)">{{ modeLabels[entry] }}</button>
    </div>

    <div v-if="dayNight" class="modes" role="group" aria-label="昼夜">
      <button v-for="entry in dayNight.entries" :key="entry.key" type="button"
              :data-value="entry.key"
              :aria-pressed="dayNight.value === entry.key" @click="selectCondition(dayNight, entry.key)">
        {{ conditionLabel(entry) }}
      </button>
    </div>

    <div class="now-playing">
      <span class="track-name" :title="track?.name"
            :data-source="track?.id" :aria-busy="phase === 'buffering' || undefined">
        {{ track ? trackTitle(track) : message }}
      </span>
      <button v-if="tracks.length > 1" type="button" class="count" :aria-expanded="drawer === 'tracks'"
              :aria-controls="drawer === 'tracks' ? flyoutId : null" @click="toggleDrawer('tracks', $event)">
        {{ trackIndex + 1 }} / {{ tracks.length }}<span class="sr-only">，打开曲目列表</span>
      </button>
    </div>

    <div class="transport">
      <button type="button" class="icon-btn play" :aria-label="playLabel"
              :aria-busy="phase === 'buffering' || undefined"
              :disabled="!track" @click="togglePlay">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path :d="playing ? 'M4.5 3.5h2.4v9H4.5zM9.1 3.5h2.4v9H9.1z' : 'M5 3.2v9.6L12.6 8z'"
                fill="currentColor" />
        </svg>
      </button>
      <button v-if="tracks.length > 1" type="button" class="icon-btn previous" aria-label="上一首" :disabled="trackIndex === 0"
              @click="selectTrack(trackIndex - 1)">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button v-if="tracks.length > 1" type="button" class="icon-btn next" aria-label="下一首" :disabled="trackIndex + 1 >= tracks.length"
              @click="selectTrack(trackIndex + 1)">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <input class="progress" type="range" aria-label="播放进度" :min="0" :max="duration || 1"
             step="0.1" :value="position" :disabled="!track || !duration"
             :aria-valuetext="`${fmt(position)}，共 ${fmt(duration)}`"
             :style="{'--progress': `${percent(position)}%`, '--buffered': `${percent(buffered)}%`}"
             @input="seekDraft = Number($event.target.value)" @change="commitSeek"
             @pointercancel="seekDraft = null" @blur="seekDraft = null" />
      <span class="time">{{ fmt(position) }} / {{ fmt(duration) }}</span>
    </div>

    <div v-if="advanced.length || track" class="player-footer">
      <button v-if="advanced.length" type="button" class="conditions-toggle"
              :aria-expanded="drawer === 'rules'" :aria-controls="drawer === 'rules' ? flyoutId : null"
              @click="toggleDrawer('rules', $event)">播放条件</button>
      <button v-if="alternatives.length" type="button" class="conditions-toggle"
              :aria-expanded="drawer === 'alternatives'" :aria-controls="drawer === 'alternatives' ? flyoutId : null"
              @click="activeAlternative ? backToMain() : toggleDrawer('alternatives', $event)">
        {{ activeAlternative ? '返回主曲单' : '其他曲单' }}</button>
      <span v-if="track && message" class="playback-status" role="status">{{ message }}</span>
      <div v-if="track" class="audio-options">
        <button type="button" class="icon-btn"
                aria-label="循环播放" :aria-pressed="repeat"
                @click="toggleRepeat">
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"
               stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 8V6a2 2 0 0 1 2-2h9m-2-2 2 2-2 2m3 6v2a2 2 0 0 1-2 2H5m2-2-2 2 2 2" />
          </svg>
        </button>
        <button type="button" class="icon-btn" aria-label="音量设置"
                :aria-expanded="drawer === 'volume'"
                :aria-controls="drawer === 'volume' ? flyoutId : null"
                @click="toggleDrawer('volume', $event)">
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"
               stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 8h3l4-3v10l-4-3H3z" />
            <path v-if="muted || volume === 0" d="m13.5 8 4 4m0-4-4 4" />
            <path v-else d="M13.5 7.5a3.5 3.5 0 0 1 0 5M16 5a7 7 0 0 1 0 10" />
          </svg>
        </button>
      </div>
    </div>

    <section v-if="drawer" :id="flyoutId" class="player-drawer"
             :aria-label="{tracks: '曲目列表', rules: '播放条件', volume: '音量设置', alternatives: '其他曲单'}[drawer]">
      <ScrollPane v-if="drawer === 'tracks'" label="曲目列表滚动">
        <p class="drawer-scope">{{ trackScopeLabel }}</p>
        <ul class="track-list">
          <li v-for="(entry, index) in tracks" :key="entry.id">
            <button type="button" :aria-current="trackIndex === index || null"
                    :title="entry.name" @click="selectTrack(index)">
              <span>{{ trackTitle(entry) }}</span><span>{{ fmt(entry.duration) }}</span>
            </button>
          </li>
        </ul>
      </ScrollPane>
      <ScrollPane v-else-if="drawer === 'rules'" label="播放条件滚动">
        <div v-for="group in conditionGroups" :key="group.id" class="condition-row">
          <span class="condition-label">{{ group.title }}</span>
          <SelectMenu class="condition-select" :model-value="group.value" :options="group.options"
                      :aria-label="group.title" placement="top"
                      @update:model-value="(value) => selectCondition(group, value)" />
        </div>
      </ScrollPane>
      <ScrollPane v-else-if="drawer === 'alternatives'" label="其他曲单滚动">
        <ul class="track-list">
          <li v-for="alt in alternativeRows" :key="alt.id">
            <button type="button" class="alternative-row"
                    :aria-current="activeAlternative?.id === alt.id || null"
                    :aria-expanded="alt.expandable ? expandedAlt === alt.id : undefined"
                    :title="alt.label"
                    @click="alt.expandable ? toggleAltExpand(alt.id) : selectAlternative(alt)">
              <span>{{ alt.label }}</span>
              <span class="alternative-meta">
                <span>{{ alt.tracks.length }} 首</span>
                <svg v-if="alt.expandable" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"
                        stroke-linecap="round" stroke-linejoin="round"
                        :class="{up: expandedAlt === alt.id}" />
                </svg>
              </span>
            </button>
            <ul v-if="alt.expandable && expandedAlt === alt.id" class="track-list alternative-tracks">
              <li v-for="(entry, index) in alt.tracks" :key="entry.id">
                <button type="button" :title="entry.name"
                        @click="selectAlternative(alt, index)">
                  <span>{{ trackTitle(entry) }}</span><span>{{ fmt(entry.duration) }}</span>
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </ScrollPane>
      <div v-else class="volume-row">
        <button type="button" class="conditions-toggle" :aria-pressed="muted"
                @click="toggleMute">静音</button>
        <input v-if="adjustableVolume" class="progress" type="range" min="0" max="100" step="1" aria-label="音量"
               :value="Math.round((muted ? 0 : volume) * 100)"
               :style="{'--progress': `${(muted ? 0 : volume) * 100}%`}"
               @input="setVolume(Number($event.target.value) / 100)" />
        <output v-if="adjustableVolume">{{ Math.round((muted ? 0 : volume) * 100) }}%</output>
        <span v-else class="playback-status">请用系统音量键调节</span>
      </div>
    </section>

    <audio ref="audioRef" preload="metadata"></audio>
  </section>
</template>

<style scoped>
.music-player {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 6;
  width: 350px;
  max-width: calc(100vw - 86px);
  display: grid;
  gap: 8px;
  padding: 11px 12px 8px;
  border-radius: 12px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-overlay-border);
  backdrop-filter: blur(6px);
}
.player-head, .now-playing, .transport, .player-footer {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}
.player-head, .now-playing, .player-footer {
  justify-content: space-between;
}
.zone-name, .track-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zone-name {
  font-size: 14px;
  line-height: 1.35;
  margin: 0;
}
/* 楼层分区沿用来源分区音乐时的来历行；缺失时不渲染。 */
.zone-inherit {
  margin: -4px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-name {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.25;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: normal;
  overflow-wrap: anywhere;
}
.now-playing { min-height: 38px; }
.player-footer { min-height: 26px; }
.icon-btn, .modes button, .count, .conditions-toggle, .track-list button {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  border-radius: 7px;
}
button:focus-visible, .progress:focus-visible {
  outline: 2px solid var(--control-focus);
  outline-offset: -1px;
}
button:hover:not(:disabled) { background: var(--control-hover); }
button:disabled { opacity: .38; cursor: default; }
.icon-btn {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 30px;
  padding: 0;
}
.transport .play {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(155, 232, 241, .12);
  position: relative;
}
.transport .play[aria-busy="true"]::after {
  content: '';
  position: absolute;
  inset: 1px;
  border: 1px solid transparent;
  border-top-color: var(--accent-cyan);
  border-radius: 50%;
  opacity: 0;
  animation: audio-waiting 900ms linear 320ms infinite;
  pointer-events: none;
}
@keyframes audio-waiting {
  from { opacity: 1; transform: rotate(0deg); }
  to { opacity: 1; transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .transport .play[aria-busy="true"]::after {
    border-color: var(--surface-overlay-border);
    opacity: 1;
    animation: none;
  }
}
.transport .icon-btn:not(.play) {
  width: 34px;
  height: 36px;
}
.modes { display: flex; gap: 5px; }
.modes button {
  flex: 1;
  min-width: 0;
  min-height: 30px;
  padding: 3px 6px;
  border-color: var(--surface-overlay-border);
  font-size: 13px;
}
.modes button[aria-pressed="true"], .track-list button[aria-current],
.audio-options button[aria-pressed="true"], .volume-row button[aria-pressed="true"] {
  border-color: rgb(155 232 241 / .38);
  background: var(--control-hover);
  color: var(--accent-cyan);
}
.count, .time {
  font-size: 12px;
  color: var(--text-secondary);
}
.conditions-toggle {
  font-size: 13px;
  color: var(--text-secondary);
}
.count, .conditions-toggle {
  flex: none;
  min-height: 26px;
  padding: 3px 6px;
  border-color: var(--surface-overlay-border);
}
.time { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
.audio-options, .volume-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.audio-options { margin-inline-start: auto; }
.audio-options .icon-btn {
  width: 34px;
  height: 34px;
}
.volume-row { padding: 3px 8px; }
.volume-row output, .playback-status {
  color: var(--text-secondary);
  font-size: 13px;
}
.volume-row output {
  min-width: 4ch;
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.progress {
  appearance: none;
  flex: 1;
  min-width: 36px;
  height: 24px;
  margin: 0;
  border-radius: 3px;
  background: linear-gradient(to right, var(--accent-cyan) 0 var(--progress),
    rgb(214 226 240 / .32) var(--progress) max(var(--progress), var(--buffered, 0%)),
    rgb(214 226 240 / .16) max(var(--progress), var(--buffered, 0%)) 100%)
    center / 100% 5px no-repeat;
  cursor: pointer;
}
.progress::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent-cyan);
}
.progress::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 50%;
  background: var(--accent-cyan);
}
.player-drawer {
  position: absolute;
  inset-inline: 0;
  bottom: calc(100% + 6px);
  padding: 6px;
  border-radius: 10px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-overlay-border);
  backdrop-filter: blur(6px);
  --pane-limit: min(240px, calc(100dvh - 300px));
}
.drawer-scope {
  margin: 0;
  padding: 4px 8px 6px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.4;
}
.track-list { margin: 0; padding: 0; list-style: none; }
.track-list button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 34px;
  padding: 4px 6px;
  font-size: 13px;
}
.track-list button span:first-child {
  min-width: 0;
  text-align: start;
  overflow-wrap: anywhere;
}
.track-list button span:last-child { flex: none; color: var(--text-secondary); }
.condition-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 2px 6px;
}
.condition-label {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.condition-select { min-width: 0; }
.alternative-row { position: relative; }
.alternative-meta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text-secondary);
}
.alternative-meta path { transition: transform 120ms ease; }
.alternative-meta path.up { transform: rotate(180deg); }
.alternative-tracks { padding-left: 14px; }
.sr-only {
  position: absolute;
  clip-path: inset(50%);
  width: 1px;
  height: 1px;
  overflow: hidden;
}

@media (max-width: 360px) {
  .transport {
    display: grid;
    grid-template-columns: 40px 34px 34px minmax(0, 1fr);
    grid-template-areas: 'play previous next time' 'seek seek seek seek';
    column-gap: 4px;
    row-gap: 0;
  }
  .transport .play { grid-area: play; }
  .transport .previous { grid-area: previous; }
  .transport .next { grid-area: next; }
  .transport .time { grid-area: time; justify-self: end; }
  .transport .progress { grid-area: seek; width: 100%; }
}
</style>
