// 海外音源（music.kuutar.moe）目录构建：把净化后的网易云曲目映射到
// assets.kuutar.moe 的稳定相对路径，输出 src/features/bgm/overseas-ost.json。
// 输入：src/features/bgm/netease-tracks.json + 网易云官方专辑 API + kuutar SSR 页面。
// 每条候选必须实测 HTTP Range 206 / audio/mp4 / ftyp 头才纳入；全部失败或零结果
// 时明确报错，绝不覆盖正式输出。只下载 ≤64 字节探测，不安装、不落临时文件。
// 用法：node scripts/build-overseas-ost-catalog.mjs
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const neteaseBase = 'https://music.163.com';
const siteBase = 'https://music.kuutar.moe';
const assetsBase = 'https://assets.kuutar.moe/soundtracks';
const probeBytes = 64;
const audioConcurrency = 10;
const pageConcurrency = 8;

const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const chineseTitle = (value) => value.split(/\s+(?=[A-Za-z(])/u)[0].trim();

// 已确证的原专辑等同曲名（仅两对；键值均为 normalize 后曲名，逐对核实原专辑命名/时长一致后才可新增）
const titleEquivalences = new Map([
  ['awaitingforthefuture', 'awaitingthefuture'],
  ['bustlingafternoonofmondstadt', 'bustlingafternooninmondstadt'],
]);
// 网易云英文名末尾的地点+时段标注（闭括号可缺，如 "(Qingce Night"）不属于原专辑曲名
const neteaseSuffixRe = /\s*\((?:Wangshu|Qingce)\s+(?:Daytime|Night)\)?$/iu;
const nameVariants = (value) => {
  const base = normalize(value);
  const variants = new Set([base]);
  const stripped = normalize(value.replace(neteaseSuffixRe, ''));
  if (stripped && stripped !== base) variants.add(stripped);
  const equivalent = titleEquivalences.get(base) ?? titleEquivalences.get(stripped);
  if (equivalent) variants.add(equivalent);
  return variants;
};
const sleep = (ms) => setTimeout(ms);

async function fetchText(url, {attempt = 0} = {}) {
  const response = await fetch(url, {
    headers: {'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429 || response.status === 503) {
    if (attempt >= 4) throw new Error(url + ' HTTP ' + response.status + ' 限流退让耗尽');
    await sleep(1500 * 2 ** attempt);
    return fetchText(url, {attempt: attempt + 1});
  }
  if (!response.ok) throw new Error(url + ' HTTP ' + response.status);
  return response.text();
}

async function getNeteaseJson(path) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(neteaseBase + path, {signal: AbortSignal.timeout(18_000)});
    if (!response.ok) throw new Error(path + ' HTTP ' + response.status);
    const payload = await response.json();
    if (payload.code === 200) return payload;
    if (payload.code !== 406 || attempt === 3) throw new Error(path + ' 网易云错误码 ' + payload.code);
    await sleep(800 * (attempt + 1));
  }
}

async function pool(items, concurrency, handle) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = {ok: true, value: await handle(items[index], index)};
      } catch (error) {
        results[index] = {ok: false, error};
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// —— kuutar SSR（React Flight 文本，非 JSON）：仅正则+括号配平提取，绝不 eval ——
const trackEntryRe = /id:"([0-9a-f-]{36})",slug:"([a-z0-9-]+)",track_number:(\d+),name:"((?:[^"\\]|\\.)*)",duration_sec:(\d+)/gu;
const unescapeFlight = (value) => value.replace(/\\(["\\])/gu, '$1');

function parseAlbumPage(html, slug) {
  // 定位当前 slug 的 album 主记录（新形状无 barcode：album:$R[n]={id,slug,name,...}）。
  // 取最后一处精确 slug 匹配，避免命中其他专辑正文里的同名引用。
  const marker = 'slug:' + JSON.stringify(slug);
  const start = html.lastIndexOf(marker);
  if (start < 0) return null;
  const window = html.slice(start, start + 1600);
  const idMatch = window.match(/id:"([0-9a-f-]{36})",slug:/u);
  const name = window.match(/,name:"((?:[^"\\]|\\.)*)"/u);
  const nameJp = window.match(/name_jp:(?:"((?:[^"\\]|\\.)*)"|null)/u);
  const nameCn = window.match(/name_cn:(?:"((?:[^"\\]|\\.)*)"|null)/u);
  const totalMatch = window.match(/total_tracks:(\d+)/u);
  if (!idMatch || !name || !totalMatch) return null;
  const meta = {
    slug, id: idMatch[1], name: unescapeFlight(name[1]),
    nameJp: nameJp?.[1] ? unescapeFlight(nameJp[1]) : null,
    nameCn: nameCn?.[1] ? unescapeFlight(nameCn[1]) : null,
    totalTracks: Number(totalMatch[1]), tracks: [],
  };
  // 主记录之后整段文本 matchAll，按 UUID 去重；强校验数量 === total_tracks。
  const seen = new Set();
  for (const m of html.slice(start).matchAll(trackEntryRe)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    meta.tracks.push({uuid: m[1], slug: m[2], trackNumber: Number(m[3]),
      name: unescapeFlight(m[4]), durationSec: Number(m[5])});
  }
  if (meta.tracks.length !== meta.totalTracks) {
    throw new Error(`专辑 ${slug}: 解析 ${meta.tracks.length} 首 !== total_tracks ${meta.totalTracks}`);
  }
  return meta;
}

