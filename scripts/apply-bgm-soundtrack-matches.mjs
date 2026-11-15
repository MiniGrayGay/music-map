import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';

const {values: args} = parseArgs({options: {
  manifest: {type: 'string'}, matches: {type: 'string'}, audio: {type: 'string'},
  catalog: {type: 'string'}, 'out-catalog': {type: 'string'}, 'out-manifest': {type: 'string'},
  edition: {type: 'string', multiple: true},
  'publisher-album': {type: 'string', multiple: true},
}});
if (!args.manifest || !args.matches || !args.audio || !args['out-catalog'] || !args['out-manifest']) {
  throw new Error('需要 --manifest、--matches、--audio、--out-catalog 和 --out-manifest');
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const editions = new Map((args.edition ?? []).map((pair) => {
  const parsed = /^(\d+):(\d+)$/.exec(pair);
  if (!parsed) throw new Error(`专辑版本格式无效 ${pair}`);
  return parsed.slice(1);
}));

function albumId(url) {
  const parsed = new URL(url);
  const id = parsed.pathname.split('/').at(-1);
  if (parsed.origin !== 'https://music.apple.com' || !/^\d+$/.test(id)
    || !/^\d+$/.test(parsed.searchParams.get('i') ?? '')) {
    throw new Error(`无效的 Apple Music 曲目链接 ${url}`);
  }
  return id;
}

async function getJson(url, headers) {
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`请求发行曲目失败 HTTP ${response.status}`);
  return response.json();
}

function chineseAlias(bilingual, english) {
  const title = bilingual.normalize('NFC').trim();
  const original = english.normalize('NFC').trim();
  const lower = title.toLowerCase();
  const match = original.toLowerCase();
  const alias = lower.startsWith(match + ' ') ? title.slice(original.length).trim()
    : lower.endsWith(' ' + match) ? title.slice(0, -original.length).trim() : '';
  return /\p{Script=Han}/u.test(alias) ? alias : null;
}

const [catalogFile, manifest, result] = await Promise.all([
  readFile(args.catalog ?? new URL('./verified-soundtrack-titles.json', import.meta.url)),
  readFile(args.manifest, 'utf8').then(JSON.parse),
  readFile(args.matches, 'utf8').then(JSON.parse),
]);
const soundtrack = manifest.verification?.soundtrackTitles;
if (!soundtrack || digest(catalogFile) !== soundtrack.catalogSha256) {
  throw new Error('曲名证据与清单指纹不符');
}
if (!result.matches || Array.isArray(result.matches)) throw new Error('缺少音频指纹匹配结果');
const catalog = JSON.parse(catalogFile);
const media = manifest.musicGraph.media;
let localized = 0;
let added = 0;
for (const [id, match] of Object.entries(result.matches)) {
  if (!/^\d+$/.test(id) || !Object.hasOwn(media, id)) throw new Error(`未知音源 ${id}`);
  if (!match.title || !Number.isFinite(match.score) || match.score < 0.89
    || !Number.isInteger(match.disc) || !Number.isInteger(match.track)
    || (match.runnerUp !== null && (!Number.isFinite(match.runnerUp)
      || match.score - match.runnerUp < 0.07))) {
    throw new Error(`音源 ${id} 缺少唯一的指纹匹配证据`);
  }
  const target = albumId(match.url);
  const track = media[id];
  const previous = catalog[id];
  if (track.titleState) continue;
  if (track.title) {
    if (!previous || track.title !== previous.title || track.soundtrack !== previous.url
      || /\p{Script=Han}/u.test(track.title) || !/\p{Script=Han}/u.test(match.title)
      || editions.get(albumId(previous.url)) !== target
      || previous.disc !== match.disc || previous.track !== match.track) continue;
  }
  const audioSha256 = digest(await readFile(path.join(args.audio, `${id}.opus`)));
  if (audioSha256 !== match.audioSha256 || (previous && audioSha256 !== previous.audioSha256)) {
    throw new Error(`音源指纹发生变化 ${id}`);
  }
  const {title, url, disc, track: trackNumber, score, runnerUp} = match;
  catalog[id] = {title, audioSha256, url, disc, track: trackNumber, score, runnerUp};
  if (previous) catalog[id].localizedFrom = {title: previous.title, url: previous.url, score: previous.score};
  if (track.title) localized += 1;
  else added += 1;
  track.title = title;
  track.soundtrack = url;
}

