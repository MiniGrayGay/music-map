// 区域 BGM 审计：以线上播放规则（musicGraph.js 的 resolveMusic /
// withVerifiedTrack / VERIFIED_TRACKS）为准，只读 dist/data/genshin-region-bgm.json
// 与 dist/region-bgm-audio/*.opus（仅对实际解析出的曲目 id 做存在性检查）。
// 默认只审计用户可达范围（入口地图 scenes + 可见楼层的 floorViews）；
// --all-data 回到全量数据审计。derivePlaylist 仅用来解释 miss/多轨的底层
// 原因，不另建平行解析规则。
// 输出简洁摘要；不写报告文件，--json 另输出受影响键和实际解析的音源。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveMusic, withVerifiedTrack, musicClockState} from '../src/features/bgm/musicGraph.js';
import {verifiedTrackFor} from '../src/features/bgm/verifiedTracks.js';
import {mapLabels} from '../src/features/layers/mapBases.js';
import {derivePlaylist} from './wwise-music-graph.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(root, 'dist', 'data', 'genshin-region-bgm.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.clientVersion !== '7.2.0') {
  throw new Error(`清单契约不匹配：schemaVersion=${manifest.schemaVersion} clientVersion=${manifest.clientVersion}`);
}
const graph = manifest.musicGraph;
const audioDir = path.join(root, 'dist', 'region-bgm-audio');
// 分类以用户实际听到的为准：
// - verifiedAssociation：核实曲目经 resolveMusic 实际兜底生效；
// - needsCondition：默认态有缺口，但播放器可选的命名条件（conditions.entries）
//   中存在能出曲的组合，用户能听到，不算丢曲；
// - resolvedEmpty：解析完整但无曲。是否作者刻意静音无法从图内证实，不越界命名；
// - missingWwiseNode / missingWwiseMedia / segmentMultiSource / switchUnresolved /
//   otherUnresolved：derivePlaylist 解释的硬缺口；
// - stateMissing：分区 state 不在清单 music 中。
const CATEGORIES = [
  'verifiedAssociation', 'needsCondition', 'resolvedEmpty', 'stateMissing',
  'missingWwiseNode', 'missingWwiseMedia', 'segmentMultiSource',
  'switchUnresolved', 'otherUnresolved',
];
const findings = Object.fromEntries(CATEGORIES.map((c) => [c, new Map()]));
const missingOpus = new Map(); // track id -> Set(affectedZoneKey)
const resolvedMedia = new Set();

const add = (category, zone, detail) => {
  if (!findings[category].has(zone.key)) findings[category].set(zone.key, {name: zone.name, view: zone.view, mode: zone.mode, detail});
};

const checkOpus = (entry, tracks) => {
  for (const track of tracks) {
    if (!Number.isInteger(track.id)) continue;
    resolvedMedia.add(track.id);
    if (!fs.existsSync(path.join(audioDir, `${track.id}.opus`))) {
      const bucket = missingOpus.get(track.id) ?? new Set();
      bucket.add(entry.key);
      missingOpus.set(track.id, bucket);
    }
  }
};

// 条件路径枚举：与 MusicPlayer 的真实可达面一致，逐组单独走（不做全局 group
// 笛卡尔积）：
// 1) resolveMusic 返回的 conditions.entries——播放器的高级选项按钮；
// 2) 昼夜组（condition.id === graph.clock.group，即 UI 的 hasClock）额外用已核实
//    曲线对 0..1439 分钟采样去重（含 0/00:00）——时刻滑杆可取任意分钟；曲线
//    未暴露昼夜按钮时不允许这些枚举。
// 每条路径独立 resolveMusic 并检查音频，因此默认态有曲时也能覆盖条件音频。
let defaultPathCount = 0;
let conditionPathCount = 0;
const conditionIncomplete = new Map(); // `${id}:${title}` -> 路径解析失败数

function auditConditionPaths(zoneGraph, wwiseId, mode, base) {
  const paths = []; // {label, group, result}
  const clockId = graph.clock?.group;
  for (const condition of base.conditions) {
    const options = new Map(condition.entries.map((e) => [e.key, e.label]));
    if (clockId !== undefined && clockId !== null && condition.id === clockId) {
      // 时刻滑杆覆盖曲线全部时段；minute 0 即 state 0（00:00）。
      for (let minute = 0; minute < 1440; minute += 1) {
        const key = musicClockState(graph.clock, minute);
        // key === 0（00:00）是时刻滑杆真实可取的最左端，即使组键未核实也必须
        // 纳入枚举；其余 key 仍要求已核实的组键存在。
        if (!options.has(key)) {
          if (key === 0) {
            options.set(0, '00:00');
          } else if (graph.groups?.[clockId]?.options?.[key]) {
            options.set(key, graph.groups[clockId].options[key]);
          }
        }
      }
    }
    for (const [key, label] of options) {
      const result = resolveMusic(zoneGraph, wwiseId, mode, {[condition.id]: key});
      conditionPathCount += 1;
      if (result.tracks.length === 0 || result.incomplete) {
        // 统计键带上选项 key 标签（如 =00:00），按 key 露出缺口；仍是
        // incompleteGroups 的字符串→计数结构。
        const statKey = `${condition.id}:${condition.title}=${label}`;
        conditionIncomplete.set(statKey, (conditionIncomplete.get(statKey) ?? 0) + 1);
      }
      paths.push({label: `${condition.title}=${label}`, group: `${condition.id}:${condition.title}`, result});
    }
  }
  return paths;
}

