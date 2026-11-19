import {onBeforeUnmount, shallowRef} from 'vue';
import {isToyHost, loadToySdk} from './toySdk.js';

const sessionKey = 'teyvat-music-toy-follow';
const qualifyingSeconds = 5;
const listensBeforePrompt = 3;
// BetterGI 官网社区页链接的官方 B 站空间。
const betterGiMid = '3546777483479879';
const betterGiName = 'BetterGI';
const betterGiSpace = `https://space.bilibili.com/${betterGiMid}`;
let authorRequest;
let listeningSession;

function supportsDialog() {
  return typeof HTMLDialogElement !== 'undefined' && Boolean(HTMLDialogElement.prototype.showModal);
}

function localPreviewMode() {
  if (import.meta.env.DEV && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
    return new URLSearchParams(location.search).get('toy-follow');
  }
  return null;
}

function webAuthor() {
  return {
    name: betterGiName,
    avatar: 'https://i2.hdslb.com/bfs/face/e671e7fab201dbe86e4ceef22c0342d034191518.jpg',
    href: betterGiSpace,
  };
}

export function toyFollowCardPreview() {
  return supportsDialog() && localPreviewMode() === 'preview' ? webAuthor() : null;
}

async function loadFollowTarget() {
  const sdk = await loadToySdk();
  if (!sdk) return null;
  const supported = await Promise.all(
    ['navigate', 'getAuthorProfile', 'getAuthorRelation'].map((method) => sdk.isSupport?.(method)),
  );
  if (!supported.every(Boolean)) return null;
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
  const enabled = !preview && supportsDialog();
  const inToy = enabled && isToyHost();
  const localTrigger = enabled && localPreviewMode() === 'trigger';
  const session = localTrigger ? {count: listensBeforePrompt, shown: false}
    : enabled ? (listeningSession ??= restoreSession()) : null;
  let disposed = false;
  let checkOnReturn = false;
  let pendingTarget = null;

  if (localTrigger) {
    author.value = webAuthor();
  } else if (session && !session.shown && inToy) {
    pendingTarget = prepareToyFollow().then((result) => {
      pendingTarget = null;
      if (disposed || !result?.eligible || session.shown) return;
      author.value = result;
      tracking.value = true;
    });
  } else if (session && !session.shown) {
    author.value = webAuthor();
    tracking.value = true;
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
    if (!localTrigger) saveSession(session);
    const target = author.value;
    prompt.value = inToy ? {
      ...target,
      openSpace: async () => {
        checkOnReturn = true;
        try {
          const result = await target.openSpace();
          if (result?.status && result.status !== 'ok') throw new Error('打开 UP 主空间失败');
        } catch (error) {
          checkOnReturn = false;
          throw error;
        }
      },
    } : target;
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
    if (!localTrigger) saveSession(session);
  }

  return {prompt, tracking, resetTrack, beforePlay, pendingPromptCheck, savePosition, trackProgress};
}
