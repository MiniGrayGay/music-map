import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';

const {values: args} = parseArgs({options: {
  audio: {type: 'string'},
  ffmpeg: {type: 'string', default: 'ffmpeg'},
  album: {type: 'string', multiple: true},
  scratch: {type: 'string'},
  result: {type: 'string', default: 'soundtrack-matches.json'},
  track: {type: 'string', multiple: true},
  excerpt: {type: 'string', multiple: true},
}});
if (!args.audio || !args.scratch || !args.album?.length || path.basename(args.result) !== args.result) {
  throw new Error('需要 --audio、--scratch 和至少一个 --album 国家代码:专辑编号');
}

function fingerprint(source, data) {
  return new Promise((resolve, reject) => {
    const process = execFile(args.ffmpeg, [
      '-v', 'error', '-nostdin', '-i', source, '-map', '0:a:0',
      '-f', 'chromaprint', '-fp_format', 'raw', '-',
    ], {encoding: 'buffer', timeout: 25000, windowsHide: true}, (error, bytes) => {
      if (error) return reject(error);
      if (bytes.length % 4) return reject(new Error('Chromaprint 的帧长度无效'));
      const frames = new Uint32Array(bytes.length / 4);
      for (let index = 0; index < frames.length; index += 1) frames[index] = bytes.readUInt32LE(index * 4);
      resolve(frames);
    });
    process.stdin.on('error', () => {});
    process.stdin.end(data);
  });
}

async function request(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function appleMusicTracks(id, country) {
  const response = await request(`https://music.apple.com/${country}/album/${id}`);
  const page = await response.text();
  const state = page.match(/<script\b(?=[^>]*\bid="serialized-server-data")[^>]*>([\s\S]*?)<\/script>/);
  if (!state) throw new Error(`Apple Music 缺少专辑数据 ${country}:${id}`);
  const entries = JSON.parse(state[1]).data ?? [];
  const album = entries.find(({intent}) => intent?.contentDescriptor?.kind === 'album'
    && intent.contentDescriptor.identifiers?.storeAdamID === id
    && intent.contentDescriptor.locale?.storefront === country);
  if (!album) throw new Error(`Apple Music 实际返回的专辑不符 ${country}:${id}`);
  const tracks = (album.data?.sections ?? []).flatMap(({items}) => items ?? [])
    .filter(({contentDescriptor, playAction}) => contentDescriptor?.kind === 'song'
      && playAction?.containerContentDescriptor?.identifiers?.storeAdamID === id);
  if (!tracks.length) throw new Error(`Apple Music 缺少完整曲目表 ${country}:${id}`);
  return tracks.map((track) => ({
    trackId: track.contentDescriptor.identifiers?.storeAdamID,
    trackName: track.title, trackViewUrl: track.contentDescriptor.url,
    discNumber: track.discNumber, trackNumber: track.trackNumber,
    artistName: track.artistName, previewUrl: track.previewUrl,
  }));
}

async function catalog(album) {
  const match = /^([a-z]{2}):(\d+)$/i.exec(album);
  if (!match) throw new Error(`无效专辑地址 ${album}`);
  const [, country, id] = match;
  const query = new URLSearchParams({id, country, entity: 'song', limit: '200'});
  const response = await request(`https://itunes.apple.com/lookup?${query}`);
  const search = (await response.json()).results.filter((row) => row.trackId);
  const tracks = search.length ? search : await appleMusicTracks(id, country);
  return tracks.filter((row) => row.trackId && row.trackName && row.previewUrl
    && row.artistName?.includes('HOYO-MiX')
    && (!args.excerpt || args.excerpt.includes(String(row.trackId))));
}

async function parallel(items, size, run) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(...await Promise.all(items.slice(index, index + size).map(run)));
  }
  return output;
}

const width = 90;
const keyCount = 65536;
const pop = Uint8Array.from({length: 256}, (_, number) => {
  let value = number;
  let count = 0;
  while (value) {
    value &= value - 1;
    count += 1;
  }
  return count;
});

function bandIndex(words, shift) {
  const boundaries = new Uint32Array(keyCount + 1);
  for (const word of words) boundaries[((word >>> shift) & 0xffff) + 1] += 1;
  for (let key = 1; key <= keyCount; key += 1) boundaries[key] += boundaries[key - 1];
  const next = boundaries.slice();
  const positions = new Uint32Array(words.length);
  for (let offset = 0; offset < words.length; offset += 1) {
    positions[next[(words[offset] >>> shift) & 0xffff]++] = offset;
  }
  return {shift, boundaries, positions};
}

function compare(local, preview, delta) {
  const first = Math.max(0, -delta);
  const end = Math.min(preview.length, local.length - delta);
  if (end - first < width) return 0;
  const ring = new Uint8Array(width);
  let sum = 0;
  let minimum = Infinity;
  for (let offset = first; offset < end; offset += 1) {
    const xor = local[offset + delta] ^ preview[offset];
    const bits = pop[xor & 255] + pop[(xor >>> 8) & 255] + pop[(xor >>> 16) & 255] + pop[xor >>> 24];
    const index = (offset - first) % width;
    sum += bits - ring[index];
    ring[index] = bits;
    if (offset + 1 - first >= width) minimum = Math.min(minimum, sum);
  }
  return Math.round((1 - minimum / (width * 32)) * 100000) / 100000;
}

