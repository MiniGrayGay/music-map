import {readFile,writeFile} from 'node:fs/promises';
import {derivePlaylist} from './wwise-music-graph.mjs';
import {musicClockState, resolveWwiseSwitch} from '../src/features/bgm/musicGraph.js';

const load = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
const [manifest, catalog, overseas] = await Promise.all([
  load('../dist/data/genshin-region-bgm.json'),
  load('../src/features/bgm/netease-tracks.json'),
  load('../src/features/bgm/overseas-ost.json'),
]);
const graph = manifest.musicGraph;
if (!graph?.clock?.group) throw new Error('分区试听生成所需的曲单缺少 Wwise 图');

const phasesJson = {day: 720, night: 23 * 60};
const published = id => catalog.tracks[id] && overseas[catalog.tracks[id].id];

// 原生 Wwise 决策路径枚举：在当前 runtime 树上，按 fixed（区/mode/昼夜）逐节点
// 精确枚举能命中当前 zone 分支的 selector 组合，替代旧的精确 zone 池 + 历史审计候选。
function localSelectorAssignments(graph, fixed) {
  const found = new Map(), seen = new Set();
  function walk(id, chosen, scoped) {
    const key = JSON.stringify([id, scoped, Object.entries(chosen).sort(([a], [b]) => Number(a) - Number(b))]);
    if (seen.has(key)) return;
    seen.add(key);
    const node = graph.nodes[id];
    if (node?.kind !== 'switch') {
      if (scoped && Object.keys(chosen).length) found.set(JSON.stringify(chosen), chosen);
      return;
    }
    if (node.mode !== 0) return;
    for (const [keys, target, probabilities] of node.leaves) {
      if (probabilities.some(p => p !== 100)) continue;
      const next = {...chosen};
      let valid = true;
      for (const [index, group] of node.groups.entries()) {
        const entry = keys[index];
        if (!entry) continue;
        const current = fixed[group] ?? next[group];
        if (current !== undefined && current !== entry) { valid = false; break; }
        if (!Object.hasOwn(fixed, group)) next[group] = entry;
      }
      if (!valid) continue;
      const selection = resolveWwiseSwitch(node, {...next, ...fixed}, graph.noneState);
      if (selection.target !== target) continue;
      const slot = node.groups.indexOf(graph.zoneGroup);
      walk(target, next, scoped || (slot >= 0 && selection.keys[slot] === fixed[graph.zoneGroup]));
    }
  }
  walk(graph.root, {}, false);
  return [...found.values()];
}

const output = {};
for (const [state, area] of Object.entries(manifest.music)) {
  const zone = area.wwiseId;
  if (!Number.isInteger(zone)) continue;
  const result = {};
  for (const [phase, minute] of Object.entries(phasesJson)) {
    const fixed = {
      [graph.zoneGroup]: zone,
      [graph.modeGroup]: graph.modes.exploration,
      [graph.clock.group]: musicClockState(graph.clock, minute),
    };
    const baseline = derivePlaylist(graph, fixed);
    if (baseline.sources.some(published)) continue;
    const found = new Set();
    const checked = new Set();
    for (const conditions of localSelectorAssignments(graph, fixed)) {
      const settings = {...conditions, ...fixed};
      const identity = JSON.stringify(settings);
      if (checked.has(identity)) continue;
      checked.add(identity);
      const branch = derivePlaylist(graph, settings);
      if (branch.unresolved || !branch.path?.length) continue;
      const changed = branch.path.findIndex((entry, index) =>
        entry.switch !== baseline.path?.[index]?.switch || entry.target !== baseline.path[index].target,
      );
      if (changed < 0) continue;
      // 首分歧前确实命中当前 zoneGroup，才认定是本区原生曲。
      const inZone = branch.path.slice(0, changed + 1).some(({switch: id, keys}) =>
        keys[graph.nodes[id].groups.indexOf(graph.zoneGroup)] === zone,
      );
      if (inZone) for (const id of branch.sources) if (published(id)) found.add(id);
    }
    if (found.size) result[phase] = [...found];
  }
  if (Object.keys(result).length) output[zone] = result;
}
if (!Object.keys(output).length) throw new Error('没有核验成功的分区试听曲目');
await writeFile(new URL('../src/features/bgm/authored-previews.json', import.meta.url), JSON.stringify(output) + '\n');
console.log(JSON.stringify({zones: Object.keys(output).length, phases: Object.values(output).reduce((n, x) => n + Object.keys(x).length, 0)}));