for (const pair of args['publisher-album'] ?? []) {
  const parsed = /^(\d+):([A-Za-z0-9]+)$/.exec(pair);
  if (!parsed) throw new Error(`发行专辑格式无效 ${pair}`);
  const [, appleId, qqId] = parsed;
  const candidates = Object.entries(media).filter(([id, track]) => track.title && !track.titleState
    && !/\p{Script=Han}/u.test(track.title) && catalog[id]?.url === track.soundtrack
    && catalog[id].title === track.title && albumId(track.soundtrack) === appleId);
  if (!candidates.length) continue;
  const country = new URL(candidates[0][1].soundtrack).pathname.split('/')[1];
  const lookup = new URLSearchParams({id: appleId, country, entity: 'song', limit: '200'});
  const album = /^\d+$/.test(qqId) ? {albumId: Number(qqId)} : {albumMid: qqId};
  const payload = {req: {module: 'music.musichallAlbum.AlbumSongList', method: 'GetAlbumSongList',
    param: {...album, begin: 0, num: 200, order: 2}}};
  const qqUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(JSON.stringify(payload));
  const [apple, qq] = await Promise.all([
    getJson(`https://itunes.apple.com/lookup?${lookup}`),
    getJson(qqUrl, {Referer: 'https://y.qq.com/'}),
  ]);
  const rows = qq.req?.data?.songList?.map(({songInfo}) => songInfo) ?? [];
  if (qq.req?.code !== 0 || !rows.length || rows.length !== qq.req.data.totalNum) {
    throw new Error(`发行曲目表不完整 ${qqId}`);
  }
  for (const [id, track] of candidates) {
    const prior = catalog[id];
    const trackId = new URL(prior.url).searchParams.get('i');
    const original = apple.results.find((row) => String(row.trackId) === trackId
      && row.trackName === prior.title && row.discNumber === prior.disc && row.trackNumber === prior.track);
    if (!original) continue;
    const aliases = rows.filter((row) => Object.entries(album).every(([key, value]) =>
      row.album[key === 'albumId' ? 'id' : 'mid'] === value)
      && row.singer.some(({name}) => name === 'HOYO-MiX')
      && row.index_cd + 1 === prior.disc && row.index_album === prior.track
      && Math.abs(row.interval * 1000 - original.trackTimeMillis) <= 1100)
      .map((row) => ({row, title: chineseAlias(row.title, track.title)}))
      .filter(({title}) => title);
    if (aliases.length !== 1) continue;
    const [{row, title}] = aliases;
    if (digest(await readFile(path.join(args.audio, `${id}.opus`))) !== prior.audioSha256) {
      throw new Error(`音源指纹发生变化 ${id}`);
    }
    prior.localizedFrom = {title: prior.title, url: prior.url, score: prior.score};
    prior.publisherTitle = {title: row.title, url: `https://y.qq.com/n/ryqq/songDetail/${row.mid}`};
    prior.title = title;
    track.title = title;
    localized += 1;
  }
}
const evidence = JSON.stringify(catalog);
soundtrack.catalogSha256 = digest(evidence);
soundtrack.matchedMedia = Object.keys(media).filter((id) => Object.hasOwn(catalog, id)).length;
await writeFile(args['out-catalog'], evidence, {flag: 'wx'});
await writeFile(args['out-manifest'], `${JSON.stringify(manifest)}\n`, {flag: 'wx'});
console.log(`新增已证实曲名 ${added} 首，补全发行方中文名 ${localized} 首`);
