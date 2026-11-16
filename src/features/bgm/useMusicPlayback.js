import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';

const settingsKey = 'teyvat-bgm-playback';

function readSettings(preview) {
  const defaults = {volume: 0.65, muted: preview, repeatMode: 'all'};
  if (preview) return defaults;
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey));
    if (!saved) return defaults;
    return {
      volume: Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : defaults.volume,
      muted: saved.muted === true,
      repeatMode: saved.repeatMode === 'one' ? 'one' : defaults.repeatMode,
    };
  } catch {
    return defaults;
  }
}

export function useMusicPlayback({track, zone, preview, advance, systemVolume}) {
  const initial = readSettings(preview);
  const audio = ref(null);
  const volume = ref(initial.volume);
  const muted = ref(initial.muted);
  const repeatMode = ref(initial.repeatMode);
  const elapsed = ref(0);
  const mediaDuration = ref(0);
  const duration = computed(() => mediaDuration.value || track.value?.duration || 0);
  const failure = ref('');
  const requested = ref(!preview);
  const playing = ref(false);
  const pending = ref(false);
  const canPause = computed(() => requested.value && (playing.value || pending.value));

  let activeUrl = null;
  let playRequest = 0;
  let session;
  const sessionActions = {
    play: () => play(),
    pause: () => pause(),
    previoustrack: () => advance(-1),
    nexttrack: () => advance(1),
    seekbackward: ({seekOffset = 10}) => seek(elapsed.value - seekOffset),
    seekforward: ({seekOffset = 10}) => seek(elapsed.value + seekOffset),
    seekto: ({seekTime}) => seek(seekTime),
  };

  function applySettings(node) {
    const level = systemVolume.value ? 1 : volume.value;
    if (node.volume !== level) node.volume = level;
    node.muted = systemVolume.value ? false : muted.value;
  }

  function readPosition(event) {
    const node = event.currentTarget;
    if (node.readyState === 0) return;
    mediaDuration.value = Number.isFinite(node.duration) ? node.duration : 0;
    elapsed.value = node.currentTime;
  }

  async function start(node) {
    const attempt = ++playRequest;
    pending.value = true;
    failure.value = '';
    try {
      await node.play();
      if (attempt === playRequest && requested.value && !node.paused) {
        playing.value = true;
        pending.value = false;
      }
    } catch (error) {
      if (attempt !== playRequest || !requested.value || !node.isConnected) return;
      pending.value = false;
      failure.value = error.name === 'NotAllowedError' ? '点击重试开始播放' : '音频播放失败';
    }
  }

  function onPlaying(event) {
    if (event.currentTarget.paused || !requested.value) return;
    playing.value = true;
    pending.value = false;
    failure.value = '';
  }

  function onPause(event) {
    if (event.currentTarget.paused) playing.value = false;
  }

  function onError(event) {
    if (!activeUrl || !event.currentTarget.error) return;
    playRequest += 1;
    playing.value = false;
    pending.value = false;
    failure.value = '音源读取失败';
  }

  function play() {
    requested.value = true;
    const node = audio.value;
    if (!node || !activeUrl) return;
    if (node.error) {
      elapsed.value = 0;
      mediaDuration.value = 0;
      node.load();
    }
    void start(node);
  }

  function pause() {
    requested.value = false;
    playRequest += 1;
    playing.value = false;
    pending.value = false;
    audio.value?.pause();
  }

  function retry() {
    if (!audio.value || !activeUrl) return;
    failure.value = '';
    if (requested.value) play();
    else audio.value.load();
  }

  function seek(seconds) {
    const node = audio.value;
    if (!node || !mediaDuration.value || !Number.isFinite(seconds)) return;
    node.currentTime = Math.min(mediaDuration.value, Math.max(0, seconds));
    elapsed.value = node.currentTime;
  }

  function onEnded(event) {
    const node = event.currentTarget;
    if (!node.ended) return;
    playing.value = false;
    pending.value = false;
    if (!requested.value || (repeatMode.value === 'all' && advance(1, true))) return;
    seek(0);
    void start(node);
  }

  function toggleRepeat() {
    repeatMode.value = repeatMode.value === 'one' ? 'all' : 'one';
  }

  watch([audio, () => track.value?.url, () => zone.value.key], ([node, url], previous) => {
    if (!node) return;
    const sameSource = node === previous[0] && activeUrl === url;
    const newZone = previous[2] !== zone.value.key;
    if (sameSource && !newZone) return;
    if (newZone) requested.value = !preview;

    playRequest += 1;
    elapsed.value = 0;
    mediaDuration.value = 0;
    playing.value = false;
    pending.value = false;
    failure.value = '';
    activeUrl = url;
    node.pause();
    applySettings(node);
    if (url) node.src = url;
    else node.removeAttribute('src');
    node.load();
    if (url && requested.value) void start(node);
  }, {flush: 'post'});

  watch([volume, muted, repeatMode], () => {
    if (audio.value) applySettings(audio.value);
    if (preview) return;
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        volume: volume.value,
        muted: muted.value,
        repeatMode: repeatMode.value,
      }));
    } catch {
      // 禁用本地储存时，控件仍可在当前会话使用。
    }
  });

  watch(systemVolume, () => {
    if (audio.value) applySettings(audio.value);
  });

  function syncSessionMetadata() {
    if (!session || typeof MediaMetadata === 'undefined') return;
    session.metadata = track.value ? new MediaMetadata({
      title: track.value.displayName,
      artist: zone.value.name,
    }) : null;
  }

  onMounted(() => {
    if (preview || !('mediaSession' in navigator)) return;
    session = navigator.mediaSession;
    session.playbackState = playing.value ? 'playing' : 'paused';
    syncSessionMetadata();
    for (const [action, handler] of Object.entries(sessionActions)) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // 浏览器可能只支持系统媒体动作的子集。
      }
    }
  });

  watch([track, () => zone.value.name], syncSessionMetadata);
  watch(playing, (value) => {
    if (session) session.playbackState = value ? 'playing' : 'paused';
  });

  onBeforeUnmount(() => {
    pause();
    const node = audio.value;
    if (node) {
      activeUrl = null;
      node.removeAttribute('src');
      node.load();
    }
    if (!session) return;
    session.metadata = null;
    session.playbackState = 'none';
    for (const action of Object.keys(sessionActions)) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // 与注册时的浏览器支持范围一致。
      }
    }
  });

  return {
    audio, volume, muted, repeatMode, toggleRepeat, elapsed, duration, mediaDuration, failure, canPause,
    play, pause, retry, seek, readPosition, onPause, onPlaying, onEnded, onError,
  };
}
