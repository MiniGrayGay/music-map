import {computed, onBeforeUnmount, onMounted, ref} from 'vue';

const storageKey = 'teyvat-bgm-playback';

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
  const playing = computed(() => requested.value && !['blocked', 'error'].includes(phase.value));

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
    phase.value = source ? 'paused' : 'idle';
  }

  async function play() {
    const audio = element.value;
    if (!audio || !source) return;
    if (phase.value === 'error') {
      if (current.value > 0) pendingSeek = current.value;
      audio.load();
    }
    if (audio.ended) audio.currentTime = 0;
    const activeRequest = ++request;
    requested.value = true;
    phase.value = audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ? 'buffering' : 'playing';
    try {
      await audio.play();
    } catch (error) {
      if (activeRequest !== request) return;
      requested.value = false;
      if (error?.name === 'NotAllowedError') phase.value = 'blocked';
      else if (error?.name === 'AbortError') phase.value = 'paused';
      else phase.value = 'error';
    }
  }

  function load(track, {autoplay = requested.value} = {}) {
    const audio = element.value;
    if (!audio) return;
    const url = track?.url ? new URL(track.url, document.baseURI).href : '';
    if (url && url === source) {
      if (autoplay && !playing.value) void play();
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
    phase.value = url ? 'paused' : 'idle';
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
      if (matches(target) && requested.value && !target.paused) phase.value = 'playing';
    },
    waiting: ({target}) => {
      if (matches(target) && requested.value && !target.paused) phase.value = 'buffering';
    },
    pause: ({target}) => {
      if (!matches(target) || !target.paused || target.ended) return;
      if (playing.value) pause();
    },
    ended: ({target}) => {
      if (!matches(target) || !target.ended) return;
      requested.value = false;
      phase.value = 'paused';
      onEnded();
    },
    error: ({target}) => {
      if (!source || target.src !== source || !target.error) return;
      request += 1;
      requested.value = false;
      phase.value = 'error';
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
    if (!audio) return;
    for (const [type, handler] of Object.entries(events)) audio.removeEventListener(type, handler);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  });

  return {
    phase, requested, playing, current, duration, buffered, volume, adjustableVolume, muted, repeat,
    load, play, pause, seek, setVolume, toggleMute, toggleRepeat,
  };
}
