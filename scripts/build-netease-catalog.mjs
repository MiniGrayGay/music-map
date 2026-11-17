import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {readMusicMediaIndex, readMusicMedia} from './wwise-bank.mjs';
import {VERIFIED_TRACKS, INITIAL_MUSIC_PREVIEWS} from '../src/features/bgm/verifiedTracks.js';

const root = new URL('../', import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const [bgm, coverIndex] = await Promise.all([
  readJson('dist/data/genshin-region-bgm.json'),
  readJson('src/features/bgm/album-covers/album-covers.json'),
]);
const base = 'https://music.163.com';
const artistId = 12487174;
const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const publishedAlbumTitle = (value) => normalize(value.replace(/^原神[-－：:\s]*/u, ''));
const chineseTitle = (value) => value.split(/\s+(?=[A-Za-z(])/u)[0].trim();
const preferredTitle = (value) => normalize(value.normalize('NFKC')
  .replace(/\([^)]*[昼夜]间\)$/u, '')
  .replace(/[於跡蠍塚燻]/gu, (letter) => ({於: '于', 跡: '迹', 蠍: '蝎', 塚: '冢', 燻: '熏'})[letter]));
// 两种出版目录的曲名用字不一致，已核对网易云《白露澈明之泉》曲目。
const albumSpellings = new Map([
  ['沉匿的旧梦', '沈匿的旧梦'],
  ['松林悉窣', '松林析窣'],
]);

async function getJson(path) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(base + path, {signal: AbortSignal.timeout(18_000)});
    if (!response.ok) throw new Error(path + ' HTTP ' + response.status);
    const payload = await response.json();
    if (payload.code === 200) return payload;
    if (payload.code !== 406 || attempt === 3) throw new Error(path + ' 网易云错误码 ' + payload.code);
    await setTimeout(800 * (attempt + 1));
  }
}

async function inBatches(items, concurrency, handle) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    results.push(...await Promise.all(items.slice(offset, offset + concurrency).map(handle)));
  }
  return results;
}

const artistAlbums = [];
for (let offset = 0; ; offset += 100) {
  const page = await getJson('/api/artist/albums/' + artistId + '?limit=100&offset=' + offset);
  if (page.artist?.name !== 'HOYO-MiX' || !page.hotAlbums?.length) throw new Error('网易云艺人专辑清单无效');
  artistAlbums.push(...page.hotAlbums);
  if (!page.more) break;
}
const relevant = artistAlbums.filter(({name}) => /^原神[-－：:]/u.test(name));
const albums = await inBatches(relevant, 2, async ({id}) => {
  const {album, songs} = await getJson('/api/v1/album/' + id);
  if (album?.id !== id || !album.name?.trim() || !Array.isArray(songs) || !songs.length) {
    throw new Error('网易云专辑数据不完整 ' + id);
  }
  return {id, title: album.name, songs};
});
const byTitle = new Map();
const byEnglishTitle = new Map();
for (const album of albums) {
  for (const song of album.songs) {
    if (song.al?.id !== album.id || !song.name?.trim() || !Number.isFinite(song.dt) || song.dt <= 0) continue;
    const name = chineseTitle(song.name);
    const track = {id: song.id, name, duration: song.dt / 1000, albumId: album.id};
    for (const key of new Set([name, song.name].map(preferredTitle))) {
      const tracks = byTitle.get(key) ?? [];
      tracks.push(track);
      byTitle.set(key, tracks);
    }
    const englishTitle = normalize(song.name.slice(name.length));
    if (englishTitle) {
      const tracks = byEnglishTitle.get(englishTitle) ?? [];
      tracks.push(track);
      byEnglishTitle.set(englishTitle, tracks);
    }
  }
}
const media = new Map(Object.entries(bgm.musicGraph.media).map(([id, item]) => [id, item.title]));
for (const {id, name} of [...VERIFIED_TRACKS, ...INITIAL_MUSIC_PREVIEWS]) {
  if (name) media.set(String(id), name);
}
const officialAlbumByTitle = new Map(albums.map(({id, title}) => [publishedAlbumTitle(title), id]));
const matched = new Map();
const unmatched = [];
const named = [...media].filter(([, name]) => typeof name === 'string' && name.trim());
for (const [id, name] of named) {
  const localAlbum = coverIndex.albums[coverIndex.tracks[id]];
  const albumId = localAlbum && officialAlbumByTitle.get(publishedAlbumTitle(localAlbum.title));
  const publishedName = albumId === 175676520 ? albumSpellings.get(name) ?? name : name;
  const matches = byTitle.get(preferredTitle(publishedName)) ?? [];
  const candidates = [...new Map(matches.filter((item) => !localAlbum || item.albumId === albumId)
    .map((item) => [item.id, item])).values()];
  if (candidates.length === 1) matched.set(id, candidates[0]);
  else unmatched.push([id, name, localAlbum?.title ?? null, matches.map((item) => item.albumId)]);
}
// Some in-game sources use a collectible number. Match their independently
// verified Apple release track to the same NetEase album, title and duration.
const alternateIds = new Map();
for (const [id, , album] of unmatched) {
  const source = bgm.musicGraph.media[id]?.soundtrack;
  if (!source || !album) continue;
  const url = new URL(source);
  const appleId = url.searchParams.get('i');
  if (url.hostname === 'music.apple.com' && /^[1-9]\d+$/u.test(appleId)) alternateIds.set(id, Number(appleId));
}
if (alternateIds.size) {
  const url = 'https://itunes.apple.com/lookup?country=us&id=' + [...new Set(alternateIds.values())].join(',');
  const response = await fetch(url, {signal: AbortSignal.timeout(18_000)});
  if (!response.ok) throw new Error('已核对发行版查询 HTTP ' + response.status);
  const {results} = await response.json();
  const appleTracks = new Map(results.map((track) => [track.trackId, track]));
  for (const [id, , album] of unmatched) {
    const apple = appleTracks.get(alternateIds.get(id));
    if (!apple?.trackName) continue;
    const albumId = officialAlbumByTitle.get(publishedAlbumTitle(album));
    const candidates = (byEnglishTitle.get(normalize(apple.trackName)) ?? []).filter((track) =>
      track.albumId === albumId && Math.abs(track.duration - apple.trackTimeMillis / 1000) <= 1);
    if (candidates.length === 1) matched.set(id, candidates[0]);
  }
}
const aliases = await readJson('scripts/verified-wem-aliases.json');
if (aliases.clientVersion === bgm.clientVersion) {
  const original = await readJson('../../dist/genshin-region-bgm.json');
  if (original.clientVersion !== bgm.clientVersion || original.musicGraph?.root !== bgm.musicGraph.root
    || !original.source?.clientAudioRoot) {
    throw new Error('WEM 相同音源的客户端身份不符');
  }
  const ids = [...new Set(aliases.tracks.flatMap(({id, reference}) => [id, reference]))];
  const mediaIndex = await readMusicMediaIndex(original.source.clientAudioRoot, ids);
  for (const {id, reference, sha256} of aliases.tracks) {
    for (const source of [id, reference]) {
      const digest = createHash('sha256').update(await readMusicMedia(mediaIndex.get(source))).digest('hex');
      if (digest !== sha256) throw new Error('相同音源指纹已变化：' + source);
    }
    const canonical = matched.get(String(reference));
    if (!canonical) throw new Error('相同音源缺少已匹配的发行曲目：' + reference);
    const existing = matched.get(String(id));
    if (existing && existing.id !== canonical.id) throw new Error('相同音源的发行曲目冲突：' + id);
    matched.set(String(id), canonical);
  }
}
if (!matched.size) throw new Error('没有曲目与网易云专辑匹配');
console.log('专辑、曲名匹配', {albums: albums.length, sourceIds: media.size, named: named.length, matched: matched.size});

