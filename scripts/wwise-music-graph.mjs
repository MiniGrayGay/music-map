import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {resolveWwiseSwitch} from '../src/features/bgm/musicGraph.js';
import {hircRecords, readWwiseBank} from './wwise-bank.mjs';
import {readMusicRecord} from './wwise-music.mjs';

export async function readMusicBanks(root, fingerprints) {
  const objects = new Map();
  const banks = [];
  for (const [reference, expected] of Object.entries(fingerprints)) {
    const match = /^(Banks\d+\.pck):0x([0-9a-f]{8})$/i.exec(reference);
    if (!match) throw new Error(`无效音频 Bank 记录 ${reference}`);
    const [, name, id] = match;
    const bytes = await readWwiseBank(path.join(root, name), Number.parseInt(id, 16));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`音频 Bank 指纹不符 ${reference}`);
    const version = bytes.readUInt32LE(8);
    let recordCount = 0;
    let musicCount = 0;
    for (const record of hircRecords(bytes)) {
      recordCount += 1;
      const node = readMusicRecord(record, version);
      if (!node) continue;
      musicCount += 1;
      const prior = objects.get(record.id);
      if (prior && !isDeepStrictEqual(prior, node)) {
        throw new Error(`音频 Bank ${reference} 的重复音乐节点 ${record.id} 内容不同`);
      }
      objects.set(record.id, node);
    }
    banks.push({reference, version, recordCount, musicCount});
  }
  return {objects, banks};
}

function* playlistSegments(items) {
  for (const item of items) {
    yield item.SegmentID;
    if (item.children) yield* playlistSegments(item.children);
  }
}

function musicSegment(node, objects) {
  const tracks = [];
  const sources = new Set();
  let issue;
  for (const id of node.trackIds) {
    const track = objects.get(id);
    if (!track) {
      issue = 'missingTrack';
      continue;
    }
    if (track.kind !== 'track') throw new Error(`音乐片段引用了非音轨节点 ${id}`);
    const {clips, type, parameters} = track;
    if (!clips.length) continue;
    const item = {id, type: [type], clips};
    if (Object.keys(parameters).length) item.parameters = parameters;
    tracks.push(item);
    for (const {sourceID} of clips) if (sourceID > 0) sources.add(sourceID);
  }
  if (!issue && sources.size > 1) issue = 'multipleSourcesPerSegment';
  const result = {kind: 'segment', tracks};
  if (issue) result.issue = issue;
  if (!issue && sources.size) result.source = [...sources][0];
  return result;
}

export function buildMusicGraph(objects, entry) {
  if (objects.get(entry)?.kind !== 'switch') throw new Error(`未找到入口决策树 ${entry}`);
  const nodes = {};
  function visit(id) {
    if (id <= 0 || Object.hasOwn(nodes, id)) return;
    const node = objects.get(id);
    if (!node) {
      nodes[id] = {kind: 'missing'};
      return;
    }
    if (node.kind === 'segment') {
      nodes[id] = musicSegment(node, objects);
      return;
    }
    const {kind, transitions} = node;
    const next = [];
    if (kind === 'switch') {
      const {groups, groupTypes, mode, leaves} = node;
      nodes[id] = {kind, groups, mode, groupTypes, leaves};
      next.push(...leaves.map(([, target]) => target));
    } else if (kind === 'playlist') {
      nodes[id] = {kind, items: node.items};
      next.push(...playlistSegments(node.items));
    } else {
      throw new Error(`音乐入口直接引用了非片段节点 ${id} (${kind})`);
    }
    if (transitions.length) nodes[id].transitions = transitions;
    for (const {AkMusicTransitionObject} of transitions) {
      if (AkMusicTransitionObject) next.push(AkMusicTransitionObject.segmentID);
    }
    for (const target of next) visit(target);
  }
  visit(entry);
  return nodes;
}

