import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import overseasIndex from './overseas-ost.json' with {type: 'json'};

const settingsKey = 'teyvat-bgm-playback';

// 浏览器直连两条音源：网易云官方公开外链 + 海外静态 CDN。两者都由本模块直接拼 URL，
// 不经任何服务端代取音频；生产域仅向 API 查一次地区主备顺序（route=order 返回 JSON）。
const neteaseApiFallbackBase = 'https://music-map-azure.vercel.app/api/netease-audio';
const neteaseApiFallbackHost = new URL(neteaseApiFallbackBase).hostname;
// 逻辑主 URL 为网易云固定公开外链的曲目才参与主备；其他音源没有备路。
const neteaseOuterUrlPattern = /^https:\/\/music\.163\.com\/song\/media\/outer\/url\?id=\d+\.mp3$/;
// 生产域（API 同域部署）才做地区顺序查询；静态分发/本地/Toy 一律网易云优先，不做查询。
const isProductionSite = typeof window !== 'undefined' && window.location.hostname === neteaseApiFallbackHost;

// 海外静态 CDN：索引值必须是「正数版本目录/uuid/aac256.m4a」，与 api/netease-audio.js 同一校验，坏条目忽略。
const overseasCdnBase = 'https://assets.kuutar.moe/soundtracks/';
const overseasPathPattern = /^\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/aac256\.m4a$/i;
const overseasPaths = new Map(
  Object.entries(overseasIndex ?? {}).flatMap(([id, path]) =>
    typeof path === 'string' && overseasPathPattern.test(path) && /^\d+$/.test(id) ? [[id, path]] : [],
  ),
);

function overseasCdnUrl(id) {
  const path = overseasPaths.get(String(id));
  return path ? `${overseasCdnBase}${path}` : null;
}

// 地区主备顺序：每页至多一次懒加载，短超时/任何失败都默认网易云顺序，promise 全页缓存。
// regionOrderValue 只在共享 promise resolve 后赋值；未知（null）且需要排序时异步等待。
// 绝不用浏览器语言推断国家；地区判断只在 API 内按既有 Vercel 地区头完成。
let regionOrderValue = null;
let regionOrderPromise = null;
function regionOrder() {
  if (!isProductionSite) return Promise.resolve(regionOrderValue);
  if (!regionOrderPromise) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    regionOrderPromise = fetch(`${neteaseApiFallbackBase}?route=order`, {signal: controller.signal})
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`http-${res.status}`))))
      .then((data) => (data && data.primary === 'overseas' ? 'overseas' : 'netease'))
      .catch(() => 'netease')
      .finally(() => clearTimeout(timer));
  }
  return regionOrderPromise;
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

