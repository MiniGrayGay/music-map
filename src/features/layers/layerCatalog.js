// 7.2 分层地图清单（/layers/manifest.json，scripts/build-layer-data.py 产出）
// 的接入层：拉取、严格校验、按地图投影并聚合成 Group→Floor→Layer 结构。
// 清单缺失或契约不符时整体 ABSENT，选择器与叠绘不出现，保持纯地图语义。
//
// 契约（teyvat-region-map.layers.v1，字段见 build-layer-data.py）：
//   { format, game:{version}, projection:{maps}, maps, groups, layers,
//     noImageLayers, coverage }
//   - layers[]：{layerId, groupId, floorId, floorLevel, floorLabel, name,
//     mapName, sceneId, image, width, height, left, top, right, bottom,
//     drawOrder:[..], region:{yRange}|null}
//   - left/top/right/bottom 是该地图画布像素（Teyvat 22528×19456，1024 块），
//     本应用世界画布是 256 块（5632×4864），显示坐标按投影比例换算
//     （Teyvat 即 ÷4；比例从 projection.maps[map].size 与应用画布推导，
//     不写死 4）；
//   - drawOrder 是数组，按字典序升序叠放（后者覆盖前者）；
//   - groups：{groupIdStr:{defaultFloorId, backgroundGroupIds?}}，背景组
//     随当前组一起显示并暗化垫底（工作室 LayeredMapControl 的做法）；
//   - maps：全部地图（Teyvat + 4 独立场景）。独立场景暂无底图，仅通过
//     maps 列表暴露 mapName/sceneId 供后续接入，绝不默默丢掉。
//
// 校验（fail-closed，参照 bgmStatus 逐条忽略并计数）：
//   - 清单缺失/非法 JSON/format 或 game.version 不符 → ABSENT；
//   - 当前应用地图（默认 Teyvat）投影比例推导不出或两轴不一致 → ABSENT；
//   - layers 行缺关键字段或数值非有限 → 忽略并计数；
//   - noImageLayers（当前客户端无贴图的层）保留计数，不进可选楼层；
//   - 单一地下层的组同样有效（可回地面＝退出分层），不做过滤。

export const LAYER_MANIFEST_URL = '/layers/manifest.json';
export const LAYER_CATALOG_STATUS = {
  ABSENT: 'absent', // 清单未就绪：不渲染选择器与叠绘
  READY: 'ready',
};

export const DEFAULT_APP_MAP = 'Teyvat'; // 本应用世界画布对应的 manifest 地图
export const DEFAULT_GAME_VERSION = '7.2.0';

