import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';

const settingsKey = 'teyvat-bgm-playback';

// 网易云固定公开外链（逻辑主 URL）与 API 分流地址：API 只按 id 与 route 决定 307 目标，
// 交给浏览器直连官方/海外 CDN，本函数绝不接触音频字节。
const neteaseApiFallbackBase = 'https://music-map-azure.vercel.app/api/netease-audio';
const neteaseApiFallbackHost = new URL(neteaseApiFallbackBase).hostname;
// 逻辑主 URL 为网易云固定公开外链的曲目才参与分流与备路；其他音源没有备路。
const neteaseOuterUrlPattern = /^https:\/\/music\.163\.com\/song\/media\/outer\/url\?id=\d+\.mp3$/;
// 生产域（API 同域部署）：初始用 route=primary 按地区分流，初始源错误换 route=alternate 一次。
// 静态分发/本地：仍网易云公开外链优先，失败时用无 route 的 API（服务端有海外映射则走海外源）。
const isProductionSite = typeof window !== 'undefined' && window.location.hostname === neteaseApiFallbackHost;

function neteaseApiFallbackUrl(id, route = '') {
  return route ? `${neteaseApiFallbackBase}?id=${id}&route=${route}` : `${neteaseApiFallbackBase}?id=${id}`;
}

// 页面会话内的音频失败诊断：模块级数组跨曲目、跨播放器实例保留，仅驻内存，不上报不持久化。
// 每次实际失败事件逐条记录，不合并去重；禁止记录签名、凭证或原始查询串。
const failureDiagnostics = [];

// 只保留音源域名；除网易云固定公开外链路径外不保留任何路径，避免复制 CDN 签名或凭证。
function describeAudioSource(url) {
  try {
    const parsed = new URL(url, window.location.href);
    return describeAudioOrigin(parsed);
  } catch {
    return '(无法解析的音源地址)';
  }
}

function describeAudioOrigin(parsed) {
  const isNetEaseOuter = parsed.origin === 'https://music.163.com' && parsed.pathname === '/song/media/outer/url';
  return isNetEaseOuter ? `${parsed.origin}${parsed.pathname}` : parsed.origin;
}

// 错误消息里内嵌完整 URL 时，替换为仅域名（或网易云固定公开外链路径），去掉签名等查询参数。
function sanitizeDetailText(text) {
  if (!text) return text;
  return text.replace(/https?:\/\/[^\s"']+/gi, (match) => {
    try {
      return describeAudioOrigin(new URL(match));
    } catch {
      return '(音源地址)';
    }
  });
}