export function useMusicPlayback({track, zone, preview, advance, systemVolume, toyFollow}) {
  const initial = readSettings(preview);
  const audio = ref(null);
  const volume = ref(initial.volume);
  const muted = ref(initial.muted);
  const repeatMode = ref(initial.repeatMode);
  const nativeLoop = computed(() => repeatMode.value === 'one' && !toyFollow.tracking.value);
  const elapsed = ref(0);
  const mediaDuration = ref(0);
  const duration = computed(() => mediaDuration.value || track.value?.duration || 0);
  const failure = ref('');
  const requested = ref(!preview);
  const playing = ref(false);
  const pending = ref(false);
  const canPause = computed(() => requested.value && (playing.value || pending.value));

  let activeUrl = null;
  // 本次加载的两条直连音源（固定数组，按主备顺序）；region/编码确定后一次性绑定。
  // 空数组 = 尚未绑定或该曲无可播链接，此时 play() 只记 requested，不动媒体。
  let activeSources = [];
  // 主备游标：0=主路，1=备路（有海外映射才有备路）。切曲/切区重置；手动重试回第 0 项；
  // 备路也失败即最终通知，不循环，也不加第三路。
  let fallbackStage = 0;
  // 每次新加载递增：所有异步回调（地区排序/兜底/启动）只在 generation、当前节点、
  // 当前曲目 URL 与分区 key 全部一致时才能接上新媒体，过时结果一律丢弃。
  let loadGeneration = 0;
  // 编码支持探测：仅 canPlayType，不做任何 UA/语言推断；会话内缓存一次。
  let codecPrefCache = '';
  function codecPreference() {
    if (codecPrefCache) return codecPrefCache;
    const node = audio.value;
    if (!node || typeof node.canPlayType !== 'function') return '';
    const aac = node.canPlayType('audio/mp4; codecs="mp4a.40.2"');
    const mp3 = node.canPlayType('audio/mpeg');
    codecPrefCache = !aac && mp3 ? 'mp3-only' : 'default';
    return codecPrefCache;
  }
  // 把当前曲目的直连音源按给定地区顺序绑定成固定数组（一次性，同步完成）。
  // 非网易云外链曲目只有自身单源。
  function bindSourcesForCurrentLoad(order) {
    const source = track.value?.url;
    const neteaseId = track.value?.neteaseId;
    // 只有逻辑主 URL 是网易云固定公开外链的曲目才参与主备。
    if (!neteaseId || !neteaseOuterUrlPattern.test(source ?? '')) {
      activeSources = source ? [source] : [];
      return;
    }
    const overseas = overseasCdnUrl(neteaseId);
    // AAC 明确不支持且 MP3 可播的端跳过海外 AAC 源为主路，只翻转两条顺序，不加第三路。
    const neteaseFirst = !overseas || codecPreference() === 'mp3-only' || order !== 'overseas';
    activeSources = neteaseFirst ? [source, overseas].filter(Boolean) : [overseas, source];
  }
  let playRequest = 0;
  let requestStartedAt = Number.NaN;
  let session;
  const sessionActions = {
    play: () => play(),
    pause: () => pause(),
    previoustrack: () => { if (!toyFollow.prompt.value) advance(-1); },
    nexttrack: () => { if (!toyFollow.prompt.value) advance(1); },
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
    toyFollow.trackProgress(node);
    mediaDuration.value = Number.isFinite(node.duration) ? node.duration : 0;
    elapsed.value = node.currentTime;
  }

  async function start(node) {
    const attempt = ++playRequest;
    const followCheck = toyFollow.pendingPromptCheck();
    if (followCheck) {
      pending.value = true;
      await followCheck;
      if (attempt !== playRequest || !requested.value) return;
    }
    if (!toyFollow.beforePlay()) {
      pause();
      return;
    }
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
    toyFollow.savePosition(event.currentTarget);
    playing.value = true;
    pending.value = false;
    failure.value = '';
  }

  function onPause(event) {
    const node = event.currentTarget;
    if (node.paused) {
      toyFollow.trackProgress(node, true);
      playing.value = false;
    }
  }

  function onSeeking(event) {
    toyFollow.savePosition(event.currentTarget);
  }

  function onError(event) {
    const node = event.currentTarget;
    if (!node.error) return;
    // 只处理当前 audio 节点与当前选曲的错误：不用 raw/currentSrc 比较（浏览器可能已重定向
    // 或旧节点同 URL），以「节点与曲目仍一致 + 固定数组的下一项存在」判定可兜底。
    if (node !== audio.value || activeUrl !== track.value?.url || !activeSources[fallbackStage]) return;
    const nextUrl = activeSources[fallbackStage + 1] ?? null;
    if (nextUrl) {
      fallbackStage += 1;
      playRequest += 1;
      playing.value = false;
      pending.value = false;
      recordAudioFailure({
        kind: 'HTMLMediaElement 错误（转备路源）',
        detail: `MediaError code=${node.error.code}${node.error.message ? ` message="${node.error.message}"` : ''}`,
        zone, track, node, requestStartedAt,
      });
      requestStartedAt = performance.now();
      node.src = nextUrl;
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
    if (toyFollow.prompt.value) return;
    requested.value = true;
    const node = audio.value;
    // activeSources 还没有当前有效链接（地区排序等待中/无源曲目）时只记 requested，
    // 不动媒体；绑定完成后由绑定处按 requested 决定是否 start。
    if (!node || !activeSources.length) return;
    if (node.error) {
      elapsed.value = 0;
      mediaDuration.value = 0;
      // 手动重播视为新尝试：回固定数组第 0 项重走完整主备链路。
      if (fallbackStage > 0) {
        fallbackStage = 0;
        node.src = activeSources[0];
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
    toyFollow.savePosition(node);
    elapsed.value = node.currentTime;
  }

  function onEnded(event) {
    const node = event.currentTarget;
    if (!node.ended) return;
    toyFollow.trackProgress(node, true);
    playing.value = false;
    pending.value = false;
    if (!requested.value) return;
    toyFollow.resetTrack();
    if (repeatMode.value === 'all' && advance(1, true)) return;
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
    toyFollow.resetTrack();
    if (newZone) requested.value = !preview;

    // 曲目或分区切换时重置主备游标；同曲节点重建沿用当前游标，不回退到已失效源。
    const trackChanged = previous[1] !== url;
    if (trackChanged || newZone) fallbackStage = 0;

    // 开始新加载：更新 activeUrl、清空 activeSources、暂停旧节点并递增 generation，
    // 使旧的异步回调（排序/兜底/启动）全部失效，不会覆盖本次加载。
    loadGeneration += 1;
    const gen = loadGeneration;
    const zoneKey = zone.value.key;
    activeUrl = url;
    activeSources = [];
    playRequest += 1;
    elapsed.value = 0;
    mediaDuration.value = 0;
    playing.value = false;
    pending.value = false;
    failure.value = '';
    node.pause();
    applySettings(node);

    const neteaseId = track.value?.neteaseId;
    const overseasUrl = overseasCdnUrl(neteaseId ?? '');
    const needsOrder = isProductionSite
      && !!neteaseId
      && neteaseOuterUrlPattern.test(url ?? '')
      && !!overseasUrl
      && codecPreference() !== 'mp3-only'
      && regionOrderValue === null;

    // 绑定主备并接上媒体。所有异步完成只在 generation/节点/URL/分区 key 一致时生效；
    // 暂停期间也可接上新 src，但仅 requested 才 start。
    function bindSources(order) {
      if (gen !== loadGeneration || audio.value !== node || track.value?.url !== url || zone.value.key !== zoneKey) return;
      bindSourcesForCurrentLoad(order);
      const stageSrc = activeSources[fallbackStage] ?? null;
      requestStartedAt = stageSrc ? performance.now() : Number.NaN;
      if (stageSrc) {
        node.src = stageSrc;
      } else {
        node.removeAttribute('src');
      }
      node.load();
      if (stageSrc && requested.value) void start(node);
    }

    if (needsOrder) {
      // 地区顺序未知：先摘除旧 src，等共享一次的短超时 regionOrder promise 后绑定排序结果。
      // 查询失败/超时默认网易云顺序；共享值 resolve 后才赋 regionOrderValue，后续加载同步绑定。
      node.removeAttribute('src');
      node.load();
      void regionOrder().then((order) => {
        if (regionOrderValue === null) regionOrderValue = order;
        bindSources(regionOrderValue);
      });
    } else {
      // 地区已知（或静态/本地/Toy、无海外映射、明确 MP3 优先）：同步赋 src，保留原启动手势。
      bindSources(regionOrderValue ?? 'netease');
    }
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
      loadGeneration += 1;
      activeUrl = null;
      activeSources = [];
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
    audio, volume, muted, repeatMode, nativeLoop, toggleRepeat, elapsed, duration, mediaDuration, failure, canPause,
    copyFailureReport,
    play, pause, seek, readPosition, onPause, onPlaying, onSeeking, onEnded, onError,
  };
}
