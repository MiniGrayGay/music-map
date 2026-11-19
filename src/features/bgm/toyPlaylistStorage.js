import {onBeforeUnmount, onMounted, ref} from 'vue';
import {loadToySdk} from './toySdk.js';

const cloudPrefix = 'teyvat_pl1_';
const cloudIndex = /^teyvat_pl1_[0-9a-f]{32}_index$/;
const maxCloudKeys = 128;
const bytesPerPart = 768; // 768 bytes become 1024 Base64 characters.
const writeDelay = 1600;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

function newToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Cloud storage still works when the host disables localStorage.
  }
}

const rowKey = ([kind, id]) => `${kind}:${id}`;

function rows(data) {
  if (!Array.isArray(data)) throw new Error('歌单存档格式无效');
  return data.filter((row) => Array.isArray(row) && row.length === 4 && Number.isSafeInteger(row[2])
    && (row[0] === 'p' && typeof row[1] === 'string' && row[1].length
      || row[0] === 'f' && Number.isSafeInteger(row[1]) && typeof row[3] === 'boolean'));
}

function mergeRows(previous, incoming) {
  for (const row of incoming) {
    const key = rowKey(row);
    if ((previous.get(key)?.[2] ?? -1) <= row[2]) previous.set(key, row);
  }
  return previous;
}

function partKey(indexKey, part) {
  return indexKey.slice(0, -5) + part;
}

function decodeCloud(entries) {
  const devices = new Map();
  for (const key of Object.keys(entries).filter((name) => cloudIndex.test(name)).sort()) {
    const {token, count} = JSON.parse(entries[key]);
    if (!/^[0-9a-f]{32}$/.test(token) || !Number.isInteger(count) || count < 0 || count >= maxCloudKeys) {
      throw new Error('歌单存档索引无效');
    }
    const parts = Array.from({length: count}, (_, part) => entries[partKey(key, part)]);
    if (parts.some((part) => typeof part !== 'string' || !part.length)) throw new Error('歌单存档分片不全');
    const changes = count ? rows(JSON.parse(decoder.decode(Uint8Array.from(atob(parts.join('')), (c) => c.charCodeAt(0))))) : [];
    devices.set(key, {token, count, changes});
  }
  return devices;
}

function encodeCloud(key, token, changes) {
  const bytes = changes.length ? encoder.encode(JSON.stringify(changes)) : new Uint8Array(0);
  const count = Math.ceil(bytes.length / bytesPerPart);
  const entries = {[key]: JSON.stringify({token, count})};
  for (let part = 0; part < count; part++) {
    const chunk = bytes.subarray(part * bytesPerPart, (part + 1) * bytesPerPart);
    entries[partKey(key, part)] = btoa(String.fromCharCode(...chunk));
  }
  return entries;
}

function readPending(key) {
  try {
    return rows(JSON.parse(readLocal(key) || '[]'));
  } catch {
    return [];
  }
}

