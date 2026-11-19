import {markRaw} from 'vue';
import {fetchMapDocument, mapDocument} from '../map/releaseData.js';
import {audioUrl, normalizeAudioBase} from './audioUrl.js';
import {projectRings, ringsBBox, ringsPathData} from './zoneGeometry.js';
import {normalizeGameStates, withVerifiedTrack} from './musicGraph.js';
import {displayRegionName, geographicName} from './regionNames.js';
import {verifiedTrackFor} from './verifiedTracks.js';

export const BGM_STATUS = {
  LOADING: 'loading',
  UNAVAILABLE: 'unavailable',
  READY: 'ready',
};

export async function loadRegionBgm(expectedClientVersion) {
  let response;
  try {
    response = await fetchMapDocument(mapDocument.music);
  } catch {
    return verifying('清单请求失败');
  }
  if (!response.ok) return verifying(`清单缺失（HTTP ${response.status}）`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    return verifying('清单不是合法 JSON');
  }
  if (payload?.schemaVersion !== 1) return verifying('清单契约不匹配（schemaVersion≠1）');
  if (payload.sceneId !== 3) return verifying(`清单契约不匹配（sceneId=${payload.sceneId}）`);
  if (!Array.isArray(payload.zones)) return verifying('清单契约不匹配（zones 不是数组）');
  if (payload.clientVersion !== expectedClientVersion) {
    return verifying(`清单版本 ${payload.clientVersion ?? '(空)'} 与地图 ${expectedClientVersion} 不一致`);
  }
  if (payload.musicGraph) {
    try {
      payload.musicGraph.audioBaseUrl = normalizeAudioBase(payload.musicGraph.audioBaseUrl);
      payload.musicGraph.supplementAudioBaseUrl = normalizeAudioBase(payload.musicGraph.supplementAudioBaseUrl);
    } catch {
      return verifying('清单音频地址不受支持');
    }
    markRaw(payload.musicGraph);
  }
  const {items: zones, skipped} = normalizeView(payload.zones, payload, {
    sceneId: payload.sceneId,
    areaNames: areaNameIndex(payload),
  });
  if (zones.length === 0) return verifying(`清单无有效音乐分区（${skipped.length} 条被忽略）`);
  return {
    status: BGM_STATUS.READY,
    reason: null,
    zones,
    skipped: skipped.length,
    clientVersion: payload.clientVersion,
    payload,
  };
}

// 楼层分区的 inheritedFrom（区域 areaId）→ 来源分区名。只做 UI 展示元数据，
// 不参与音乐解析；来源不可解释时保持 null，不猜测。
function areaNameIndex(payload) {
  const names = new Map();
  for (const row of payload.zones ?? []) {
    if (!row || typeof row.name !== 'string') continue;
    const areaId = typeof row.id === 'string' ? row.id.split(':')[0] : row.id;
    const name = geographicName(displayRegionName(row, payload.clientVersion, payload.sceneId));
    if (name && areaId !== undefined && !names.has(String(areaId))) names.set(String(areaId), name);
  }
  return names;
}

function normalizeView(rows, {music, musicGraph, clientVersion}, options) {
  const {origin, prefix = ''} = options;
  // fail-closed：origin 只允许 undefined（默认投影）或二元数值数组，其他
  // 类型立即报错，防止参数错位静默产出 NaN 路径。
  if (origin !== undefined
    && !(Array.isArray(origin) && origin.length === 2
      && Number.isFinite(origin[0]) && Number.isFinite(origin[1]))) {
    throw new TypeError(`音乐分区投影 origin 不合法：${JSON.stringify(origin)}`);
  }
  const items = [];
  const skipped = [];
  const keys = new Set();
  for (const [index, raw] of rows.entries()) {
    const zone = normalizeZone(raw, index, keys, skipped, music, musicGraph, clientVersion, options);
    if (zone) items.push({...zone, key: prefix + zone.key});
  }
  return {items, skipped};
}

