import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {musicClockState, resolveMusic} from '../src/features/bgm/musicGraph.js';
import {INITIAL_MUSIC_PREVIEW_VERSION, INITIAL_MUSIC_PREVIEWS} from '../src/features/bgm/verifiedTracks.js';
import {readMusicDuration, readMusicMedia, readMusicMediaIndex} from './wwise-bank.mjs';
import {buildMusicGraph, derivePlaylist, readMusicBanks, rebuildAreaPlaylists} from './wwise-music-graph.mjs';
import {readMusicClock} from './wwise-music-clock.mjs';
import {homeTitles} from './wwise-home-titles.mjs';

const {values: args} = parseArgs({options: {
  manifest: {type: 'string'}, 'audio-assets': {type: 'string'},
  'home-bgm-table': {type: 'string'}, textmap: {type: 'string'},
  'title-catalog': {type: 'string'},
}});
if (!args.manifest) throw new Error('需要 --manifest 指定原始音区清单');
if (Boolean(args['home-bgm-table']) !== Boolean(args.textmap)) {
  throw new Error('需要同时指定 --home-bgm-table 和 --textmap');
}
const manifest = JSON.parse(await readFile(args.manifest, 'utf8'), (_, value) => value === 0 ? 0 : value);
const root = args['audio-assets'] ?? manifest.source.clientAudioRoot;
const primary = manifest.verification.playlists.bankSha256;
const titleBanks = manifest.verification.trackTitles?.bankSha256 ?? {};
if (!root || !Object.keys(primary).length) throw new Error('清单缺少音频包来源');

const [playback, titles] = await Promise.all([
  readMusicBanks(root, primary), readMusicBanks(root, titleBanks),
]);
for (const {reference, version, recordCount, musicCount} of [...playback.banks, ...titles.banks]) {
  console.log(`${reference} 版本 ${version}，HIRC ${recordCount} 条，音乐 ${musicCount} 条`);
}
const source = JSON.parse(JSON.stringify(buildMusicGraph(playback.objects, manifest.musicGraph.root)));
const expected = manifest.musicGraph.nodes;
assert.deepEqual(Object.keys(source), Object.keys(expected), '入口可达节点不一致');
const counts = new Map();
for (const [id, node] of Object.entries(source)) {
  assert.deepEqual(node, expected[id], `节点 ${id} (${node.kind})`);
  counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
}
console.log(`可达音乐节点 ${Object.keys(source).length} 条与发布清单逐字段一致`, Object.fromEntries(counts));

const graph = {...manifest.musicGraph, nodes: source};
if (graph.clock) {
  const proof = manifest.verification.musicClock;
  assert.ok(proof?.banks, '昼夜曲线必须有初始化 Bank 的来源证据');
  const {clock, evidence} = await readMusicClock(root, Object.keys(proof.banks), graph);
  assert.deepEqual(evidence, proof, '音乐时段来源指纹');
  assert.deepEqual(clock, graph.clock, '音乐时段曲线参数');
  console.log(`音乐时段 ${clock.points.length} 个采样点与初始化 Bank 一致`);
}
// 原生曲单是生成器写入的 authored 数据：用同一 derivePlaylist/rebuildAreaPlaylists
// 逻辑从 Bank 重建后逐字段核对（sources、segments、path、unresolved、变体与模式状态）。
const areas = Object.values(manifest.music);
const replay = JSON.parse(JSON.stringify({music: manifest.music, verification: manifest.verification}));
replay.musicGraph = graph;
rebuildAreaPlaylists(replay);
for (const [state, area] of Object.entries(manifest.music)) {
  assert.deepEqual(replay.music[state].playlists, area.playlists, `状态 ${area.wwiseId} 原生曲单`);
}
console.log(`地点原生曲单 ${areas.length * Object.keys(graph.modes).length} 份与 Bank 推导逐字段一致`);