// sitemap → /album/<slug>
const sitemap = await fetchText(siteBase + '/sitemap.xml');
const albumSlugs = [...new Set([...sitemap.matchAll(/https:\/\/music\.kuutar\.moe\/album\/([a-z0-9-]+)</gu)].map((m) => m[1]))];
if (!albumSlugs.length) throw new Error('kuutar sitemap 未解析出任何 /album 链接');
console.log(`kuutar sitemap: ${albumSlugs.length} 张专辑页`);

const kuutarResults = await pool(albumSlugs, pageConcurrency, async (slug) => {
  const html = await fetchText(`${siteBase}/album/${slug}`);
  return parseAlbumPage(html, slug);
});
const kuutarParseFailures = kuutarResults.filter((r) => !r.ok);
for (const failure of kuutarParseFailures) {
  console.warn(`专辑解析失败: ${failure.error.message}`);
}
const kuutarAlbums = kuutarResults.filter((r) => r.ok).map((r) => r.value)
  .filter((album) => album && album.tracks.length);
console.log(`kuutar 专辑解析出曲目: ${kuutarAlbums.length}`);
if (!kuutarAlbums.length) throw new Error('kuutar 专辑页均未解析出曲目数据');

// —— 网易云侧输入 ——
const tracksJson = JSON.parse(await readFile(new URL('src/features/bgm/netease-tracks.json', root), 'utf8'));
if (!tracksJson.albums || !tracksJson.tracks) throw new Error('netease-tracks.json 结构无效');
const albumTitles = tracksJson.albums;
const records = Object.values(tracksJson.tracks).filter(
  (song) => song.id && song.name?.trim() && Number.isFinite(song.duration),
);
const uniqueIds = new Set(records.map((song) => String(song.id)));
console.log(`网易云侧: ${records.length} 条记录 / ${uniqueIds.size} 个唯一公开 id，${Object.keys(albumTitles).length} 张专辑`);

// 专辑映射：网易云专辑 id -> kuutar 专辑（英文+中文净名双向匹配，歧义即拒）
const albumIndex = new Map();
const albumIndexDupes = new Set();
for (const album of kuutarAlbums) {
  for (const key of new Set([album.name, album.nameCn].filter(Boolean).map(normalize))) {
    if (albumIndex.has(key) && albumIndex.get(key) !== album) {
      albumIndexDupes.add(key);
      console.warn(`歧义专辑名，禁用索引: ${key} (${albumIndex.get(key).slug} / ${album.slug})`);
      continue;
    }
    albumIndex.set(key, album);
  }
}
const albumLinks = new Map();
const albumLinkMisses = [];
for (const [albumId, title] of Object.entries(albumTitles)) {
  const published = title.replace(/^原神[-－：:\s]*/u, '');
  const cn = chineseTitle(published);
  const en = published.slice(cn.length).trim();
  let target = null;
  for (const key of [normalize(en), normalize(cn)]) {
    if (key && albumIndex.has(key) && !albumIndexDupes.has(key)) { target = albumIndex.get(key); break; }
  }
  if (target) albumLinks.set(albumId, target);
  else albumLinkMisses.push(`${albumId} ${title}`);
}
console.log(`专辑映射: ${albumLinks.size}/${Object.keys(albumTitles).length}`);
for (const miss of albumLinkMisses) console.warn('  专辑未映射: ' + miss);

// 官方专辑 API 补英文曲名（song.name = “中文 英文”，本地拆出英文；API 校验 album.id 需转 String）
const englishNames = new Map();
const linkedAlbumIds = [...albumLinks.keys()];
const apiResults = await pool(linkedAlbumIds, 3, async (albumId) => ({albumId,
  payload: await getNeteaseJson('/api/v1/album/' + albumId)}));