export function derivePlaylist(graph, states) {
  const path = [];
  const sources = new Map();
  const unresolved = new Map();
  const active = new Set();
  function markIssue(reason, id) {
    if (!unresolved.has(reason)) unresolved.set(reason, new Set());
    unresolved.get(reason).add(id);
  }
  function playItems(items) {
    for (const item of items) {
      if (item.children?.length) playItems(item.children);
      else visit(item.SegmentID);
    }
  }
  function visit(id) {
    if (id <= 0) return;
    if (active.has(id)) throw new Error(`音乐节点循环引用 ${id}`);
    active.add(id);
    const node = graph.nodes[id];
    if (!node || node.kind === 'missing') {
      markIssue('missingObject', id);
    } else if (node.kind === 'switch') {
      const {keys, target, issue} = resolveWwiseSwitch(node, states, graph.noneState);
      if (issue) markIssue(issue, id);
      else {
        path.push({switch: id, keys, target});
        visit(target);
      }
    } else if (node.kind === 'playlist') {
      playItems(node.items);
    } else if (node.kind === 'segment') {
      if (node.issue) markIssue(node.issue, id);
      if (node.source) {
        if (!Object.hasOwn(graph.media, node.source)) markIssue('missingMedia', node.source);
        else if (!sources.has(node.source)) sources.set(node.source, id);
      }
    } else {
      markIssue('unsupportedObject', id);
    }
    active.delete(id);
  }
  visit(graph.root);
  const result = {sources: [...sources.keys()]};
  if (path.length) result.path = path;
  if (sources.size) result.segments = [...sources.values()];
  if (unresolved.size) {
    result.unresolved = Object.fromEntries([...unresolved].map(([key, ids]) =>
      [key, [...ids].sort((a, b) => a - b)]));
  }
  return result;
}

export function rebuildAreaPlaylists(manifest) {
  const graph = manifest.musicGraph;
  const paired = manifest.verification.playlists.pairedCondition;
  for (const area of Object.values(manifest.music)) {
    const states = {[graph.zoneGroup]: area.wwiseId};
    area.playlists = Object.fromEntries(Object.entries(graph.modes).map(([mode, key]) => [
      mode, derivePlaylist(graph, {
        ...(mode === 'combat' ? graph.combatDefaults : {}),
        ...states, [graph.modeGroup]: key,
      }),
    ]));
    if (!paired) continue;
    const [group, keys] = paired;
    const base = area.playlists.exploration;
    const fingerprint = ({sources}) => sources.toSorted((a, b) => a - b).join(',');
    const seen = new Set([fingerprint(base)]);
    for (const key of keys) {
      const choice = derivePlaylist(graph, {
        ...states, [graph.modeGroup]: graph.modes.exploration, [group]: key,
      });
      const mark = fingerprint(choice);
      if (!mark || seen.has(mark)) continue;
      seen.add(mark);
      const label = graph.groups?.[group]?.options?.[key];
      (base.variants ??= []).push({...choice, condition: [group, key], ...(label ? {label} : {})});
    }
    // 已证隐藏分支：探索默认解析完全无曲、无变体且无失败项（链路完整落在唯一的
    // 空默认分支）时，若链路上存在单父级、只绑一个未命名条件组的开关，把它的
    // 非默认键解析为可试听变体。组名与游戏触发条件未知，label 用「变体 N」，
    // 不猜名字；默认分支保持空，不让未知条件成为全局默认。
    if (!base.sources.length && !base.variants?.length && !base.unresolved) {
      const named = new Set([graph.zoneGroup, graph.modeGroup,
        ...(paired ? [paired[0]] : []), ...Object.keys(graph.groups ?? {}).map(Number)]);
      const parents = new Map();
      for (const node of Object.values(graph.nodes)) {
        for (const [, target] of node.leaves ?? []) parents.set(target, (parents.get(target) ?? 0) + 1);
      }
      for (const step of base.path ?? []) {
        const node = graph.nodes[step.switch];
        if (node?.kind !== 'switch' || node.groups?.length !== 1
          || named.has(node.groups[0]) || parents.get(step.switch) !== 1) continue;
        const group = node.groups[0];
        let index = 0;
        for (const [keys] of node.leaves) {
          const key = keys[0];
          if (key === graph.noneState) continue;
          const choice = derivePlaylist(graph, {
            ...states, [graph.modeGroup]: graph.modes.exploration, [group]: key,
          });
          if (!choice.sources.length) continue;
          index += 1;
          (base.variants ??= []).push({...choice, condition: [group, key], label: `变体 ${index}`});
        }
        if (base.variants?.length) break;
      }
    }
  }
}