function auditZone(zone) {
  for (const mode of ['exploration', 'combat']) {
    const entry = {...zone, mode, key: `${zone.key}#${mode}`};
    const area = manifest.music[zone.state];
    if (!area) {
      add('stateMissing', entry, `state=${zone.state}`);
      continue;
    }
    // 楼层+区域匹配核实关联时，用与 musicView 相同的 withVerifiedTrack
    // 包装 graph，让 resolveMusic 实际执行兜底，而不是平行判断。
    const zoneGraph = zone.verified ? withVerifiedTrack(graph, zone.verified) : graph;
    const base = resolveMusic(zoneGraph, area.wwiseId, mode);
    defaultPathCount += 1;
    // 默认态与全部条件路径实际解析出的曲目（含核实曲目、部分 unresolved 时仍
    // 返回的播放源）都查 Opus。
    checkOpus(entry, base.tracks);
    // 核实兜底生效（resolveMusic 的核实分支按设计返回 incomplete:true，不算缺口）。
    if (zone.verified && base.tracks.some((t) => t.id === zone.verified.id)) {
      add('verifiedAssociation', entry, `floor=${zone.verified.floor} area=${zone.verified.area} id=${zone.verified.id}`);
      continue;
    }
    const paths = auditConditionPaths(zoneGraph, area.wwiseId, mode, base);
    for (const {result} of paths) checkOpus(entry, result.tracks);
    const playable = (r) => r.tracks.length > 0 && !r.incomplete;
    if (!playable(base)) {
      // 默认态有缺口，先于通用完整判断查条件：某个 UI 可操作条件能出完整曲，
      // 用户能听到，不算丢曲。
      const rescue = paths.find(({result}) => playable(result));
      if (rescue) {
        add('needsCondition', entry, rescue.label);
        continue;
      }
    }
    if (base.tracks.length > 0 && !base.incomplete) continue; // 用户可完整听到
    if (base.tracks.length === 0 && !base.incomplete) {
      add('resolvedEmpty', entry, 'resolved-empty');
      continue;
    }
    // 仍有缺口：用 derivePlaylist 解释底层原因（仅诊断，不作为播放规则）。
    const states = {
      ...(mode === 'combat' ? graph.combatDefaults : null),
      [graph.zoneGroup]: area.wwiseId,
      [graph.modeGroup]: graph.modes[mode],
    };
    const diagnostic = derivePlaylist(graph, states);
    const reasons = new Set(Object.keys(diagnostic.unresolved ?? {}));
    if (!reasons.size) {
      add('otherUnresolved', entry, 'resolveMusic-incomplete-but-derive-clean');
      continue;
    }
    const SWITCH_ISSUES = new Set(['noFallbackBranch', 'weightedSwitch', 'probabilisticSwitch']);
    if ([...reasons].every((r) => SWITCH_ISSUES.has(r))) add('switchUnresolved', entry, [...reasons].join(','));
    if (reasons.has('missingObject')) add('missingWwiseNode', entry, (diagnostic.unresolved.missingObject ?? []).slice(0, 3).join(','));
    if (reasons.has('missingMedia')) add('missingWwiseMedia', entry, (diagnostic.unresolved.missingMedia ?? []).slice(0, 3).join(','));
    if (reasons.has('multipleSourcesPerSegment')) add('segmentMultiSource', entry, (diagnostic.unresolved.multipleSourcesPerSegment ?? []).slice(0, 3).join(','));
    const rest = [...reasons].filter((r) => !SWITCH_ISSUES.has(r)
      && r !== 'missingObject' && r !== 'missingMedia' && r !== 'multipleSourcesPerSegment');
    if (rest.length) add('otherUnresolved', entry, rest.join(','));
  }
}

