import catalog from './netease-tracks.json' with { type: 'json' };
import {musicClockState, normalizeGameStates, resolveMusic} from './musicGraph.js';

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
  const {graph, musicState, playlists, gameMusicStates} = zone;
  // zone.gameMusicStates 是可选的精确游戏状态输入（含 0 值）。有效性判定与
  // 归一化只用 musicGraph 导出的一份实现；有明确状态时结果以解析为准：graph
  // 缺失或解析为空即确证空，禁止把其他天气的 authored/fallback 曲单混入；
  // 未传或无合法条目时保持旧行为。
  const gameStates = normalizeGameStates(gameMusicStates);
  const hasGameStates = Object.keys(gameStates).length > 0;
  const branches = playlists?.exploration ?? [];
  const clock = graph?.clock;
  const resolved = graph && resolveMusic(graph, musicState, 'exploration',
    clock ? {...overrides, [clock.group]: musicClockState(clock, phaseMinutes[phase])} : overrides,
    hasGameStates ? gameStates : null);

  let sources;
  if (hasGameStates) {
    // 明确游戏状态：只认解析结果（含确证空），graph 缺失也不回 authored 分支。
    sources = resolved ? resolved.tracks : [];
  } else {
    // Reuse the authored variant lists for a confirmed empty default with no separate clock
    // option. Their IDs undergo the same catalog lookup as tracks resolved by the music graph.
    sources = !resolved ? branches[0]?.tracks ?? []
      : resolved.tracks.length || resolved.incomplete || resolved.conditions.some(({id}) => id === clock?.group)
        ? resolved.tracks
        : branches.flatMap((branch) => branch.tracks);
  }
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

// 昼夜不再做成 UI 分支：分别解析两时段后按网易云 id 去重合并——保留白天顺序，
// 夜晚独有曲目按原顺序追加在后。命名条件从昼夜两侧收录，按 id 合并、entries 按
// key 去重（先见优先）；显式 overrides 命中该条件选项时保留所选 key，否则各条件
// 保留原 day（或仅 night 才有）自己的 value。clock 组已在单时段解析时滤除。
export function resolveRegionalQueue(zone, overrides = {}) {
  const day = resolveRegionalPlaylist(zone, 'day', overrides);
  const night = resolveRegionalPlaylist(zone, 'night', overrides);
  const songs = new Map();
  for (const song of [...day.tracks, ...night.tracks]) {
    if (!songs.has(song.neteaseId)) songs.set(song.neteaseId, song);
  }
  const conditions = new Map();
  for (const condition of [...day.conditions, ...night.conditions]) {
    const merged = conditions.get(condition.id);
    if (!merged) {
      conditions.set(condition.id, {...condition, entries: condition.entries.map((entry) => ({...entry}))});
      continue;
    }
    const keys = new Set(merged.entries.map(({key}) => key));
    for (const entry of condition.entries) {
      if (!keys.has(entry.key)) {
        keys.add(entry.key);
        merged.entries.push({...entry});
      }
    }
  }
  for (const condition of conditions.values()) {
    const overrideKey = overrides[condition.id];
    if (overrideKey != null && condition.entries.some(({key}) => key === overrideKey)) {
      condition.value = overrideKey;
    }
  }
  return {
    tracks: [...songs.values()],
    conditions: [...conditions.values()],
  };
}
