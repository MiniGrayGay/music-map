import {ref} from 'vue';
import catalog from './netease-tracks.json' with {type: 'json'};
import {neteaseTrack} from './regionalPlaylist.js';

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

function readLibrary() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
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
  } catch {
    return {playlists: [], favorites: []};
  }
}

export function usePlaylistLibrary() {
  const initial = readLibrary();
  const playlists = ref(initial.playlists);
  const favorites = ref(initial.favorites);
  const storageFailed = ref(false);

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
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
    persist();
    return list;
  }

  function removePlaylist(id) {
    playlists.value = playlists.value.filter((list) => list.id !== id);
    persist();
  }

  function toggleFavorite(id) {
    if (!tracksById.has(id)) return;
    const index = favorites.value.indexOf(id);
    if (index === -1) favorites.value.push(id);
    else favorites.value.splice(index, 1);
    persist();
  }

  return {playlists, favorites, storageFailed, savePlaylist, removePlaylist, toggleFavorite};
}