// 仅保留匿名播放接口未标记为试听的曲目，然后探测外链真实响应和 Range。
const ids = [...new Set([...matched.values()].map(({id}) => id))];
const allowed = new Set();
for (let offset = 0; offset < ids.length; offset += 80) {
  const batch = ids.slice(offset, offset + 80);
  const {data} = await getJson('/api/song/enhance/player/url?br=128000&ids=' + encodeURIComponent(JSON.stringify(batch)));
  if (!Array.isArray(data)) throw new Error('网易云播放权限清单无效');
  for (const item of data) {
    if (batch.includes(item.id) && item.code === 200 && item.url && item.freeTrialInfo === null) allowed.add(item.id);
  }
}
const outcomes = await inBatches([...allowed], 8, async (id) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(base + '/song/media/outer/url?id=' + id + '.mp3', {
        redirect: 'manual', signal: AbortSignal.timeout(12_000),
      });
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) return [id, 'link-' + response.status];
      const url = new URL(location, base);
      if (!url.hostname.endsWith('.music.126.net')) return [id, 'redirect-' + url.hostname];
      url.protocol = 'https:';
      const audio = await fetch(url, {headers: {Range: 'bytes=0-31'}, signal: AbortSignal.timeout(12_000)});
      const type = audio.headers.get('content-type');
      const range = audio.headers.get('content-range');
      await audio.body?.cancel();
      if (audio.status === 206 && type?.startsWith('audio/') && /^bytes 0-31\/[1-9]\d+$/u.test(range)) return [id, 'ok'];
      if (audio.status < 500) return [id, 'audio-' + audio.status];
    } catch (error) {
      if (attempt === 1) return [id, error.cause?.code ?? error.name];
    }
  }
  return [id, 'audio-unavailable'];
});
const results = new Map(outcomes);
const tracks = Object.fromEntries([...matched].filter(([, {id}]) => results.get(id) === 'ok'));
if (!Object.keys(tracks).length) throw new Error('直链验证未通过，保留现有曲库');
const used = new Set(Object.values(tracks).map(({albumId}) => albumId));
const catalog = {
  albums: Object.fromEntries(albums.filter(({id}) => used.has(id)).map(({id, title}) => [id, title])),
  tracks,
};
const output = new URL('src/features/bgm/netease-tracks.json', root);
await writeFile(output, JSON.stringify(catalog, null, 2) + '\n');
const remaining = unmatched.filter(([id]) => !matched.has(id));
console.log('可播放曲库', {sourceIds: Object.keys(tracks).length, neteaseIds: new Set(Object.values(tracks).map(({id}) => id)).size,
  albums: used.size, unmatchedNamed: remaining.length, denied: ids.length - allowed.size,
  failed: outcomes.filter(([, result]) => result !== 'ok').length, output: fileURLToPath(output)});
if (process.argv.includes('--details')) console.log({unmatched: remaining, failed: outcomes.filter(([, result]) => result !== 'ok')});