// 可达性以用户真实入口为准（与 App.vue/musicView 一致）：
// - 主世界 zones：Teyvat 入口始终可达；
// - scenes：仅「basemaps.json 里存在且在 mapLabels 白名单内」的地图对应的
//   sceneId 可达（mapBases.js loadLayerBases 的数据层门槛）；
// - floorViews：仅 layerFloor 能映射到 layers manifest 可见 layerId 的楼层键
//   可达（musicView 按 layerFloor[layerId] 取楼层）。
// 默认只审计可达范围；--all-data 回到全量数据审计。不可达条目单独计数，
// 不混入 findings。
function computeReachability() {
  const basemaps = JSON.parse(fs.readFileSync(
    path.join(root, 'dist', 'layers', 'basemaps.json'), 'utf8'));
  const reachableMaps = Object.keys(basemaps.maps ?? {})
    .filter((name) => Object.hasOwn(mapLabels, name) && name !== 'Teyvat');
  const sceneIds = new Set(reachableMaps
    .map((name) => String(manifest.maps?.[name]?.sceneId)).filter(Boolean));
  const layersManifest = JSON.parse(fs.readFileSync(
    path.join(root, 'dist', 'layers', 'manifest.json'), 'utf8'));
  const floorKeys = new Set();
  for (const layer of layersManifest.layers ?? []) {
    const floorKey = manifest.layerFloor?.[String(layer.layerId)];
    if (floorKey) floorKeys.add(floorKey);
  }
  return {sceneIds, floorKeys, reachableMaps};
}
const allData = process.argv.includes('--all-data');
const reachable = allData ? null : computeReachability();

// 全部可见视图：主世界 zones、可达场景 scenes、可达楼层 floorViews，
// 与 bgmStatus.js musicView 的遍历范围一致（floorViews 带 verified 兜底）。
let audited = 0;
const rows = [];
for (const zone of manifest.zones ?? []) rows.push({zone, view: 'Teyvat', key: `teyvat-${zone.id}`, verified: null});
for (const [sceneId, zones] of Object.entries(manifest.scenes ?? {})) {
  if (reachable && !reachable.sceneIds.has(sceneId)) continue;
  for (const zone of zones) rows.push({zone, view: `scene:${sceneId}`, key: `s${sceneId}-${zone.id}`, verified: null});
}
for (const [floorKey, zones] of Object.entries(manifest.floorViews ?? {})) {
  if (reachable && !reachable.floorKeys.has(floorKey)) continue;
  for (const zone of zones) rows.push({
    zone, view: `floor:${floorKey}`, key: `f${floorKey}-${zone.id}`,
    verified: typeof zone.id === 'number' ? verifiedTrackFor(floorKey, zone.id) : null,
  });
}
for (const {zone, view, key, verified} of rows) {
  if (!zone || typeof zone !== 'object') continue;
  audited += 1;
  auditZone({state: zone.state, name: zone.name, view, key, verified});
}

// 汇总：每类去重分区/素材规模 + 最多 3 样例，绝不展开整表。
const summary = {
  manifest: {clientVersion: manifest.clientVersion, schemaVersion: manifest.schemaVersion},
  scope: allData ? 'all-data' : 'reachable',
  auditedZones: audited,
  modesAudited: ['exploration', 'combat'],
  conditionPaths: {count: conditionPathCount, incompleteGroups: Object.fromEntries(conditionIncomplete)},
  ...(reachable ? {entryMaps: reachable.reachableMaps} : {}),
  ...(reachable ? {unreachableData: {
    sceneIds: [...(new Set(Object.keys(manifest.scenes ?? {})))].filter((s) => !reachable.sceneIds.has(s)),
    floorViewKeys: Object.keys(manifest.floorViews ?? {}).filter((k) => !reachable.floorKeys.has(k)).length,
  }} : {}),
  findings: Object.fromEntries(CATEGORIES.map((c) => {
    const bucket = findings[c];
    if (!bucket.size) return [c, {count: 0}];
    return [c, {count: bucket.size, samples: [...bucket.entries()].slice(0, 3).map(([key, v]) => ({key, ...v}))}];
  })),
  missingOpus: missingOpus.size
    ? {count: missingOpus.size, samples: [...missingOpus.entries()].slice(0, 3)
      .map(([id, keys]) => ({id, zones: keys.size, sampleKeys: [...keys].slice(0, 2)}))}
    : {count: 0},
};
if (process.argv.includes('--json')) {
  summary.findings = Object.fromEntries(CATEGORIES.map((c) => [c, {count: findings[c].size, keys: [...findings[c].keys()]}]));
  summary.missingOpus.items = [...missingOpus.keys()].sort((a, b) => a - b);
  summary.defaultPaths = defaultPathCount;
  summary.resolvedMediaIds = [...resolvedMedia].sort((a, b) => a - b);
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(JSON.stringify(summary));
}
