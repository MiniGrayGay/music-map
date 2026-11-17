import catalog from './netease-tracks.json' with { type: 'json' };
import {musicClockState, resolveMusic} from './musicGraph.js';

export const dayNightChoices = [
  {key: 'day', label: '白天'},
  {key: 'night', label: '夜间'},
];

const phaseMinutes = {day: 12 * 60, night: 23 * 60};

export function neteaseTrack(id) {
  const song = catalog.tracks[id];
  const album = catalog.albums[song?.albumId];
  if (!song || !album) return null;
  return {
    id,
    displayName: song.name,
    duration: song.duration,
    album,
    neteaseId: song.id,
    url: 'https://music.163.com/song/media/outer/url?id=' + song.id + '.mp3',
  };
}

export function resolveRegionalPlaylist(zone, phase, overrides = {}) {
  const {graph, musicState, playlists} = zone;
  const branches = playlists?.exploration ?? [];
  const clock = graph?.clock;
  const resolved = graph && resolveMusic(graph, musicState, 'exploration',
    clock ? {...overrides, [clock.group]: musicClockState(clock, phaseMinutes[phase])} : overrides);

  // Reuse the authored variant lists for a confirmed empty default with no separate clock option.
  // Their IDs undergo the same catalog lookup as tracks resolved by the music graph.
  const sources = !resolved ? branches[0]?.tracks ?? []
    : resolved.tracks.length || resolved.incomplete || resolved.conditions.some(({id}) => id === clock?.group)
      ? resolved.tracks
      : branches.flatMap((branch) => branch.tracks);
  const songs = new Map();
  for (const {id} of sources) {
    const song = neteaseTrack(id);
    if (song && !songs.has(song.neteaseId)) songs.set(song.neteaseId, song);
  }
  return {
    tracks: [...songs.values()],
    conditions: (resolved?.conditions ?? []).filter(({id, named}) => named && id !== clock?.group),
  };
}