// 站内试听语义：resolveMusic 不传条件时，除昼夜镜像分区取 12:00 初始预设外，
// 播放结果必须等于原生默认曲单；预设差异只允许出现在探索模式、原生默认分支
// 缺失（无 sources 且唯一缺口为 noFallbackBranch）的分区上。
const clockGroup = graph.clock?.group;
const clockKeys = clockGroup !== undefined && clockGroup !== null
  ? [...new Set(graph.clock.points.map(([, key]) => key))]
    .filter((key) => key !== 0 && graph.groups?.[clockGroup]?.options?.[key])
  : [];
let presetCount = 0;
let previewCount = 0;
assert.equal(INITIAL_MUSIC_PREVIEW_VERSION, manifest.clientVersion, '初始试听清单版本与原客户端不一致');
const previewSegments = new Set(INITIAL_MUSIC_PREVIEWS.map(({id}) => String(id)));
for (const {wwiseId, playlists} of areas) {
  for (const [mode, native] of Object.entries(playlists)) {
    const {tracks, conditions, incomplete} = resolveMusic(graph, wwiseId, mode);
    assert.ok(conditions.every(({title, entries}) => title && entries.every(({label}) => label)));
    const actual = tracks.map(({id}) => id).join(',');
    if (actual === native.sources.join(',')) continue;
    // 站内补曲放行：只允许初始试听曲相加，且每首补曲必须对应图内真实存在、
    // issue 为 multipleSourcesPerSegment 的 segment 节点，并被该地点与模式的
    // native.unresolved.multipleSourcesPerSegment 原生默认路径列出，防止跨区
    // 错误混入；剥离补曲后的曲单必须与原生默认逐项一致，普通音轨与原生曲单
    // 的核对标准不放宽。
    const previews = tracks.filter(({id}) => previewSegments.has(String(id)));
    const rest = tracks.filter(({id}) => !previewSegments.has(String(id))).map(({id}) => id).join(',');
    const nativePreviewIds = new Set((native.unresolved?.multipleSourcesPerSegment ?? []).map(String));
    if (previews.length && rest === native.sources.join(',')
      && previews.every(({id}) => !Object.hasOwn(graph.media, String(id))
        && graph.nodes[String(id)]?.issue === 'multipleSourcesPerSegment'
        && nativePreviewIds.has(String(id)))) {
      previewCount += previews.length;
      continue;
    }
    assert.equal(mode, 'exploration', `状态 ${wwiseId} 的 ${mode} 试听曲单偏离原生默认`);
    assert.equal(native.sources.length, 0, `状态 ${wwiseId} 原生默认非空，试听不得偏离`);
    assert.deepEqual(Object.keys(native.unresolved ?? {}), ['noFallbackBranch'],
      `状态 ${wwiseId} 试听偏离只允许昼夜默认分支缺失`);
    assert.equal(incomplete, false, `状态 ${wwiseId} 预设试听不得残缺`);
    assert.ok(actual.length > 0, `状态 ${wwiseId} 预设试听不得为空`);
    const states = {[graph.zoneGroup]: wwiseId, [graph.modeGroup]: graph.modes.exploration};
    const byKey = new Map(clockKeys.map((key) =>
      [key, derivePlaylist(graph, {...states, [clockGroup]: key}).sources.join(',')]));
    assert.ok([...byKey.values()].includes(actual), `状态 ${wwiseId} 预设试听应来自某个昼夜键`);
    if (new Set(byKey.values()).size > 1) {
      const noon = clockKeys.includes(musicClockState(graph.clock, 720))
        ? musicClockState(graph.clock, 720) : clockKeys[0];
      assert.equal(byKey.get(noon), actual, `状态 ${wwiseId} 昼夜曲单不同时应取 12:00 所在时段`);
    }
    presetCount += 1;
  }
}
console.log(`地点默认试听 ${areas.length * Object.keys(graph.modes).length} 份与播放器一致（含 ${presetCount} 份 12:00 初始预设、${previewCount} 首站内补曲）`);
const cave = Object.values(manifest.floorViews ?? {}).flat().find(({name}) => name === '残辉岩窟');
if (cave?.inheritedFrom) {
  const area = manifest.music[cave.state];
  const local = manifest.volumes.find(({id}) => id === cave.inheritedFrom);
  assert.equal(cave.state, local.state, '残辉岩窟应沿用客户端中传送点命中的状态');
  assert.deepEqual(cave.lines, [], '残辉岩窟没有独立音区边线');
  const options = resolveMusic(graph, area.wwiseId, 'exploration').conditions;
  const dayNight = options.find(({title}) => title === '昼夜');
  assert.deepEqual(dayNight.entries.map(({label, count}) => [label, count]), [['白天', 9], ['夜间', 9]]);
  for (const {key} of dayNight.entries) {
    const {tracks, conditions} = resolveMusic(graph, area.wwiseId, 'exploration', {[dayNight.id]: key});
    assert.ok(tracks.every(({scope, arrangement}) => scope === 'zone' && arrangement?.selection === 'stepRandom'));
    assert.ok(conditions.every(({entries}) => entries.length <= 2), '全局覆盖不得泄漏进此楼层');
  }
}
const fontaine = manifest.music.State_FD40_City?.wwiseId;
if (manifest.clientVersion === '7.2.0' && fontaine) {
  const group = resolveMusic(graph, fontaine, 'exploration').conditions
    .find(({title}) => title === '昼夜');
  assert.ok(group);
  const phases = group.entries.map(({label, key}) => {
    const selection = resolveMusic(graph, fontaine, 'exploration', {[group.id]: key});
    assert.ok(selection.tracks.every(({name}) => name !== '轻雨何故落'));
    return [label, selection.tracks[0]?.name, selection.tracks.length];
  });
  assert.deepEqual(phases, [
    ['白天', '众水之诗', 4],
    ['夜间', '月夕花朝', 4],
  ]);
}

