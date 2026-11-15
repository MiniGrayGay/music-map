import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolveMusic} from '../src/features/bgm/musicGraph.js';
import {buildMusicGraph, readMusicBanks} from './wwise-music-graph.mjs';
import {homeTitles} from './wwise-home-titles.mjs';

const {values: args} = parseArgs({options: {
  manifest: {type: 'string'}, 'audio-assets': {type: 'string'},
  'home-bgm-table': {type: 'string'}, textmap: {type: 'string'},
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
const areas = Object.values(manifest.music);
for (const {wwiseId, playlists} of areas) {
  for (const [mode, expectedList] of Object.entries(playlists)) {
    const {tracks, alternatives} = resolveMusic(graph, wwiseId, mode);
    assert.deepEqual(tracks.map(({id}) => id), expectedList.sources, `状态 ${wwiseId} 的 ${mode} 曲单`);
    const defaultId = tracks.map(({id}) => id).join(',');
    assert.equal(new Set(alternatives.map(({id}) => id)).size, alternatives.length);
    assert.ok(alternatives.every(({id, tracks}) => id !== defaultId
      && id === tracks.map((track) => track.id).join(',')));
  }
}
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
    return [label, selection.tracks[0]?.name, selection.tracks.length,
      selection.alternatives.map(({tracks}) => tracks.map(({name}) => name))];
  });
  assert.deepEqual(phases, [
    ['白天', '众水之诗', 4, [['轻雨何故落']]],
    ['夜间', '月夕花朝', 4, [['轻雨何故落']]],
  ]);
}
console.log(`地点默认曲单 ${areas.length * Object.keys(graph.modes).length} 份与播放器一致`);

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