function formatDuration(ms) {
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms)}ms` : '';
}

// 从 Resource Timing 中找本次 load 开始到失败时刻之间、与媒体 URL 完全一致的请求记录。
// 查找用完整绝对 URL（getEntriesByName 需要精确匹配），展示仍走脱敏后的 describeAudioSource。
function describeRequestTiming(node, requestStartedAt) {
  const rawUrl = node.currentSrc || node.src || '';
  if (!rawUrl || typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') {
    return '(无可见请求记录)';
  }
  const now = typeof performance.now === 'function' ? performance.now() : Number.POSITIVE_INFINITY;
  let entries = [];
  try {
    entries = performance.getEntriesByName(rawUrl, 'resource') ?? [];
  } catch {
    return '(无可见请求记录)';
  }
  // 只取本次 load 开始之后发出的请求，避免拿旧请求冒充本次失败。
  const entry = entries
    .filter((item) => (!Number.isFinite(requestStartedAt) || item.startTime >= requestStartedAt) && item.startTime <= now)
    .sort((a, b) => b.startTime - a.startTime)[0];
  if (!entry) return '(本次失败期间找不到可见请求记录，HTTP 状态未暴露)';

  const parts = [];
  // responseStatus 仅在浏览器暴露时 >0 才是真实 HTTP 码；0 表示受限不可读，绝不当状态码展示。
  if (entry.responseStatus > 0) parts.push(`HTTP ${entry.responseStatus}`);
  else parts.push('HTTP 状态未暴露');
  if (Number.isFinite(entry.duration)) parts.push(`总耗时 ${formatDuration(entry.duration)}`);
  if (entry.redirectStart > 0 && entry.redirectEnd > 0) {
    parts.push(`重定向 ${formatDuration(entry.redirectEnd - entry.redirectStart)}`);
  }
  if (entry.requestStart > 0 && entry.responseStart > 0) {
    parts.push(`响应等待 ${formatDuration(entry.responseStart - entry.requestStart)}`);
  }
  return parts.join('，');
}

function recordAudioFailure({kind, detail, zone, track, node, requestStartedAt}) {
  failureDiagnostics.push({
    time: new Date().toISOString(),
    kind,
    detail: sanitizeDetailText(detail),
    scene: zone.value?.name ?? '(未知区域)',
    zoneKey: zone.value?.key ?? '',
    trackName: track.value?.displayName ?? '(未知曲目)',
    neteaseId: track.value?.neteaseId ?? '',
    source: describeAudioSource(node.currentSrc || node.src || ''),
    request: describeRequestTiming(node, requestStartedAt),
    online: typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? (navigator.onLine ? '在线' : '离线') : '',
    networkState: node.networkState,
    readyState: node.readyState,
  });
}

function formatFailureDiagnostics() {
  if (!failureDiagnostics.length) return '';
  const lines = [`音频播放失败诊断，共 ${failureDiagnostics.length} 条记录`];
  if (typeof navigator !== 'undefined' && navigator.userAgent) lines.push(`浏览器 UA：${navigator.userAgent}`);
  failureDiagnostics.forEach((entry, index) => {
    lines.push(
      `[${index + 1}] ${entry.time} ${entry.kind}`,
      `  场景：${entry.scene}（区域 ${entry.zoneKey || '无'}），曲目：${entry.trackName}${entry.neteaseId ? `（公开 NetEase id ${entry.neteaseId}）` : ''}`,
      `  音源：${entry.source}`,
      `  媒体请求：${entry.request}${entry.online ? `，网络 ${entry.online}` : ''}`,
      `  networkState=${entry.networkState} readyState=${entry.readyState}`,
      `  ${entry.detail}`,
    );
  });
  return lines.join('\n');
}

async function copyFailureReport() {
  const text = formatFailureDiagnostics();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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
  // 兜底链路单一游标：0=主路，1=备路。生产域主路=API route=primary（原外链仍是逻辑主 URL），
  // 备路=route=alternate；静态/本地主路=网易云公开外链，备路=无 route API（有映射时服务端转海外源）。
  // 切曲/切区由主 watch 重置；同曲节点重建沿用当前游标，不回退到已失效源。
  // 手动重播时清零，重走完整链路；游标到头即最终失败，不循环。
  const maxFallbackStage = 1;
  let fallbackStage = 0;
  function sourceUrlForStage(stage) {
    const source = track.value?.url;
    const neteaseId = track.value?.neteaseId;
    // 只有逻辑主 URL 是网易云固定公开外链的曲目才参与分流与备路。
    if (!neteaseId || !neteaseOuterUrlPattern.test(source ?? '')) return null;
    if (isProductionSite) return neteaseApiFallbackUrl(neteaseId, stage === 0 ? 'primary' : 'alternate');
    return stage === 0 ? source : neteaseApiFallbackUrl(neteaseId);
  }
  let playRequest = 0;
  let requestStartedAt = Number.NaN;
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
      // 媒体错误已由/将由 onError 记诊断并提示（或转兜底），避免 play() 拒绝早于
      // error 事件时先闪一次通知。
      if (node.error) return;
      pending.value = false;
      if (error.name === 'NotAllowedError') failure.value = '请点击播放按钮开始播放';
      else failure.value = '音频播放失败';
      recordAudioFailure({
        kind: 'play() 被拒绝',
        detail: `${error.name}: ${error.message || '(无消息)'}`,
        zone, track, node, requestStartedAt,
      });
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
    const node = event.currentTarget;
    if (!activeUrl || !node.error) return;
    // 首次失败换备路源重试一次；只记诊断不弹通知，最终失败才提示。用户已暂停时不自动续播。
    if (fallbackStage < maxFallbackStage && sourceUrlForStage(fallbackStage + 1)) {
      fallbackStage += 1;
      playRequest += 1;
      playing.value = false;
      pending.value = false;
      recordAudioFailure({
        kind: 'HTMLMediaElement 错误（首次，转备路源）',
        detail: `MediaError code=${node.error.code}${node.error.message ? ` message="${node.error.message}"` : ''}`,
        zone, track, node, requestStartedAt,
      });
      requestStartedAt = performance.now();
      node.src = sourceUrlForStage(fallbackStage);
      node.load();
      if (requested.value) void start(node);
      return;
    }
    playRequest += 1;
    playing.value = false;
    pending.value = false;
    failure.value = '音源读取失败';
    recordAudioFailure({
      kind: 'HTMLMediaElement 错误',
      detail: `MediaError code=${node.error.code}${node.error.message ? ` message="${node.error.message}"` : ''}`,
      zone, track, node, requestStartedAt,
    });
  }

  function play() {
    requested.value = true;
    const node = audio.value;
    if (!node || !activeUrl) return;
    if (node.error) {
      elapsed.value = 0;
      mediaDuration.value = 0;
      // 手动重播视为新尝试：若此前兜底失败，回主路 URL 重走完整链路。
      if (fallbackStage > 0) {
        fallbackStage = 0;
        node.src = sourceUrlForStage(0) ?? activeUrl;
      }
      requestStartedAt = performance.now();
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

    // 曲目或分区切换时重置兜底游标；同曲同区仅节点重建时沿用当前备路源，
    // 避免回退到已失效的主路 URL。
    const trackChanged = previous[1] !== url;
    if (trackChanged || newZone) fallbackStage = 0;
    // 生产域首播主路即 API route=primary；静态/本地首播主路仍是网易云外链（逻辑主 URL）。
    const effectiveUrl = !trackChanged && !newZone && fallbackStage > 0
      ? (sourceUrlForStage(fallbackStage) ?? url)
      : (isProductionSite ? (sourceUrlForStage(0) ?? url) : url);

    playRequest += 1;
    elapsed.value = 0;
    mediaDuration.value = 0;
    playing.value = false;
    pending.value = false;
    failure.value = '';
    activeUrl = url;
    node.pause();
    applySettings(node);
    if (effectiveUrl) {
      requestStartedAt = performance.now();
      node.src = effectiveUrl;
    } else {
      node.removeAttribute('src');
      requestStartedAt = Number.NaN;
    }
    node.load();
    if (effectiveUrl && requested.value) void start(node);
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
    copyFailureReport,
    play, pause, seek, readPosition, onPause, onPlaying, onEnded, onError,
  };
}
