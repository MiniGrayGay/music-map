import {audioUrl} from './audioUrl.js';

const isWildcard = (key) => key === 0;
const playlistId = (tracks) => tracks.map(({id}) => id).join(',');
const switchIndex = new WeakMap();
const randomModes = new Map([[2, 'continuousRandom'], [3, 'stepRandom']]);

function indexedSwitch(node) {
  if (switchIndex.has(node)) return switchIndex.get(node);
  const tree = {children: new Map()};
  for (const [keys, target, probabilities] of node.leaves) {
    let branch = tree;
    for (const key of keys) {
      if (!branch.children.has(key)) branch.children.set(key, {children: new Map()});
      branch = branch.children.get(key);
    }
    branch.matches ??= [];
    if (branch.matches.length < 2) branch.matches.push({keys, target, probabilities});
  }
  switchIndex.set(node, tree);
  return tree;
}

function findSwitchMatch(branch, keys, index = 0) {
  if (!branch) return null;
  if (index === keys.length) return branch.matches;
  const exact = keys[index] ? findSwitchMatch(branch.children.get(keys[index]), keys, index + 1) : null;
  // An exact key outranks the wildcard at the first position where they differ.
  return exact ?? findSwitchMatch(branch.children.get(0), keys, index + 1);
}

export function resolveWwiseSwitch(node, states, noneState) {
  const requested = node.groups.map((group) => states[group] || noneState);
  const [top, next] = findSwitchMatch(indexedSwitch(node), requested) ?? [];
  if (!top) return {issue: 'noFallbackBranch'};
  if (node.mode !== 0) return {issue: 'weightedSwitch'};
  if ((next && next.target !== top.target) || top.probabilities.some((chance) => chance < 100)) {
    return {issue: 'probabilisticSwitch'};
  }
  return top;
}

export function trackDetails(id, graph) {
  const data = graph.media[id];
  return data ? {id, name: data.title, assetName: data.name, duration: data.duration,
    url: audioUrl(id, graph.audioBaseUrl)} : null;
}

function evaluate(graph, location, mode, overrides, discover) {
  const locked = {[graph.zoneGroup]: location, [graph.modeGroup]: graph.modes[mode]};
  const preferred = {...(mode === 'combat' ? graph.combatDefaults : null), ...overrides};
  const states = {...preferred, ...locked};
  const options = new Map();
  const tracks = new Map();
  const unknown = new Set();
  const seen = new Set();

  function musicItem(item, local, playlist, position, inheritedMode) {
    if (item.children?.length) {
      const selection = randomModes.get(item.eRSType) ?? inheritedMode;
      item.children.forEach((child, index) => musicItem(
        child, local, playlist, `${position}/${index}`, selection,
      ));
    } else {
      visit(item.SegmentID, local, {playlist, position, selection: inheritedMode});
    }
  }

  function visit(id, local = false, arrangement = null) {
    if (!id || id === 0xffffffff || seen.has(id)) return;
    seen.add(id);
    const node = graph.nodes[id];
    if (!node || node.kind === 'missing' || node.kind === 'unsupported') {
      unknown.add(id);
      return;
    }
    if (node.kind === 'switch') {
      const zoneSlot = node.groups.indexOf(graph.zoneGroup);
      if (discover) {
        const global = node.groups.map((group) => locked[group]);
        const authored = node.leaves.filter(([keys]) => keys.every(
          (key, index) => isWildcard(key) || global[index] === undefined || key === global[index],
        ));
        node.groups.forEach((group, index) => {
          const definition = graph.groups?.[group];
          if (global[index] !== undefined || !definition?.name) return;
          const choices = options.get(group) ?? new Set();
          for (const [keys] of authored) {
            const key = keys[index];
            if (key && definition.options?.[key]) choices.add(key);
          }
          if (choices.size) options.set(group, choices);
        });
      }
      const choice = resolveWwiseSwitch(node, states, graph.noneState);
      if (choice.issue) {
        unknown.add(id);
        return;
      }
      const targetLocal = zoneSlot >= 0 && choice.keys[zoneSlot] === location;
      visit(choice.target, local || targetLocal);
    } else if (node.kind === 'playlist') {
      node.items.forEach((item, index) => musicItem(item, local, id, String(index), null));
    } else if (node.source) {
      const track = trackDetails(node.source, graph);
      if (track) {
        const current = tracks.get(track.id);
        if (!current || (local && current.scope === 'fallback')) {
          tracks.set(track.id, {...track, scope: local ? 'zone' : 'fallback', arrangement});
        }
      } else {
        unknown.add(id);
      }
    } else if (node.issue) {
      unknown.add(id);
    }
  }

  visit(graph.root);
  return {tracks: [...tracks.values()], options, preferred, incomplete: unknown.size > 0};
}

export function resolveMusic(graph, location, mode, overrides = {}) {
  if (!Number.isSafeInteger(location) || !Object.hasOwn(graph.modes, mode)) {
    return {tracks: [], conditions: [], incomplete: true};
  }
  const scopedOverrides = {};
  let resolved = evaluate(graph, location, mode, scopedOverrides, true);
  let advanced;
  do {
    advanced = false;
    for (const [id, key] of Object.entries(overrides)) {
      if (Object.hasOwn(scopedOverrides, id) || !resolved.options.get(Number(id))?.has(key)) continue;
      scopedOverrides[id] = key;
      advanced = true;
    }
    if (advanced) resolved = evaluate(graph, location, mode, scopedOverrides, true);
  } while (advanced);
  const conditions = [];
  for (const [id, keys] of resolved.options) {
    const initial = mode === 'combat' ? graph.combatDefaults[id] : undefined;
    const title = graph.groups[id].name;
    const variants = new Map();
    for (const key of keys) {
      const label = graph.groups[id].options[key];
      const choice = evaluate(graph, location, mode, {...scopedOverrides, [id]: key}, false);
      const fingerprint = playlistId(choice.tracks);
      if (!fingerprint && choice.incomplete) continue;
      if (variants.has(fingerprint)) continue;
      variants.set(fingerprint, {
        key,
        label,
        firstTrack: choice.tracks.find((track) => track.name)?.name ?? null,
        count: choice.tracks.length,
      });
    }
    if (variants.size < 2) continue;
    const entries = [...variants.values()].sort((a, b) => Number(b.label === '白天') - Number(a.label === '白天'));
    const current = playlistId(resolved.tracks);
    const value = variants.get(current)?.key ?? resolved.preferred[id] ?? initial ?? 0;
    conditions.push({
      id,
      title,
      named: true,
      value,
      entries,
    });
  }
  return {tracks: resolved.tracks, conditions, incomplete: resolved.incomplete};
}
