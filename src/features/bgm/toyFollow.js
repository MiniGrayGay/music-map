import {onBeforeUnmount, shallowRef} from 'vue';

const sdkUrl = 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js';
const sessionKey = 'teyvat-music-toy-follow';
const qualifyingSeconds = 5;
const listensBeforePrompt = 3;
// BetterGI 官网社区页链接的官方 B 站空间。
const betterGiMid = '3546777483479879';
const betterGiName = 'BetterGI';
let sdkRequest;
let authorRequest;
let listeningSession;

function isToyHost() {
  const {hostname, pathname} = location;
  if (/(^|\.)bilibilitoy\.com$/i.test(hostname)) return true;
  return /(^|\.)bilibili\.com$/i.test(hostname)
    && (pathname.startsWith('/toy/') || Boolean(window.__TOY_META__?.toy_id));
}

function supportsDialog() {
  return typeof HTMLDialogElement !== 'undefined' && Boolean(HTMLDialogElement.prototype.showModal);
}

function localPreviewMode() {
  if (import.meta.env.DEV && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
    return new URLSearchParams(location.search).get('toy-follow');
  }
  return null;
}

function localAuthor() {
  return {
    name: betterGiName,
    avatar: 'https://i2.hdslb.com/bfs/face/e671e7fab201dbe86e4ceef22c0342d034191518.jpg',
    followers: 137188,
    openSpace: () => window.open(`https://space.bilibili.com/${betterGiMid}`, '_blank', 'noopener'),
  };
}

export function toyFollowCardPreview() {
  return supportsDialog() && localPreviewMode() === 'preview' ? localAuthor() : null;
}

function loadSdk() {
  if (window.toy) return Promise.resolve(window.toy);
  sdkRequest ??= new Promise((resolve) => {
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
  }).then((sdk) => {
    if (!sdk) sdkRequest = undefined;
    return sdk;
  });
  return sdkRequest;
}

async function loadFollowTarget() {
  const sdk = await loadSdk();
  if (!await sdk?.isSupport?.('navigate') || !await sdk.isSupport('getAuthorRelation')) return null;
  const [profile, relation] = await Promise.all([
    sdk.getAuthorProfile(),
    sdk.getAuthorRelation(),
  ]);
  if (profile?.status !== 'ok' || relation?.status !== 'ok') return null;
  // The SDK only returns the current publisher's nickname and relationship.
  if (profile.data?.nickname?.trim().toLowerCase() !== betterGiName.toLowerCase()) return null;
  const {isAuthor, isFollowing} = relation.data ?? {};
  if (typeof isFollowing !== 'boolean' || typeof isAuthor !== 'boolean') return null;
  return {
    eligible: !isAuthor && !isFollowing,
    name: betterGiName,
    avatar: profile.data.avatar,
    followers: profile.data.follower,
    openSpace: () => sdk.navigate({type: 'space', id: betterGiMid}),
  };
}

export function prepareToyFollow() {
  if (!isToyHost() || !supportsDialog()) return;
  authorRequest ??= new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(null), 4000);
    void loadFollowTarget().catch(() => null).then((result) => {
      window.clearTimeout(timeout);
      resolve(result);
    });
  });
  return authorRequest;
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

function saveSession(session) {
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
  } catch {
    // The count is still available for this page when storage is disabled.
  }
}

export function useToyFollow(preview) {
  const author = shallowRef(null);
  const prompt = shallowRef(null);
  const tracking = shallowRef(false);
  const inToy = !preview && supportsDialog() && isToyHost();
  const localTrigger = import.meta.env.DEV && !preview
    && supportsDialog() && localPreviewMode() === 'trigger';
  const session = localTrigger ? {count: listensBeforePrompt, shown: false}
    : inToy ? (listeningSession ??= restoreSession()) : null;
  let disposed = false;
  let checkOnReturn = false;
  let pendingTarget = null;

  if (localTrigger) {
    author.value = localAuthor();
  } else if (session && !session.shown) {
    pendingTarget = prepareToyFollow().then((result) => {
      pendingTarget = null;
      if (disposed || !result?.eligible || session.shown) return;
      author.value = result;
      tracking.value = true;
    });
  }

  async function refreshAfterProfile() {
    if (!checkOnReturn || document.hidden || !prompt.value) return;
    checkOnReturn = false;
    // Refresh once per space visit, when the player is foregrounded again.
    const result = await loadFollowTarget().catch(() => null);
    if (!disposed && result?.eligible === false) prompt.value = null;
  }

  if (inToy) {
    document.addEventListener('visibilitychange', refreshAfterProfile);
    window.addEventListener('focus', refreshAfterProfile);
    onBeforeUnmount(() => {
      disposed = true;
      document.removeEventListener('visibilitychange', refreshAfterProfile);
      window.removeEventListener('focus', refreshAfterProfile);
    });
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
    if (!author.value || session.shown || session.count < listensBeforePrompt) return true;
    session.shown = true;
    if (inToy) saveSession(session);
    const target = author.value;
    prompt.value = {
      ...target,
      openSpace: async () => {
        checkOnReturn = inToy;
        try {
          await target.openSpace();
        } catch (error) {
          checkOnReturn = false;
          throw error;
        }
      },
    };
    author.value = null;
    tracking.value = false;
    return false;
  }

  function pendingPromptCheck() {
    // Only a restored, completed count needs to wait for the startup relation.
    return session?.count === listensBeforePrompt ? pendingTarget : null;
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
    session.count = Math.min(listensBeforePrompt, session.count + 1);
    if (inToy) saveSession(session);
  }

  return {prompt, tracking, resetTrack, beforePlay, pendingPromptCheck, savePosition, trackProgress};
}