const files = (await readdir(args.audio)).filter((file) => /^\d+\.opus$/.test(file)
  && (!args.track || args.track.includes(path.basename(file, '.opus')))).sort();
if (!files.length) throw new Error('找不到可比对的音源');
const identities = await parallel(files, 24, async (file) => {
  const info = await stat(path.join(args.audio, file));
  const digest = createHash('sha256').update(await readFile(path.join(args.audio, file))).digest('hex');
  return [file, info.size, info.mtimeMs, digest];
});
const sourceDigests = new Map(identities.map(([file, , , digest]) => [path.basename(file, '.opus'), digest]));
const signature = createHash('sha256').update(JSON.stringify([path.resolve(args.audio), identities])).digest('hex');
const cacheFile = path.join(args.scratch, 'opus-fingerprints.json');
const cached = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
const streams = cached?.signature === signature
  ? cached.streams.map((row) => Uint32Array.from(row))
  : await parallel(files, 5, (file) => fingerprint(path.join(args.audio, file)));
if (cached?.signature !== signature) {
  await writeFile(cacheFile, JSON.stringify({signature, streams: streams.map((row) => [...row])}));
}

const starts = new Uint32Array(streams.length + 1);
streams.forEach((track, index) => { starts[index + 1] = starts[index] + track.length; });
const words = new Uint32Array(starts.at(-1));
const owners = new Uint32Array(words.length);
streams.forEach((track, index) => {
  words.set(track, starts[index]);
  owners.fill(index, starts[index], starts[index + 1]);
});
const bands = [0, 16, 5, 11].map((shift) => bandIndex(words, shift));
const songs = (await parallel(args.album, 4, catalog)).flat();
if (!songs.length) throw new Error('指定专辑没有可读取的官方试听');

function shortlist(preview) {
  const votes = new Map();
  for (const {shift, boundaries, positions} of bands) {
    for (let position = 0; position < preview.length; position += 10) {
      const key = (preview[position] >>> shift) & 0xffff;
      if (boundaries[key + 1] - boundaries[key] > 270) continue;
      for (let entry = boundaries[key]; entry < boundaries[key + 1]; entry += 1) {
        const offset = positions[entry];
        const owner = owners[offset];
        const delta = offset - starts[owner] - position;
        const code = `${owner}:${delta}`;
        const vote = votes.get(code);
        if (vote) vote.count += 1;
        else votes.set(code, {owner, delta, count: 1});
      }
    }
  }
  return [...votes.values()].filter(({count}) => count >= 6).map(({owner, delta, count}) => ({
    owner, delta, count: count + (votes.get(`${owner}:${delta - 1}`)?.count ?? 0)
      + (votes.get(`${owner}:${delta + 1}`)?.count ?? 0),
  })).sort((a, b) => b.count - a.count || b.owner - a.owner || b.delta - a.delta).slice(0, 18);
}

const matches = new Map();
const failures = [];
await parallel(songs, 6, async (song) => {
  let preview;
  try {
    const response = await request(song.previewUrl);
    preview = await fingerprint('pipe:0', Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    failures.push([song.trackId, error.message]);
    return;
  }
  for (const {owner, delta} of shortlist(preview)) {
    const score = Math.max(...[-1, 0, 1].map((offset) => compare(streams[owner], preview, delta + offset)));
    if (score < 0.76) continue;
    const source = path.basename(files[owner], '.opus');
    const hits = matches.get(source) ?? new Map();
    if ((hits.get(song.trackId)?.score ?? 0) < score) {
      hits.set(song.trackId, {title: song.trackName, url: song.trackViewUrl,
        disc: song.discNumber, track: song.trackNumber, score});
    }
    matches.set(source, hits);
  }
});

const verified = {};
for (const [source, hits] of matches) {
  const ordered = [...hits.values()].sort((a, b) => b.score - a.score);
  const winner = ordered[0];
  const runnerUp = ordered.find((item) => item.title !== winner.title)?.score ?? null;
  if (winner.score >= 0.89 && (runnerUp === null || winner.score - runnerUp >= 0.07)) {
    const audioSha256 = createHash('sha256')
      .update(await readFile(path.join(args.audio, `${source}.opus`))).digest('hex');
    if (audioSha256 !== sourceDigests.get(source)) throw new Error(`比对过程中音源发生变化 ${source}`);
    verified[source] = {...winner, runnerUp, audioSha256};
  }
}
await writeFile(path.join(args.scratch, args.result), JSON.stringify({
  matches: verified, failures, albumPreviews: songs.length,
}));
console.log(`比对 ${songs.length} 段官方试听，得到 ${Object.keys(verified).length} 个候选，读取失败 ${failures.length} 段`);