export function musicView(bgm, mapName, layerIds, floorSelected, layerPieces = []) {
  if (bgm.status !== BGM_STATUS.READY) return [];
  const payload = bgm.payload;
  if (!payload) return mapName === 'Teyvat' ? bgm.zones : [];
  const map = payload.maps?.[mapName];
  if (!map && mapName !== 'Teyvat') return [];
  const origin = map?.origin;
  const sceneId = map?.sceneId ?? payload.sceneId;
  const areaNames = areaNameIndex(payload);
  if (floorSelected) {
    const floorKeys = [...new Set(layerIds.map((id) => payload.layerFloor?.[id]).filter(Boolean))];
    return floorKeys.flatMap((id) => {
      const names = new Set(layerPieces
        .filter(({layerId}) => payload.layerFloor[layerId] === id)
        .map(({name}) => geographicName(name)).filter(Boolean));
      const floorName = names.size === 1 ? [...names][0] : null;
      const {items} = normalizeView(payload.floorViews?.[id] ?? [], payload, {
        origin, areaNames, sceneId, floorName, prefix: `layer-${id}-`,
      });
      return items.map((zone) => {
        // 核实备用曲同时匹配楼层和区域 id。
        const verified = verifiedTrackFor(id, typeof zone.id === 'number' ? zone.id : null);
        return verified ? {...zone, graph: markRaw(withVerifiedTrack(zone.graph, verified))} : zone;
      });
    });
  }
  if (mapName === 'Teyvat') return bgm.zones;
  return normalizeView(payload.scenes?.[sceneId] ?? [], payload, {origin, areaNames, sceneId}).items;
}

function verifying(reason) {
  return {status: BGM_STATUS.UNAVAILABLE, reason, zones: [], skipped: 0, clientVersion: null};
}

function normalizeZone(raw, index, keys, skipped, music, graph, clientVersion,
  {origin, areaNames, sceneId, floorName}) {
  const reject = (why) => {
    skipped.push(why);
    return null;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject(`zones[${index}] 不是对象`);
  const {id, name, rings} = raw;
  const idOk = Number.isInteger(id) || (typeof id === 'string' && id !== '');
  if (!idOk) return reject(`zones[${index}] 缺 id`);
  const key = String(id);
  if (keys.has(key)) return reject(`zones[${index}] id 重复（${key}）`);
  if (typeof name !== 'string' || name.trim() === '') return reject(`zones[${index}]（${key}）缺 name`);
  if (!Array.isArray(rings) || rings.length === 0) return reject(`zones[${index}]（${key}）缺 rings`);
  const cleanRings = [];
  for (const [ringIndex, ring] of rings.entries()) {
    if (!Array.isArray(ring) || ring.length < 3) {
      return reject(`zones[${index}]（${key}）ring[${ringIndex}] 顶点不足 3 个`);
    }
    const points = [];
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2
        || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        return reject(`zones[${index}]（${key}）ring[${ringIndex}] 顶点不是 [worldX, worldZ] 数值对`);
      }
      points.push([point[0], point[1]]);
    }
    cleanRings.push(points);
  }
  const exploration = normalizePlaylist(music?.[raw.state]?.playlists?.exploration, graph?.audioBaseUrl);
  // 清单 raw.gameMusicStates（可选）：复用 musicGraph 的同一份归一化实现，
  // 含显式 0 值；归一化后为空（缺字段或条目全非法）则不携带字段，保持原
  // 数据形状。判定只在 musicGraph，regionalPlaylist 门控同用此函数。
  const gameMusicStates = normalizeGameStates(raw.gameMusicStates);
  const zone = {
    key,
    id,
    name: displayRegionName(raw, clientVersion, sceneId, floorName),
    // 楼层分区可带 inheritedFrom（来源区域 areaId）；解析成来源分区名供 UI
    // 展示，缺失或对不上时为 null。
    inheritedFromName: raw.inheritedFrom !== undefined && raw.inheritedFrom !== null
      ? areaNames?.get(String(raw.inheritedFrom)) ?? null : null,
    rings: cleanRings,
    pixelRings: projectRings(cleanRings, origin),
    pixelLines: Array.isArray(raw.lines) ? projectRings(raw.lines, origin) : null,
    pathData: ringsPathData(cleanRings, origin),
    bbox: ringsBBox(cleanRings, origin),
    musicState: music?.[raw.state]?.wwiseId,
    graph,
    playlists: {exploration},
  };
  if (Object.keys(gameMusicStates).length > 0) zone.gameMusicStates = gameMusicStates;
  return zone;
}

function normalizePlaylist(playlist, audioBase) {
  const base = normalizeBranch(playlist, '默认', audioBase);
  const variants = Array.isArray(playlist?.variants) ? playlist.variants : [];
  const branches = variants.map((variant) => normalizeBranch(variant, `曲单 ${variant.label}`, audioBase))
    .filter((branch) => branch.tracks.length > 0);
  if (base.tracks.length > 0 || branches.length === 0) branches.unshift(base);
  return branches;
}

function normalizeBranch(playlist, label, audioBase) {
  const ids = Array.isArray(playlist?.sources) ? playlist.sources : [];
  return {
    label,
    tracks: [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
      .map((id) => ({id, url: audioUrl(id, audioBase)})),
    incomplete: Object.keys(playlist?.unresolved ?? {}).length > 0,
  };
}