export async function loadLayerCatalog(options = {}) {
  const {
    expectedGameVersion = DEFAULT_GAME_VERSION,
    appMapName = DEFAULT_APP_MAP,
    appCanvas = null, // {width, height} 应用世界画布（如 Teyvat 5632×4864）
    fetcher = fetch,
  } = options;
  let response;
  try {
    response = await fetcher(LAYER_MANIFEST_URL);
  } catch {
    return absent('清单请求失败');
  }
  if (!response.ok) return absent(`清单缺失（HTTP ${response.status}）`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    return absent('清单不是合法 JSON');
  }
  if (payload?.format !== 'teyvat-region-map.layers.v1') {
    return absent(`清单 format 不识别：${payload?.format ?? '(空)'}`);
  }
  if (payload.game?.version !== expectedGameVersion) {
    return absent(`清单版本 ${payload.game?.version ?? '(空)'} 与地图 ${expectedGameVersion} 不一致`);
  }
  if (!Array.isArray(payload.layers) || payload.layers.length === 0) {
    return absent('清单 layers 不是非空数组');
  }

  const projectionMaps = payload.projection?.maps;
  if (!projectionMaps || typeof projectionMaps !== 'object') {
    return absent('清单缺 projection.maps');
  }
  // 应用画布 ↔ 清单画布的投影比例：只对应用地图（默认 Teyvat）推导；
  // 其余地图保留在 maps 列表（等底图素材后由 setActiveMap 切换接入）。
  const scales = {};
  for (const [name, spec] of Object.entries(projectionMaps)) {
    const size = spec?.size;
    if (name === appMapName && appCanvas) {
      if (!Array.isArray(size) || size.length !== 2 || !(size[0] > 0) || !(size[1] > 0)) {
        return absent(`projection.maps.${name}.size 不合法`);
      }
      const fx = appCanvas.width / size[0];
      const fy = appCanvas.height / size[1];
      if (!(fx > 0) || fx > 1 || Math.abs(fx - fy) > 1e-9) {
        return absent(`projection.maps.${name} 比例与画布不一致（fx=${fx} fy=${fy}）`);
      }
      scales[name] = fx;
    } else {
      scales[name] = null;
    }
  }
  if (appCanvas && scales[appMapName] === undefined) {
    return absent(`projection.maps 缺应用地图 ${appMapName}`);
  }

  const manifestGroups = payload.groups && typeof payload.groups === 'object'
    ? payload.groups : {};

  const skipped = [];
  const seenLayerIds = new Set();
  const entries = [];
  for (const [index, raw] of payload.layers.entries()) {
    const entry = normalizeLayer(raw, index, scales, seenLayerIds, skipped);
    if (entry) entries.push(entry);
  }
  const noImage = Array.isArray(payload.noImageLayers) ? payload.noImageLayers.length : 0;
  if (entries.length === 0) {
    return absent(`清单无有效层（${skipped.length} 条被忽略）`);
  }

  const groupsByMap = buildGroups(entries, manifestGroups);
  const maps = buildMapsIndex(payload.maps, entries, scales, groupsByMap, appMapName);
  const appGroups = groupsByMap[appMapName] ?? [];
  if (appCanvas && appGroups.length === 0) {
    return absent(`应用地图 ${appMapName} 无有效分层组`);
  }
  return {
    status: LAYER_CATALOG_STATUS.READY,
    reason: null,
    gameVersion: payload.game.version,
    appMapName,
    maps, // [{name, sceneIds, groups, layerCount, projectable}] 全部地图都保留
    groupsByMap,
    appGroups,
    noImage,
    skipped: skipped.length,
    skippedReasons: skipped,
  };
}

function absent(reason) {
  return {
    status: LAYER_CATALOG_STATUS.ABSENT, reason, gameVersion: null,
    appMapName: null, maps: [], groupsByMap: {}, appGroups: [], noImage: 0,
    skipped: 0, skippedReasons: [],
  };
}

