import {shallowRef} from 'vue';

const sdkUrl = 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js';
const sessionKey = 'teyvat-music-toy-follow';
const qualifyingSeconds = 5;
const listensBeforePrompt = 3;
// BetterGI 官网社区页链接的官方 B 站空间。
const betterGiMid = '3546777483479879';
let authorRequest;
let listeningSession;

function loadSdk() {
  if (window.toy) return Promise.resolve(window.toy);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = sdkUrl;
    function finish(sdk) {
      window.clearTimeout(timeout);
      script.onload = script.onerror = null;
      if (!sdk) script.remove();
      resolve(sdk);
    }
    const timeout = window.setTimeout(() => finish(null), 4000);
    script.onload = () => finish(window.toy ?? null);
    script.onerror = () => finish(null);
    document.head.append(script);
  });
}

async function loadFollowTarget() {
  const sdk = await loadSdk();
  if (!sdk?.navigate) return null;
  const [profile, canNavigate] = await Promise.all([
    Promise.resolve().then(() => sdk.getAuthorProfile?.()).catch(() => null),
    sdk.isSupport?.('navigate'),
  ]);
  if (canNavigate === false) return null;
  const data = profile?.status === 'ok' ? profile.data : null;
  let avatar = '';
  // The SDK only resolves the relationship to the current Toy publisher.
  if (String(data?.mid ?? '') === betterGiMid) {
    const relation = await Promise.resolve().then(() => sdk.getAuthorRelation?.()).catch(() => null);
    if (relation?.status === 'ok' && (relation.data?.isFollowing === true || relation.data?.isAuthor === true)) return null;
    avatar = data.avatar || data.face || '';
  }
  return {
    name: 'BetterGI',
    avatar,
    openSpace: () => sdk.navigate({type: 'space', id: betterGiMid}),
  };
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey));
    const count = Number.isInteger(saved?.count) ? Math.max(0, Math.min(listensBeforePrompt, saved.count)) : 0;
    return {count, shown: saved?.shown === true};
  } catch {
    return {count: 0, shown: false};
  }
}

function saveSession() {
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify(listeningSession));
  } catch {
    // The count is still available for this page when storage is disabled.
  }
}

export function useToyFollow(preview) {
  const author = shallowRef(null);
  const prompt = shallowRef(null);
  const tracking = shallowRef(false);
  if (!preview && /(^|\.)(bilibili|bilibilitoy)\.com$/i.test(location.hostname)
    && typeof HTMLDialogElement !== 'undefined' && HTMLDialogElement.prototype.showModal) {
    listeningSession ??= restoreSession();
    if (!listeningSession.shown) {
      tracking.value = true;
      authorRequest ??= loadFollowTarget().catch(() => null);
      void authorRequest.then((result) => {
        author.value = listeningSession.shown ? null : result;
        tracking.value = author.value !== null;
      });
    }
  }

  let started = false;
  let counted = false;
  let seconds = 0;
  let previous = null;

  function resetTrack() {
    started = counted = false;
    seconds = 0;
    previous = null;
  }

  function beforePlay() {
    if (prompt.value) return false;
    if (started) return true;
    started = true;
    if (!author.value || listeningSession.shown || listeningSession.count < listensBeforePrompt) return true;
    listeningSession.shown = true;
    saveSession();
    prompt.value = author.value;
    author.value = null;
    tracking.value = false;
    return false;
  }

  function savePosition(node) {
    previous = tracking.value ? {position: node.currentTime, clock: performance.now()} : null;
  }

  function trackProgress(node, finalUpdate = false) {
    if (!tracking.value || counted || !started) return;
    if (node.seeking || (!finalUpdate && node.paused)) {
      previous = null;
      return;
    }
    const last = previous;
    savePosition(node);
    if (!last) return;
    const mediaSeconds = (previous.position - last.position) / node.playbackRate;
    const wallSeconds = (previous.clock - last.clock) / 1000;
    seconds += Math.max(0, Math.min(mediaSeconds, wallSeconds));
    if (seconds < qualifyingSeconds) return;
    counted = true;
    listeningSession.count = Math.min(listensBeforePrompt, listeningSession.count + 1);
    saveSession();
  }

  return {prompt, tracking, resetTrack, beforePlay, savePosition, trackProgress};
}