for (const result of apiResults) {
  if (!result.ok) {
    console.warn(`网易云专辑 API 失败: ${result.error.message}（该专辑仅用本地英文拆分）`);
    continue;
  }
  const {albumId, payload} = result.value;
  const {album, songs: apiSongs} = payload;
  if (String(album?.id) !== albumId || !Array.isArray(apiSongs)) {
    console.warn(`网易云专辑 API 返回不匹配专辑 ${album?.id}`);
    continue;
  }
  for (const song of apiSongs) {
    const full = song.name ?? '';
    const cn = chineseTitle(full);
    const en = full.slice(cn.length).trim();
    if (en && song.id) englishNames.set(String(song.id), en);
  }
}
console.log(`官方 API 补充英文名: ${englishNames.size} 首`);

// —— 曲目匹配：净化曲名（英文优先、中文兜底）+ 时长 ±2s，同专辑内唯一候选才采纳 ——
const groups = new Map(); // publishedId -> records
for (const song of records) {
  const list = groups.get(String(song.id)) ?? [];
  list.push(song);
  groups.set(String(song.id), list);
}
const matched = new Map(); // publishedId -> {uuid, songName}
const matchSkipped = [];
for (const [songId, songRecords] of groups) {
  const verdicts = [];
  for (const song of songRecords) {
    const kuutarAlbum = albumLinks.get(String(song.albumId));
    if (!kuutarAlbum) { verdicts.push({song, error: '专辑未映射到 kuutar'}); continue; }
    const cn = chineseTitle(song.name);
    const names = new Set([englishNames.get(songId), song.name.slice(cn.length).trim(), cn]
      .filter(Boolean).flatMap((value) => [...nameVariants(value)]));
    const tolerance = 2;
    const nameHits = kuutarAlbum.tracks.filter((track) => names.has(normalize(track.name)));
    const durationHits = kuutarAlbum.tracks.filter((track) => Math.abs(track.durationSec - song.duration) <= tolerance);
    const hits = nameHits.filter((track) => durationHits.includes(track));
    const unique = [...new Map(hits.map((track) => [track.uuid, track])).values()];
    if (!unique.length) {
      verdicts.push({song, error: nameHits.length
        ? `曲名匹配但时长不符: kuutar ${nameHits.map((t) => t.durationSec).join('/')}s vs ${song.duration}s`
        : durationHits.length ? `时长接近但曲名不符: ${durationHits.map((t) => t.name).join('/')}` : '无同时匹配项'});
      continue;
    }
    if (unique.length > 1) { verdicts.push({song, error: `同专辑候选歧义: ${unique.map((t) => t.slug).join(',')}`}); continue; }
    verdicts.push({song, track: unique[0]});
  }
  const ok = verdicts.filter((v) => v.track);
  const uuids = new Set(ok.map((v) => v.track.uuid));
  if (ok.length && uuids.size === 1) matched.set(songId, {uuid: ok[0].track.uuid, slug: ok[0].track.slug, songName: ok[0].song.name});
  else matchSkipped.push({songId, reason: !ok.length ? verdicts[0]?.error ?? '无匹配'
    : `重复记录映射到不同曲目: ${[...uuids].join(',')}`});
}
console.log(`曲名+时长匹配: ${matched.size}/${uniqueIds.size}，匹配阶段跳过 ${matchSkipped.length}`);