const mediaIds = Object.keys(graph.media).map(Number);
const media = await readMusicMediaIndex(root, mediaIds);
for (let offset = 0; offset < mediaIds.length; offset += 24) {
  await Promise.all(mediaIds.slice(offset, offset + 24).map(async (id) => {
    const actual = await readMusicDuration(media.get(id));
    assert.ok(Math.abs(actual - graph.media[id].duration) <= 0.1, `音源 ${id} 试听时长与原始 PCK 不符`);
  }));
}
console.log(`原始音乐 PCK 的 ${mediaIds.length} 个音源时长与试听清单一致`);

const soundtrack = manifest.verification.soundtrackTitles;
if (soundtrack) {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const catalog = await readFile(args['title-catalog'] ?? new URL('./verified-soundtrack-titles.json', import.meta.url));
  assert.equal(digest(catalog), soundtrack.catalogSha256, '曲名证据表指纹');
  const library = Object.entries(JSON.parse(catalog)).filter(([, item]) => item.gameLibrary);
  if (library.length) {
    const ids = [...new Set(library.map(([, item]) => item.gameLibrary.mediaId))];
    const recording = await readMusicMediaIndex(path.join(root, 'BeyondUGC'), ids, 'BeydMusic');
    for (const [id, {title, gameLibrary: proof}] of library) {
      const entry = recording.get(proof.mediaId);
      assert.equal('BeyondUGC/' + path.basename(entry.packagePath), proof.media);
      assert.equal(digest(await readMusicMedia(entry)), proof.mediaSha256, `音律库源录音 ${id}`);
      assert.equal(graph.media[id].title, title, `音律库曲名 ${id}`);
    }
    console.log(`音律库 ${library.length} 首参考录音与曲名证据一致`);
  }
}

if (args.textmap) {
  const evidence = manifest.verification.trackTitles;
  const titlesBySource = await homeTitles({
    tableFile: args['home-bgm-table'], textMapFile: args.textmap, evidence,
    objects: titles.objects, musicGraph: manifest.musicGraph,
  });
  assert.equal(titlesBySource.size, evidence.titleMatches);
  for (const [id, [title, state]] of titlesBySource) {
    assert.equal(manifest.musicGraph.media[id].title, title, `音源 ${id} 中文曲名`);
    assert.equal(manifest.musicGraph.media[id].titleState, state, `音源 ${id} 游戏内状态`);
  }
  console.log(`尘歌壶中文曲名 ${titlesBySource.size} 首与本地表及 Wwise 分支一致`);
}
