import {ref} from 'vue';
import catalog from './netease-tracks.json' with {type: 'json'};
import {neteaseTrack} from './regionalPlaylist.js';
import {isToyHost, isToySharedStorageId} from './toySdk.js';
import {useToyPlaylistStorage} from './toyPlaylistStorage.js';

const storageKey = 'teyvat-playlists-v1';
const trackNameOrder = new Intl.Collator('zh-Hans-CN-u-co-pinyin', {
  numeric: true,
  sensitivity: 'base',
});
const tracksById = new Map();
for (const id of Object.keys(catalog.tracks)) {
  const track = neteaseTrack(Number(id));
  if (track && !tracksById.has(track.neteaseId)) tracksById.set(track.neteaseId, track);
}

function compareTracks(left, right) {
  return trackNameOrder.compare(left.displayName, right.displayName)
    || left.neteaseId - right.neteaseId;
}

export const playlistTracks = [...tracksById.values()].sort(compareTracks);

export function tracksForPlaylist(ids) {
  return ids.map((id) => tracksById.get(id)).filter(Boolean).sort(compareTracks);
}

function validTracks(ids) {
  return Array.isArray(ids) ? [...new Set(ids.filter((id) => tracksById.has(id)))] : [];
}

function normalizeLibrary(saved) {
  const playlists = Array.isArray(saved?.playlists) ? saved.playlists : [];
  const byId = new Map();
  for (const list of playlists) {
    if (typeof list?.id !== 'string' || !list.id || typeof list.name !== 'string'
        || !list.name.trim()) continue;
    byId.set(list.id, {
      id: list.id,
      name: list.name.trim().slice(0, 40),
      trackIds: validTracks(list.trackIds),
    });
  }
  return {playlists: [...byId.values()], favorites: validTracks(saved?.favorites)};
}

function readLibrary(key, fallback, imported) {
  try {
    const legacy = fallback && localStorage.getItem(imported) !== '1' ? localStorage.getItem(fallback) : null;
    const saved = localStorage.getItem(key) ?? legacy;
    return normalizeLibrary(JSON.parse(saved));
  } catch {
    return {playlists: [], favorites: []};
  }
}

export function usePlaylistLibrary() {
  const inToy = isToyHost();
  const toyScope = inToy
    ? String(window.__TOY_META__?.toy_id ?? location.pathname.replace(/index\.html$/i, ''))
    : '';
  const scope = `${storageKey}:toy:${toyScope}`;
  const storageId = import.meta.env.VITE_TOY_SHARED_STORAGE_ID;
  const sharedScope = `${storageKey}:shared:${storageId}`;
  // The old browser key was shared by all Toys on this origin, so it can
  // only be imported once even if the browser later changes Toy or account.
  const importKey = `${storageKey}:shared-legacy-migrated`;
  const localKey = inToy ? `${scope}:local` : storageKey;
  const readGuest = () => readLibrary(localKey, inToy ? storageKey : null, importKey);
  const initial = readGuest();
  const playlists = ref(initial.playlists);
  const favorites = ref(initial.favorites);
  const storageFailed = ref(false);
  const cloud = inToy && isToySharedStorageId(storageId)
    ? useToyPlaylistStorage({storageId, scope: sharedScope, importKey, apply: applyCloud, legacyLibrary: readGuest})
    : null;
  const syncStatus = cloud?.status ?? ref(null);
  const sameItems = (first, second) => first.length === second.length
    && first.every((item, index) => item === second[index]);

  function applyCloud(changes) {
    const value = changes ? normalizeLibrary({
      playlists: changes.filter(([kind, , , list]) => kind === 'p' && list).map((row) => row[3]),
      favorites: changes.filter(([kind, , , present]) => kind === 'f' && present).map((row) => row[1]),
    }) : readGuest();
    const local = new Map(playlists.value.map((list) => [list.id, list]));
    const next = value.playlists.map((list) => {
      const existing = local.get(list.id);
      return existing?.name === list.name && sameItems(existing.trackIds, list.trackIds) ? existing : list;
    });
    if (!sameItems(playlists.value, next)) playlists.value = next;
    if (!sameItems(favorites.value, value.favorites)) favorites.value = value.favorites;
    storageFailed.value = false;
  }

  function persist(kind, id, value) {
    if (cloud?.record(kind, id, value)) return;
    try {
      localStorage.setItem(localKey, JSON.stringify({
        playlists: playlists.value,
        favorites: favorites.value,
      }));
      storageFailed.value = false;
    } catch {
      storageFailed.value = true;
    }
  }

  function savePlaylist({id, name, trackIds}) {
    const title = name.trim().slice(0, 40);
    if (!title) return null;
    const listId = id ?? (crypto.randomUUID?.()
      ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('-'));
    const list = {id: listId, name: title, trackIds: validTracks(trackIds)};
    const index = playlists.value.findIndex((item) => item.id === list.id);
    if (index === -1) playlists.value.push(list);
    else playlists.value.splice(index, 1, list);
    persist('p', list.id, list);
    return list;
  }

  function removePlaylist(id) {
    playlists.value = playlists.value.filter((list) => list.id !== id);
    persist('p', id, null);
  }

  function toggleFavorite(id) {
    if (!tracksById.has(id)) return;
    const index = favorites.value.indexOf(id);
    if (index === -1) favorites.value.push(id);
    else favorites.value.splice(index, 1);
    persist('f', id, index === -1);
  }

  return {playlists, favorites, storageFailed, syncStatus, retrySync: cloud?.retry,
    savePlaylist, removePlaylist, toggleFavorite};
}
