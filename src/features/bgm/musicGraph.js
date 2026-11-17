import {audioUrl} from './audioUrl.js';
import {initialPreviewFor} from './verifiedTracks.js';

const isWildcard = (key) => key === 0;
const playlistId = (tracks) => tracks.map(({id}) => id).join(',');
const switchIndex = new WeakMap();
// 经核实的探索备用曲：绑定在 graph 包装对象上（浅拷贝原字段，不改原图），
// 仅在 resolveMusic 探索模式无 zone 作用域曲目（只剩通配 fallback）时生效。
const verifiedEncore = new WeakMap();

export function withVerifiedTrack(graph, track) {
  if (!graph || !track) return graph;
  const wrapper = {...graph};
  verifiedEncore.set(wrapper, track);
  return wrapper;
}
const randomModes = new Map([[2, 'continuousRandom'], [3, 'stepRandom']]);

export function musicClockState(clock, minute) {
  // Wwise stores the switch breakpoints as single-precision values.
  const hour = Math.fround(minute / 60);
  let state = 0;
  for (const [start, key] of clock.points) {
    if (start > hour) break;
    state = key;
  }
  return state;
}

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
  // 仅内部使用的失败原因集合，用于区分缺口种类，不随 resolveMusic 对外返回。
  const issues = new Set();
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
      issues.add(node ? node.kind : 'missingObject');
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
        issues.add(choice.issue);
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
        issues.add('missingMedia');
        unknown.add(id);
      }
    } else if (node.issue === 'multipleSourcesPerSegment' && initialPreviewFor(id)) {
      // 站内渲染的初始试听补曲：仅对该 issue 且清单有据的 segment 生效，
      // 与普通音轨走同一 scope/arrangement 与去重逻辑；渲染产物随静态站点
      // 同目录发布，用同站绝对路径。其余失败路径保留原 issue。
      const preview = initialPreviewFor(id);
      const current = tracks.get(preview.id);
      if (!current || (local && current.scope === 'fallback')) {
        tracks.set(preview.id, {
          id: preview.id,
          name: preview.name,
          duration: preview.duration,
          url: audioUrl(preview.id, graph.supplementAudioBaseUrl ?? ''),
          scope: local ? 'zone' : 'fallback',
          arrangement,
        });
      }
    } else if (node.issue) {
      issues.add(node.issue);
      unknown.add(id);
    }
  }

  visit(graph.root);
  return {tracks: [...tracks.values()], options, preferred, issues, incomplete: unknown.size > 0};
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
  // 窄规则：默认探索完全无曲，且缺口唯一原因是 noFallbackBranch（昼夜组未定
  // 导致通配分支缺失）时，若已证的昼夜组在该地点恰有两个非零有效键可选择，
  // 且分别解析均完整、非空、为同一个区域作用域播放序列，说明昼夜只是镜像
  // 差异，直接采用该共同结果；variants 因结果相同而隐藏的昼夜按钮继续隐藏。
  // 用户显式为该组设值（含 0/00:00）时不生效，其他失败原因一律保留原结果。
  if (mode === 'exploration' && resolved.tracks.length === 0 && resolved.incomplete
    && resolved.issues.size > 0 && [...resolved.issues].every((issue) => issue === 'noFallbackBranch')) {
    const clockId = graph.clock?.group;
    const clockOptions = clockId !== undefined && clockId !== null
      ? graph.groups?.[clockId]?.options : null;
    const explicitClock = Object.keys(overrides).map(Number).includes(Number(clockId));
    if (clockOptions && !explicitClock && !Object.hasOwn(scopedOverrides, clockId)) {
    const selectable = resolved.options.get(clockId);
    // 有效键只取自已核实的 clock.points 断点值，不凭 group.options 推断未证时段。
    const keys = [...new Set(graph.clock.points.map(([, key]) => key))]
      .filter((key) => key !== 0 && clockOptions[key] && selectable?.has(key));
    if (keys.length === 2) {
      const dayChoice = evaluate(graph, location, mode, {...scopedOverrides, [clockId]: keys[0]}, false);
      const nightChoice = evaluate(graph, location, mode, {...scopedOverrides, [clockId]: keys[1]}, false);
        // 两键都完整解析且产物终点都是零 SegmentID：该分区昼夜确实无探索曲，
        // 是确证空而非解析缺口。返回确证空结果，不猜分区、不触发兜底曲。
        const confirmedEmpty = (choice) => choice && !choice.incomplete
          && choice.tracks.length === 0;
        if (confirmedEmpty(dayChoice) && confirmedEmpty(nightChoice)) {
          return {tracks: [], conditions, incomplete: false};
        }
        const zoneOnly = (choice) => choice && !choice.incomplete
          && choice.tracks.length > 0 && choice.tracks.every((track) => track.scope === 'zone');
        if (zoneOnly(dayChoice) && zoneOnly(nightChoice)) {
          // 曲单相同：昼夜只是镜像差异，直接采用共同结果，昼夜按钮继续隐藏。
          if (playlistId(dayChoice.tracks) === playlistId(nightChoice.tracks)) {
            return {tracks: dayChoice.tracks, conditions, incomplete: false};
          }
          // 曲单不同：这是站内初始试听预设（取 12:00 所在时段），不是原生游戏
          // 默认触发。仅把昼夜 condition.value 指到实际采用的键，用户仍可切换。
          const presetKey = keys.includes(musicClockState(graph.clock, 720))
            ? musicClockState(graph.clock, 720) : keys[0];
          const presetChoice = presetKey === keys[1] ? nightChoice : dayChoice;
          const condition = conditions.find(({id}) => id === clockId);
          if (condition) condition.value = presetKey;
          return {tracks: presetChoice.tracks, conditions, incomplete: false};
        }
      }
    }
  }
  // 兜底条件：探索模式且没有任何 zone 作用域曲目（只剩通配 fallback），
  // 说明该分区在图中没有自己的探索曲；有真实区域曲的分区完全走原逻辑。
  if (mode === 'exploration' && !resolved.tracks.some((track) => track.scope === 'zone')) {
    const verified = verifiedEncore.get(graph);
    if (verified) {
      return {
        tracks: [{
          id: verified.id,
          name: verified.name,
          duration: verified.duration,
          // 已核实兜底曲随静态站点整组导出，必须用同站绝对路径而非外部音频基址。
          url: audioUrl(verified.id, graph.supplementAudioBaseUrl ?? ''),
          scope: 'zone',
        }],
        // 通配 fallback 的条件（如昼夜）对核实曲目无效，不展示。
        conditions: [],
        incomplete: true,
      };
    }
  }
  return {tracks: resolved.tracks, conditions, incomplete: resolved.incomplete};
}