function withReadDeadline(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('云歌单读取超时')), 8000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Each device writes its own journal so other Toy instances can merge edits.
// The shared storage ID groups the authorized Toys, and Bilibili isolates users.
export function useToyPlaylistStorage({storageId, scope, importKey, apply, legacyLibrary}) {
  const status = ref('loading');
  const deviceKey = `${scope}:device`;
  const savedDevice = readLocal(deviceKey);
  const device = /^[0-9a-f]{32}$/.test(savedDevice) ? savedDevice : newToken();
  writeLocal(deviceKey, device);
  const indexKey = `${cloudPrefix}${device}_index`;
  let sdk;
  let token;
  let clock = 0;
  let devices = new Map();
  let pending = new Map();
  let timer;
  let job;
  let disposed = false;
  let retryDelay = 2000;

  const pendingKey = () => `${scope}:pending:${token}`;
  const cachePending = () => {
    if (token) writeLocal(pendingKey(), JSON.stringify([...pending.values()]));
  };

  function publish() {
    const combined = new Map();
    for (const {changes} of devices.values()) mergeRows(combined, changes);
    for (const row of combined.values()) clock = Math.max(clock, row[2]);
    for (const [key, row] of pending) {
      clock = Math.max(clock, row[2]);
      combined.set(key, row);
    }
    apply([...combined.values()]);
  }

  function arm(delay = writeDelay) {
    clearTimeout(timer);
    if (!disposed && token && pending.size) timer = setTimeout(retry, delay);
  }

  function record(kind, id, value) {
    const row = [kind, id, clock = Math.max(Date.now(), clock + 1), value];
    pending.set(rowKey(row), row);
    cachePending();
    if (token) status.value = 'saving';
    if (!job) arm();
    return Boolean(token);
  }

  async function load() {
    sdk ??= await loadToySdk();
    if (typeof sdk?.getSharedStorage !== 'function' || typeof sdk?.setSharedStorage !== 'function') {
      throw new Error('Toy 共享存档不可用');
    }
    const cloud = await withReadDeadline(sdk.getSharedStorage(storageId));
    return {cloud, history: decodeCloud(cloud)};
  }

  async function synchronize() {
    const {cloud, history} = await load();
    if (disposed) return;
    let owner = history.get(indexKey);
    if (token && owner?.token !== token) {
      // A pending journal may belong to the previous signed-in account.
      token = null;
      pending = new Map();
      apply(null);
    }
    if (!owner) {
      owner = {token: newToken(), count: 0, changes: []};
      if (Object.keys(cloud).length >= maxCloudKeys) throw new Error('云歌单容量已满');
      await sdk.setSharedStorage(storageId, encodeCloud(indexKey, owner.token, []));
      if (disposed) return;
      history.set(indexKey, owner);
    }
    const bindingChanged = token !== owner.token;
    token = owner.token;
    if (bindingChanged) {
      const loaded = mergeRows(new Map(), readPending(pendingKey()));
      pending = mergeRows(loaded, pending.values());
      if (readLocal(importKey) !== '1') {
        if ([...history.values()].every(({changes}) => !changes.length)) {
          const {playlists, favorites} = legacyLibrary();
          for (const list of playlists) {
            if (!pending.has(rowKey(['p', list.id]))) record('p', list.id, list);
          }
          for (const id of favorites) {
            if (!pending.has(rowKey(['f', id]))) record('f', id, true);
          }
        }
        writeLocal(importKey, '1');
      }
    }
    devices = history;
    publish();
    if (!pending.size) return;

    const sending = new Map(pending);
    const journal = mergeRows(new Map(), owner.changes);
    // Stamp actual writes after observing the latest clock, even when edits
    // were made offline or another tab wrote while this page was open.
    for (const [key, row] of sending) journal.set(key, [row[0], row[1], ++clock, row[3]]);
    const changes = [...journal.values()];
    const batch = encodeCloud(indexKey, token, changes);
    if (Object.keys({...cloud, ...batch}).length > maxCloudKeys) throw new Error('云歌单容量已满');
    await sdk.setSharedStorage(storageId, batch);
    const count = Object.keys(batch).length - 1;
    history.set(indexKey, {token, count, changes});
    for (const [key, row] of sending) {
      if (pending.get(key) === row) pending.delete(key);
    }
    cachePending();
    if (!disposed) publish();
  }

  function retry() {
    if (disposed || job) return;
    clearTimeout(timer);
    status.value = token ? 'saving' : 'loading';
    const lock = `${scope}:cloud-write:${device}`;
    const task = navigator.locks ? navigator.locks.request(lock, synchronize) : synchronize();
    job = task.then(() => {
      retryDelay = 2000;
      if (!disposed) status.value = pending.size ? 'saving' : 'ready';
    }, (error) => {
      if (disposed) return;
      status.value = pending.size && token ? 'failed' : 'local';
      if (pending.size && error?.code === 307044) {
        arm(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      }
    }).finally(() => {
      job = null;
      if (status.value === 'saving' && pending.size) arm();
    });
  }

  function onVisibility() {
    if (document.hidden && token && pending.size) retry();
  }
  onMounted(() => {
    retry();
    document.addEventListener('visibilitychange', onVisibility);
  });
  onBeforeUnmount(() => {
    cachePending();
    disposed = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  });
  return {status, record, retry};
}
