import {computed, onBeforeUnmount, onMounted, ref} from 'vue';

const storageKey = 'teyvat-bgm-playback';
const bufferingLimitMs = 20_000;

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    const volume = Number.isFinite(saved?.volume) ? Math.min(1, Math.max(0, saved.volume)) : 0.8;
    return {volume, muted: saved?.muted === true, repeat: saved?.repeat === true};
  } catch {
    return {volume: 0.8, muted: false, repeat: false};
  }
}

export function useMusicTransport(element, onEnded) {
  const preferences = readPreferences();
  const phase = ref('idle');
  const requested = ref(false);
  const current = ref(0);
  const duration = ref(0);
  const buffered = ref(0);
  const volume = ref(preferences.volume);
  const adjustableVolume = ref(true);
  const muted = ref(preferences.muted);
  const repeat = ref(preferences.repeat);
  const nominalDuration = ref(0);
  let source = '';
  let request = 0;
  let pendingSeek = null;
  let bufferingTimer;
  const playing = computed(() => phase.value === 'playing');
  const failed = computed(() => phase.value === 'error' || phase.value === 'timeout');

  function setPhase(value) {
    clearTimeout(bufferingTimer);
    phase.value = value;
  }

  function buffer(audio) {
    if (phase.value === 'buffering') return;
    phase.value = 'buffering';
    const activeRequest = request;
    // A server can leave a request open without ever producing a media error.
    bufferingTimer = setTimeout(() => {
      if (activeRequest !== request || !requested.value || phase.value !== 'buffering') return;
      request += 1;
      requested.value = false;
      setPhase('timeout');
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }, bufferingLimitMs);
  }

  function applyPreferences() {
    if (element.value) {
      element.value.volume = volume.value;
      element.value.muted = muted.value;
      adjustableVolume.value = Math.abs(element.value.volume - volume.value) < 0.005;
    }
  }

  function savePreferences() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        volume: volume.value, muted: muted.value, repeat: repeat.value,
      }));
    } catch {
      // Playback works in sessions with storage disabled.
    }
  }

  function setVolume(value) {
    volume.value = Math.min(1, Math.max(0, value));
    if (value > 0) muted.value = false;
    applyPreferences();
    savePreferences();
  }

  function toggleMute() {
    muted.value = !muted.value;
    if (!muted.value && volume.value === 0) volume.value = 0.8;
    applyPreferences();
    savePreferences();
  }

  function toggleRepeat() {
    repeat.value = !repeat.value;
    savePreferences();
  }

  function pause() {
    request += 1;
    requested.value = false;
    element.value?.pause();
    if (!failed.value) setPhase(source ? 'paused' : 'idle');
  }

  async function play() {
    const audio = element.value;
    if (!audio || !source || requested.value) return;
    if (failed.value) {
      if (current.value > 0) pendingSeek = current.value;
      if (audio.src === source) audio.load();
      else audio.src = source;
    }
    if (audio.ended) audio.currentTime = 0;
    const activeRequest = ++request;
    requested.value = true;
    buffer(audio);
    try {
      await audio.play();
      if (activeRequest === request && !audio.paused && !audio.seeking
        && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) setPhase('playing');
    } catch (error) {
      if (activeRequest !== request) return;
      requested.value = false;
      if (error?.name === 'NotAllowedError') setPhase('blocked');
      else if (error?.name === 'AbortError') setPhase('paused');
      else setPhase('error');
    }
  }

  function load(track, {autoplay = requested.value} = {}) {
    const audio = element.value;
    if (!audio) return;
    const url = track?.url ? new URL(track.url, document.baseURI).href : '';
    if (url && url === source) {
      if (autoplay && !requested.value) void play();
      return;
    }
    request += 1;
    requested.value = false;
    source = url;
    pendingSeek = null;
    audio.pause();
    current.value = 0;
    buffered.value = 0;
    nominalDuration.value = track?.duration ?? 0;
    duration.value = nominalDuration.value;
    if (url) audio.src = url;
    else audio.removeAttribute('src');
    audio.load();
    setPhase(url ? 'paused' : 'idle');
    if (autoplay && url) void play();
  }

  function seek(value) {
    const audio = element.value;
    if (!audio || !source || !Number.isFinite(value)) return;
    const position = Math.min(duration.value, Math.max(0, value));
    if (!matches(audio) || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      pendingSeek = position;
      current.value = position;
    } else {
      pendingSeek = null;
      audio.currentTime = position;
      current.value = audio.currentTime;
    }
  }

  function matches(audio) {
    return source && audio.currentSrc === source;
  }

  function syncProgress(audio) {
    if (!matches(audio)) return;
    duration.value = Number.isFinite(audio.duration) ? audio.duration : nominalDuration.value;
    if (pendingSeek !== null) {
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
      const position = pendingSeek;
      seek(position);
    }
    current.value = audio.currentTime;
    buffered.value = 0;
    for (let index = 0; index < audio.buffered.length; index += 1) {
      if (audio.buffered.start(index) > current.value + 0.05) break;
      buffered.value = audio.buffered.end(index);
    }
  }

  const events = {
    playing: ({target}) => {
      if (matches(target) && requested.value && !target.paused) setPhase('playing');
    },
    waiting: ({target}) => {
      if (matches(target) && requested.value && !target.paused) buffer(target);
    },
    pause: ({target}) => {
      if (!matches(target) || !target.paused || target.ended) return;
      if (requested.value) pause();
    },
    ended: ({target}) => {
      if (!matches(target) || !target.ended) return;
      requested.value = false;
      setPhase('paused');
      onEnded();
    },
    error: ({target}) => {
      if (!source || target.src !== source || !target.error) return;
      request += 1;
      requested.value = false;
      setPhase('error');
    },
    timeupdate: ({target}) => syncProgress(target),
    durationchange: ({target}) => syncProgress(target),
    progress: ({target}) => syncProgress(target),
    loadedmetadata: ({target}) => syncProgress(target),
  };

  onMounted(() => {
    const audio = element.value;
    for (const [type, handler] of Object.entries(events)) audio.addEventListener(type, handler);
    applyPreferences();
  });
  onBeforeUnmount(() => {
    const audio = element.value;
    request += 1;
    clearTimeout(bufferingTimer);
    if (!audio) return;
    for (const [type, handler] of Object.entries(events)) audio.removeEventListener(type, handler);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  });

  return {
    phase, requested, playing, failed, current, duration, buffered, volume, adjustableVolume, muted, repeat,
    load, play, pause, seek, setVolume, toggleMute, toggleRepeat,
  };
}