function isInt(value) {
  return Number.isInteger(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeDrawOrder(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined; // 形状不对 → 条目无效
  const parts = [];
  for (const item of value) {
    if (!finite(item)) return undefined;
    parts.push(item);
  }
  return parts;
}

function normalizeLayer(raw, index, scales, seenLayerIds, skipped) {
  const reject = (why) => {
    skipped.push(why);
    return null;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject(`layers[${index}] 不是对象`);
  }
  if (!isInt(raw.layerId)) return reject(`layers[${index}] 缺 layerId`);
  if (seenLayerIds.has(raw.layerId)) return reject(`layers[${index}] layerId 重复（${raw.layerId}）`);
  if (!isInt(raw.groupId)) return reject(`layers[${index}]（${raw.layerId}）缺 groupId`);
  if (!isInt(raw.floorId)) return reject(`layers[${index}]（${raw.layerId}）缺 floorId`);
  if (!isInt(raw.floorLevel)) return reject(`layers[${index}]（${raw.layerId}）floorLevel 非整数`);
  if (typeof raw.mapName !== 'string' || raw.mapName === '') {
    return reject(`layers[${index}]（${raw.layerId}）缺 mapName`);
  }
  if (typeof raw.image !== 'string' || raw.image === '') {
    return reject(`layers[${index}]（${raw.layerId}）缺 image`);
  }
  for (const field of ['left', 'top', 'right', 'bottom']) {
    if (!finite(raw[field])) return reject(`layers[${index}]（${raw.layerId}）${field} 不是有限数值`);
  }
  if (raw.right <= raw.left || raw.bottom <= raw.top) {
    return reject(`layers[${index}]（${raw.layerId}）bounds 非正`);
  }
  if (!isInt(raw.width) || !isInt(raw.height) || raw.width <= 0 || raw.height <= 0) {
    return reject(`layers[${index}]（${raw.layerId}）贴片尺寸无效`);
  }
  const drawOrder = normalizeDrawOrder(raw.drawOrder);
  if (drawOrder === undefined) {
    return reject(`layers[${index}]（${raw.layerId}）drawOrder 不是数值数组`);
  }
  let yRange = null;
  if (raw.region && raw.region.yRange !== undefined && raw.region.yRange !== null) {
    const pair = raw.region.yRange;
    if (!Array.isArray(pair) || pair.length !== 2 || !finite(pair[0]) || !finite(pair[1])) {
      return reject(`layers[${index}]（${raw.layerId}）region.yRange 不是 [minY, maxY]`);
    }
    yRange = [pair[0], pair[1]];
  }
  seenLayerIds.add(raw.layerId);
  const scale = scales[raw.mapName] ?? null;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null;
  return {
    layerId: raw.layerId,
    groupId: raw.groupId,
    floorId: raw.floorId,
    floorLevel: raw.floorLevel,
    floorLabel: typeof raw.floorLabel === 'string' && raw.floorLabel !== '' ? raw.floorLabel : `L${raw.floorLevel}`,
    name,
    mapName: raw.mapName,
    sceneId: isInt(raw.sceneId) ? raw.sceneId : null,
    url: new URL(`layers/${raw.image}`, document.baseURI).href,
    drawOrder,
    yRange,
    scale, // null = 该地图暂无底图投影（保留在目录中，不参与渲染）
    rect: scale === null ? null : {
      left: raw.left * scale,
      top: raw.top * scale,
      width: (raw.right - raw.left) * scale,
      height: (raw.bottom - raw.top) * scale,
    },
    pixelDensity: scale === null ? null : Math.min(
      raw.width / ((raw.right - raw.left) * scale),
      raw.height / ((raw.bottom - raw.top) * scale),
    ),
    rawBounds: [raw.left, raw.top, raw.right, raw.bottom],
  };
}

// 组名：楼层名的公共前缀（工作室 LayeredMapControl.commonGroupName 的移植）。
// 前缀不足时直接用代表楼层（-1/0/1 层优先）的真实名称，不拼接多个人造标题。
function commonGroupName(names, fallback = names[0]) {
  const unique = [...new Set(names)];
  if (unique.length === 1) return unique[0];
  let prefix = unique[0];
  for (const name of unique.slice(1)) {
    while (prefix && !name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  prefix = prefix.replace(/[·・\s的第—-]+$/u, '');
  if (prefix.length >= 4) return prefix;
  return fallback;
}

function floorRepresentativePriority(level) {
  // -1（地下一层）最具代表性，其次 0、1，再往下按深度。
  if (level === -1) return 0;
  if (level === 0) return 1;
  if (level === 1) return 2;
  return 3 + Math.abs(level);
}

function compareDrawOrder(a, b) {
  const length = Math.max(a.drawOrder.length, b.drawOrder.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.drawOrder[index] ?? 0;
    const right = b.drawOrder[index] ?? 0;
    if (left !== right) return left - right;
  }
  return a.layerId - b.layerId;
}

function buildGroups(entries, manifestGroups) {
  const byMap = new Map(); // mapName -> Map(groupKey -> group)
  for (const entry of entries) {
    let groups = byMap.get(entry.mapName);
    if (!groups) {
      groups = new Map();
      byMap.set(entry.mapName, groups);
    }
    let group = groups.get(entry.groupId);
    if (!group) {
      const meta = manifestGroups[String(entry.groupId)] ?? {};
      group = {
        key: String(entry.groupId),
        groupId: entry.groupId,
        defaultFloorId: isInt(meta.defaultFloorId) ? meta.defaultFloorId : null,
        backgroundGroupIds: Array.isArray(meta.backgroundGroupIds)
          ? meta.backgroundGroupIds.map(String) : [],
        floorsById: new Map(),
        nameEntries: [],
        floorLabels: new Set(),
        bbox: null, // rect 空间的并集（有投影时即显示坐标）
        projectable: true,
      };
      groups.set(entry.groupId, group);
    }
    let floor = group.floorsById.get(entry.floorId);
    if (!floor) {
      floor = {
        floorId: entry.floorId,
        level: entry.floorLevel,
        label: entry.floorLabel,
        name: entry.name,
        entries: [],
      };
      group.floorsById.set(entry.floorId, floor);
    }
    floor.entries.push(entry);
    if (entry.name) group.nameEntries.push({level: entry.floorLevel, name: entry.name});
    group.floorLabels.add(entry.floorLabel);
    if (entry.rect) {
      group.bbox = unionRect(group.bbox, entry.rect);
    } else {
      group.projectable = false;
    }
  }
  const byMapOut = {};
  for (const [mapName, groups] of byMap) {
    byMapOut[mapName] = [...groups.values()]
      .map((group) => {
        const floors = [...group.floorsById.values()]
          .sort((a, b) => a.level - b.level)
          .map((floor) => ({...floor, entries: [...floor.entries].sort(compareDrawOrder)}));
        const representative = [...group.nameEntries].sort(
          (a, b) => floorRepresentativePriority(a.level) - floorRepresentativePriority(b.level),
        )[0]?.name;
        const names = group.nameEntries.map((item) => item.name);
        return {
          key: group.key,
          groupId: group.groupId,
          defaultFloorId: group.defaultFloorId,
          backgroundGroupIds: group.backgroundGroupIds,
          label: names.length > 0 ? commonGroupName(names, representative) : `组 ${group.key}`,
          searchText: [...new Set(names)].join(' '),
          floorText: [...group.floorLabels].join(' / '),
          floors,
          defaultFloorLevel: resolveDefaultFloorLevel(group, floors),
          bbox: group.bbox,
          projectable: group.projectable,
        };
      })
      // 工作室同款排序：组名 localeCompare（zh-CN, numeric）。
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', {numeric: true}));
  }
  return byMapOut;
}

// 默认楼层（工作室 chooseDefaultFloor 的取值序）：defaultFloorId → -1 层 →
// 0 层 → |level| 最小。单层组同样得到自己的默认层。
function resolveDefaultFloorLevel(group, floors) {
  if (group.defaultFloorId !== null) {
    const match = floors.find((floor) => floor.floorId === group.defaultFloorId);
    if (match) return match.level;
  }
  return floors.find((floor) => floor.level === -1)?.level
    ?? floors.find((floor) => floor.level === 0)?.level
    ?? [...floors].sort((a, b) => Math.abs(a.level) - Math.abs(b.level))[0].level;
}

function unionRect(bbox, rect) {
  if (!bbox) {
    return {left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height};
  }
  return {
    left: Math.min(bbox.left, rect.left),
    top: Math.min(bbox.top, rect.top),
    right: Math.max(bbox.right, rect.left + rect.width),
    bottom: Math.max(bbox.bottom, rect.top + rect.height),
  };
}

// 全部地图索引：projectable = 该地图已有应用画布投影（当前仅应用地图）。
// 独立场景（无底图素材）保留 mapName/sceneIds/组数，供 provider 切换接入。
function buildMapsIndex(rawMaps, entries, scales, groupsByMap, appMapName) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.mapName, (counts.get(entry.mapName) ?? 0) + 1);
  }
  const names = new Set([...Object.keys(scales), ...counts.keys(), ...Object.keys(rawMaps ?? {})]);
  return [...names].sort().map((name) => {
    const meta = rawMaps?.[name] ?? {};
    const sceneIds = Array.isArray(meta.sceneIds) ? meta.sceneIds : [];
    const scale = scales[name] ?? null;
    return {
      name,
      sceneIds,
      layerCount: counts.get(name) ?? meta.layers ?? 0,
      groupCount: (groupsByMap[name] ?? []).length,
      projectable: scale !== null,
      isAppMap: name === appMapName,
    };
  });
}