// —— 候选直链验证：先验 206 / Content-Range / audio/mp4，再读 ≤64 字节验 ftyp ——
async function probePath(relativePath) {
  const url = `${assetsBase}/${relativePath}`;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {headers: {range: `bytes=0-${probeBytes - 1}`, referer: siteBase + '/'}, signal: AbortSignal.timeout(20_000)});
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    try {
      if (response.status === 429 || response.status === 503) {
        if (attempt >= 3) throw new Error('限流退让耗尽');
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (response.status !== 206) throw new Error(`状态 ${response.status}（要求 206）`);
      const contentType = String(response.headers.get('content-type') ?? '');
      if (!/^audio\/mp4\b/i.test(contentType)) throw new Error(`Content-Type ${contentType}`);
      const contentRange = String(response.headers.get('content-range') ?? '');
      if (!contentRange.startsWith(`bytes 0-${probeBytes - 1}/`)) throw new Error(`Content-Range ${contentRange}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 12) throw new Error(`仅 ${buffer.length} 字节`);
      if (buffer.subarray(4, 8).toString('latin1') !== 'ftyp') throw new Error('无 ftyp 头');
      return url;
    } finally {
      try { await response.body?.cancel(); } catch {}
    }
  }
}

// 主路径 3/<uuid>/aac256.m4a 失败时才查该曲公开页 manifest，只允许同版本 aac256 变体。
async function fallbackPaths(uuid, trackSlug) {
  const html = await fetchText(`${siteBase}/soundtrack/${trackSlug}`);
  const escaped = uuid.replace(/-/g, '\\-');
  const paths = [...html.matchAll(new RegExp(`soundtracks/(\\w+)/${escaped}/(aac256\\.m4a)`, 'g'))]
    .map((m) => `${m[1]}/${m[2]}`);
  return [...new Set(paths)].filter((path) => path !== `3/${uuid}/aac256.m4a`);
}

const verified = new Map();
const verifyFailures = [];
const entries = [...matched.entries()].map(([songId, info]) => ({songId, ...info}));
// 复用上一轮已验证缓存：相对路径一致则免重复 CDN 探测。
const cacheHits = new Map();
let previousOutput = null;
try {
  const previous = JSON.parse(await readFile(new URL('src/features/bgm/overseas-ost.json', root), 'utf8'));
  if (previous && typeof previous === 'object') previousOutput = previous;
} catch {}
if (previousOutput) {
  for (const entry of entries) {
    const cached = previousOutput[entry.songId];
    // 上轮已验证（206/audio/mp4/ftyp）的路径仅在与本轮匹配到的候选 uuid 一致时沿用，免重复 CDN 探测
    if (typeof cached === 'string' && /^[\w-]+\/[0-9a-f-]{36}\/aac256\.m4a$/u.test(cached)
      && cached.endsWith(`/${entry.uuid}/aac256.m4a`)) {
      verified.set(entry.songId, cached);
      cacheHits.set(entry.songId, cached);
    }
  }
  console.log(`缓存复用: ${cacheHits.size}/${entries.length} 条沿用已验证路径`);
}
const toProbe = entries.filter((entry) => !cacheHits.has(entry.songId));
let done = 0;
await pool(toProbe, audioConcurrency, async (entry) => {
  const primary = `3/${entry.uuid}/aac256.m4a`;
  try {
    await probePath(primary);
  } catch (primaryError) {
    let recovered = false;
    try {
      for (const path of await fallbackPaths(entry.uuid, entry.slug)) {
        try {
          await probePath(path);
          verified.set(entry.songId, path);
          recovered = true;
          break;
        } catch {}
      }
    } catch (fallbackError) {
      verifyFailures.push({songId: entry.songId, path: primary, error: `${primaryError.message}；manifest 回退亦失败: ${fallbackError.message}`});
      return;
    }
    if (!recovered) {
      verifyFailures.push({songId: entry.songId, path: primary, error: primaryError.message});
      return;
    }
    done += 1;
    return;
  }
  verified.set(entry.songId, primary);
  done += 1;
  if (done % 100 === 0) console.log(`直链验证进度 ${done}/${toProbe.length}`);
});

// —— 输出与报告：零结果绝不覆盖正式输出 ——
if (!verified.size) {
  console.error('\n全部验证失败，未写入 src/features/bgm/overseas-ost.json');
  for (const failure of verifyFailures.slice(0, 20)) console.error(`  ${failure.songId} ${failure.path}: ${failure.error}`);
  process.exit(1);
}
const output = Object.fromEntries([...verified.entries()]
  .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)));
const outPath = new URL('src/features/bgm/overseas-ost.json', root);
await writeFile(outPath, JSON.stringify(output, null, 2) + '\n');

console.log('\n===== 覆盖报告 =====');
console.log(`写入 src/features/bgm/overseas-ost.json: ${Object.keys(output).length} 条`);
console.log(`覆盖唯一公开 id: ${verified.size}/${uniqueIds.size} (${(100 * verified.size / uniqueIds.size).toFixed(1)}%)`);
for (const key of ['1492276411', '1492276426', '1956541069']) {
  console.log(`故障曲 ${key}: ${output[key] ? '→ ' + output[key] : '未纳入'}`);
}
const reasonCounts = new Map();
for (const {reason} of matchSkipped) {
  const bucket = reason.split(':')[0];
  reasonCounts.set(bucket, (reasonCounts.get(bucket) ?? 0) + 1);
}
for (const [reason, count] of reasonCounts) console.log(`匹配跳过(${count}): ${reason}`);
for (const {songId, reason} of matchSkipped.slice(0, 60)) console.log(`  跳过 ${songId}: ${reason}`);
if (matchSkipped.length > 60) console.log(`  ……其余 ${matchSkipped.length - 60} 条按上述归类`);
for (const failure of verifyFailures.slice(0, 20)) console.log(`  验证失败 ${failure.songId} ${failure.path}: ${failure.error}`);
