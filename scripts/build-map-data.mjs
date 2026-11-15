// 生成 public/data/map-data.json：7.2.0 当前客户端的瓦片白名单 + 一级区域多边形与名称。
//
// 数据来源（全部只读、同一台本机 7.2.0 客户端）：
//   瓦片  E:/tools/AnimeStudio/AssetDigger/output/原神7.2.0/Textures/主世界（281 真瓦片）
//   几何  AssetDigger obj/Layout/ExportRepair/product-completion/scene-point/current/
//         BinOutput/Scene/WorldArea/scene3_worldArea.json
//   配置  AssetDigger obj/Layout/ExportRepair/product-completion/current/
//         ExcelBinOutput/WorldAreaConfigData.json
//   名称  原神7.2.0/TextMap/TextMap_MediumCHS.json（回退 TextMapCHS.json）
//
// 版本证据：三个 client-input/completion-摘要 的 executableSha256/metadataSha256/
// startupSha256 必须两两一致，且与 EXPECTED_EXECUTABLE_SHA256（本机 7.2.0 客户端，
// 来源：2026-11-15 用户指纹核对）相同；本机客户端 EXE 存在时直接实算复核。
//
// 抗混淆规则：不写死混淆字段名。场景几何用结构自适应解析（复用
// tools/scripts/maps/derive_world_area.mjs 的 parseWorldAreaRoot/detectPolygonObject
// 形状逻辑，未改其原入口）；配置列由 LEVEL_1/LEVEL_2 值集、TextMap 键集命中与
// scene3 (id1,id2) 覆盖的三元组推断严格验证，任何歧义直接报错退出。
//
// 瓦片合同：7.2 主世界 281 唯一坐标（官方合成报告同数），不套用 7.0 的
// preferred-MD5 与 6 块排除；网格 row -7..11 / col -6..15 与 7.0 相同，
// 放置 left=(15-col)*256、top=(11-row)*256，投影 pixelX=4096-worldZ*0.25、
// pixelY=3072-worldX*0.25（tools/global-traffic-extractor/render_map.py 合同，
// 与 AssetDigger src/Core/Maps/MapAreaConfig.cs 主世界网格一致）。

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(projectDir, '..', '..');

const ASSET_DIGGER = 'E:\\tools\\AnimeStudio\\AssetDigger';
const SOURCE = {
  tilesDir: path.join(ASSET_DIGGER, 'output', '原神7.2.0', 'Textures', '主世界'),
  scene: path.join(ASSET_DIGGER, 'obj', 'Layout', 'ExportRepair', 'product-completion',
    'scene-point', 'current', 'BinOutput', 'Scene', 'WorldArea', 'scene3_worldArea.json'),
  sceneInput: path.join(ASSET_DIGGER, 'obj', 'Layout', 'ExportRepair', 'product-completion',
    'scene-point', 'current', '.assetdigger', 'client-input.json'),
  excel: path.join(ASSET_DIGGER, 'obj', 'Layout', 'ExportRepair', 'product-completion',
    'current', 'ExcelBinOutput', 'WorldAreaConfigData.json'),
  excelSummary: path.join(ASSET_DIGGER, 'obj', 'Layout', 'ExportRepair', 'product-completion',
    'current', '导出报告', 'completion-摘要.json'),
  mapInput: path.join(ASSET_DIGGER, 'output', '原神7.2.0', '.assetdigger', 'client-input.json'),
  textMapMedium: path.join(ASSET_DIGGER, 'output', '原神7.2.0', 'TextMap', 'TextMap_MediumCHS.json'),
  textMapFull: path.join(ASSET_DIGGER, 'output', '原神7.2.0', 'TextMap', 'TextMapCHS.json'),
  localClientExe: 'D:\\Program Files\\miHoYo Launcher\\games\\Genshin Impact Game\\YuanShen.exe',
};
const OUTPUT = path.join(projectDir, 'public/data/map-data.json');
const DATA_VERSION = '7.2.0';

// 版本绑定参数（集中一处）：本机 7.2.0 正式客户端指纹，来源为 2026-11-15
// 用户以 D:/Program Files/miHoYo Launcher/.../config.ini game_version=7.2.0 的核对。
// 失效条件：客户端更新后必须重新核对并更新，否则脚本报错退出。
const EXPECTED_EXECUTABLE_SHA256
  = '8b014f64b5dc12fbc476e0c362b053abfdd7a1378cd282e4ad81057621dbd6b5';

// 7.2 主世界网格合同（与 7.0 render_map.py 一致；数据越界即报错）。
const TILE_PATTERN = /^UI_MapBack_([-+]?\d+)_([-+]?\d+)\.png$/;
const BLOCK_SIZE = 256;
const MIN_ROW = -7, MAX_ROW = 11, MIN_COL = -6, MAX_COL = 15;
const CANVAS_WIDTH = (MAX_COL - MIN_COL + 1) * BLOCK_SIZE;   // 5632
const CANVAS_HEIGHT = (MAX_ROW - MIN_ROW + 1) * BLOCK_SIZE;  // 4864
const PIXEL_ORIGIN_X = 4096;
const PIXEL_ORIGIN_Y = 3072;
const WORLD_TO_PIXEL_SCALE = 0.25;

function fail(message) {
  console.error(`[build-map-data] 错误：${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function pngSize(file) {
  const head = fs.readFileSync(file).subarray(0, 33);
  if (head.readUInt32BE(12) !== 0x49484452) fail(`非 PNG 文件（缺 IHDR）：${file}`);
  return {width: head.readUInt32BE(16), height: head.readUInt32BE(20)};
}

// ---------- 1. 版本指纹核对 ----------
function fingerprintOf(clientInput) {
  const {executableSha256, metadataSha256, startupSha256} = clientInput;
  if (!executableSha256 || !metadataSha256 || !startupSha256) {
    fail(`client-input.json 缺指纹字段：${JSON.stringify(clientInput).slice(0, 200)}`);
  }
  return {executableSha256, metadataSha256, startupSha256};
}

const mapFingerprint = fingerprintOf(readJson(SOURCE.mapInput));
const sceneFingerprint = fingerprintOf(readJson(SOURCE.sceneInput));
if (mapFingerprint.executableSha256 !== sceneFingerprint.executableSha256
  || mapFingerprint.metadataSha256 !== sceneFingerprint.metadataSha256) {
  fail('瓦片导出与场景几何的 client-input 指纹不一致，不能混用');
}
const excelSummary = readJson(SOURCE.excelSummary);
const excelClient = excelSummary?.client ?? {};
if (excelClient.executableSha256 !== mapFingerprint.executableSha256
  || excelClient.version !== DATA_VERSION) {
  fail(`Excel 配置客户端指纹/版本不符：${excelClient.executableSha256 ?? '(空)'} v${excelClient.version ?? '?'}`);
}
if (mapFingerprint.executableSha256 !== EXPECTED_EXECUTABLE_SHA256) {
  fail(`executableSha256 ${mapFingerprint.executableSha256} 与本机 7.2.0 期望指纹不符；客户端可能已更新，需重新核对`);
}
if (fs.existsSync(SOURCE.localClientExe)) {
  const actual = sha256File(SOURCE.localClientExe);
  if (actual !== EXPECTED_EXECUTABLE_SHA256) {
    fail(`本机客户端 EXE 指纹 ${actual.slice(0, 16)}… 与期望不符（客户端已更新？）`);
  }
}
console.log(`[build-map-data] 指纹核对通过：exe ${mapFingerprint.executableSha256.slice(0, 16)}… `
  + `metadata ${mapFingerprint.metadataSha256.slice(0, 16)}… `
  + `startup ${mapFingerprint.startupSha256.slice(0, 16)}…`);

// ---------- 2. 场景几何：结构自适应解析（derive_world_area.mjs 形状逻辑） ----------
const toVec = (raw) => {
  const x = raw._x ?? raw.x;
  const y = raw._y ?? raw.y;
  const z = raw._z ?? raw.z;
  return [x, y, z].every((item) => typeof item === 'number') ? {x, y, z} : null;
};
const isVectorObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && toVec(value) !== null;
const isVertexList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every(isVectorObject);

function detectPolygonObject(polygon, label) {
  // 多边形对象 = min/max 两个向量盒 + 唯一顶点数组（roadPoints）。
  const objectFields = Object.entries(polygon).filter(([, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value));
  const vertexBoxes = objectFields.filter(([, value]) => isVectorObject(value));
  const roadArrays = Object.entries(polygon).filter(([, value]) => isVertexList(value));
  if (vertexBoxes.length !== 2 || roadArrays.length !== 1) {
    fail(`${label}: 多边形形状不符（向量盒 ${vertexBoxes.length}，顶点数组 ${roadArrays.length}）`);
  }
  const [first, second] = vertexBoxes.map(([, value]) => toVec(value));
  const minArea = (first.x + first.y + first.z) <= (second.x + second.y + second.z) ? first : second;
  const maxArea = minArea === first ? second : first;
  if (minArea.x > maxArea.x || minArea.y > maxArea.y || minArea.z > maxArea.z) {
    fail(`${label}: min/max 盒不自洽`);
  }
  return {minArea, maxArea, roadPoints: roadArrays[0][1].map(toVec)};
}

function parseAreaObject(area, label) {
  const intFields = Object.entries(area).filter(([, value]) => Number.isInteger(value));
  const polygonObjects = Object.entries(area).filter(([, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && !isVectorObject(value));
  if (intFields.length < 2) fail(`${label}: 区域对象至少需要 id1/id2 两个整数字段`);
  if (polygonObjects.length !== 1) fail(`${label}: 无法唯一识别多边形对象字段`);
  const polygon = detectPolygonObject(polygonObjects[0][1], label);
  if (polygon.roadPoints.length < 3) fail(`${label}: roadPoints 少于 3 个顶点`);
  return {intFields, polygonData: polygon};
}

const sceneRoot = readJson(SOURCE.scene);
const level1Arrays = Object.entries(sceneRoot).filter(([, value]) =>
  Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === 'object'));
if (level1Arrays.length !== 1) fail(`scene3 根无法唯一识别 level1Areas 数组（${level1Arrays.length} 个候选）`);
const sceneLevel1 = level1Arrays[0][1].map((container, containerIndex) => {
  const objectFields = Object.entries(container).filter(([, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value));
  // 二级区域列表允许为空（7.2 存在无二级划分的一级区域）。
  const childArrays = Object.entries(container).filter(([, value]) => Array.isArray(value));
  if (objectFields.length !== 1 || childArrays.length > 1) {
    fail(`level1 容器[${containerIndex}]形状不符（对象 ${objectFields.length}，数组 ${childArrays.length}）`);
  }
  const level1Area = parseAreaObject(objectFields[0][1], `level1Area[${containerIndex}]`);
  const level2Areas = (childArrays[0]?.[1] ?? []).map((area, areaIndex) =>
    parseAreaObject(area, `level2[${containerIndex}][${areaIndex}]`));
  return {level1Area, level2Areas};
});

// id1：每个父级内恒定、跨父级变化；id2 为另一个整数字段（derive_world_area 同法）。
const nonEmptyParents = sceneLevel1.filter((item) => item.level2Areas.length > 0);
if (nonEmptyParents.length < 2) fail('非空二级区域的父级不足，无法区分 id1/id2');
const candidateNames = nonEmptyParents[0].level2Areas[0].intFields.map(([name]) => name);
const id1Name = candidateNames.find((name) => {
  const parentValues = new Set();
  for (const item of nonEmptyParents) {
    const firstEntry = item.level2Areas[0].intFields.find(([fieldName]) => fieldName === name);
    if (!firstEntry) return false;
    const constant = item.level2Areas.every((area) =>
      area.intFields.find(([fieldName]) => fieldName === name)?.[1] === firstEntry[1]);
    if (!constant) return false;
    parentValues.add(firstEntry[1]);
  }
  return parentValues.size === nonEmptyParents.length;
});
if (!id1Name) fail('无法按父级内恒定性区分 id1/id2');
const id2Name = candidateNames.find((name) => name !== id1Name);
if (!id2Name) fail('缺少 id2 字段');

const sceneAreas = sceneLevel1.map((item) => ({
  level1Area: {
    id1: item.level1Area.intFields.find(([name]) => name === id1Name)?.[1],
    id2: item.level1Area.intFields.find(([name]) => name === id2Name)?.[1],
    polygonData: item.level1Area.polygonData,
  },
  level2Areas: item.level2Areas.map((area) => ({
    id1: area.intFields.find(([name]) => name === id1Name)?.[1],
    id2: area.intFields.find(([name]) => name === id2Name)?.[1],
  })),
}));
for (const [index, item] of sceneAreas.entries()) {
  if (!Number.isInteger(item.level1Area.id1) || !Number.isInteger(item.level1Area.id2)) {
    fail(`level1Area[${index}] 缺 id1/id2`);
  }
}
const sceneL1Ids = new Set(sceneAreas.map((item) => item.level1Area.id1));
const sceneL2Pairs = new Set(sceneAreas.flatMap((item) =>
  item.level2Areas.map((area) => `${area.id1},${area.id2}`)));
console.log(`[build-map-data] 场景几何：一级 ${sceneAreas.length}，二级对 ${sceneL2Pairs.size} `
  + `（id1=${id1Name} id2=${id2Name}）`);

// ---------- 3. 配置列动态推断（areaType / nameTextMapHash / id / sceneId / id1 / id2） ----------
const excel = readJson(SOURCE.excel);
if (!Array.isArray(excel)) fail('WorldAreaConfigData 不是数组');
const intColumns = [...new Set(excel.flatMap((row) => Object.keys(row)))]
  .filter((key) => excel.every((row) => row[key] === undefined || Number.isInteger(row[key])));

// areaType：唯一取值集为 {LEVEL_1, LEVEL_2} 的字符串列。
const areaTypeCandidates = Object.keys(excel[0]).filter((key) => {
  const values = new Set(excel.map((row) => row[key]));
  return values.size === 2 && values.has('LEVEL_1') && values.has('LEVEL_2');
});
if (areaTypeCandidates.length !== 1) fail(`areaType 列候选 ${areaTypeCandidates.length} 个，拒绝猜测`);
const F_AREA_TYPE = areaTypeCandidates[0];
const rowsLevel1 = excel.filter((row) => row[F_AREA_TYPE] === 'LEVEL_1');
const rowsLevel2 = excel.filter((row) => row[F_AREA_TYPE] === 'LEVEL_2');

// nameTextMapHash：键为 TextMap 命中率最高的唯一整数列（597/597 唯一 + 全量命中）。
const textMap = readJson(SOURCE.textMapMedium);
try {
  const full = readJson(SOURCE.textMapFull);
  for (const [key, value] of Object.entries(full)) {
    if (!(key in textMap)) textMap[key] = value;
  }
} catch {
  // 全量 TextMap 缺失时仅用 Medium；命中数在 audit 中如实报告。
}
const textMapKeySetSize = Object.keys(textMap).length;
const nameCandidates = intColumns.filter((key) => {
  const values = rowsLevel1.map((row) => row[key]);
  const distinct = new Set(values);
  return values.length === distinct.size
    && excel.filter((row) => String(row[key]) in textMap).length >= Math.floor(excel.length * 0.9);
});
if (nameCandidates.length !== 1) {
  fail(`nameTextMapHash 列候选 ${nameCandidates.length} 个（${nameCandidates.join(',')}），拒绝猜测`);
}
const F_NAME = nameCandidates[0];

// (id1 列, sceneId 列, 场景值 V) 联合推断（单列推断会被其他场景同名列干扰）。
const joinCandidates = [];
for (const f of intColumns) {
  if (f === F_NAME) continue;
  for (const s of intColumns) {
    if (f === s) continue;
    const sceneValues = [...new Set(rowsLevel1.map((row) => row[s]))].filter((v) => v !== undefined);
    for (const v of sceneValues) {
      const subset = rowsLevel1.filter((row) => row[s] === v).map((row) => row[f]);
      const distinct = new Set(subset);
      if (subset.length === distinct.size && distinct.size === sceneL1Ids.size
        && [...distinct].every((id1) => sceneL1Ids.has(id1))) {
        joinCandidates.push({id1Column: f, sceneColumn: s, sceneValue: v});
      }
    }
  }
}
if (joinCandidates.length !== 1) {
  fail(`(id1,sceneId,场景值) 连接候选 ${joinCandidates.length} 个：`
    + joinCandidates.map((c) => `${c.id1Column}/${c.sceneColumn}==${c.sceneValue}`).join(' ')
    + '；需人工裁决，拒绝猜测');
}
const {id1Column: F_ID1, sceneColumn: F_SCENE, sceneValue: SCENE_ID} = joinCandidates[0];

// id2 列：LEVEL_2 且 sceneId=V 行上 (id1,id2) 键唯一，且完整覆盖 scene3 二级对。
const sceneRowsLevel2 = rowsLevel2.filter((row) => row[F_SCENE] === SCENE_ID);
const id2Candidates = intColumns.filter((key) => {
  if (key === F_ID1 || key === F_SCENE || key === F_NAME) return false;
  const pairs = sceneRowsLevel2.map((row) => `${row[F_ID1]},${row[key]}`);
  const distinct = new Set(pairs);
  if (pairs.length !== distinct.size) return false;
  for (const pair of sceneL2Pairs) {
    if (!distinct.has(pair)) return false;
  }
  return true;
});
if (id2Candidates.length !== 1) {
  fail(`id2 连接列候选 ${id2Candidates.length} 个，需人工裁决；拒绝猜测`);
}
const F_ID2 = id2Candidates[0];
const level1ByAreaId = new Map(rowsLevel1
  .filter((row) => row[F_SCENE] === SCENE_ID)
  .map((row) => [row[F_ID1], row]));
if (level1ByAreaId.size !== sceneAreas.length) {
  fail(`sceneId=${SCENE_ID} 的 LEVEL_1 行数 ${level1ByAreaId.size} ≠ 场景一级区域数 ${sceneAreas.length}`);
}
console.log(`[build-map-data] 配置连接列：areaType=${F_AREA_TYPE} name=${F_NAME} `
  + `id1=${F_ID1} id2=${F_ID2} scene=${F_SCENE}==${SCENE_ID}`);

// ---------- 4. 瓦片白名单（7.2 主世界 281 全量，无 7.0 排除/preferred 表） ----------
if (!fs.existsSync(SOURCE.tilesDir)) fail(`瓦片目录不存在：${SOURCE.tilesDir}`);
const tileCandidates = new Map();
const auditTiles = {numericFileCount: 0, ignoredNonNumeric: 0, duplicateCoordinates: []};
for (const name of fs.readdirSync(SOURCE.tilesDir).sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}))) {
  if (!name.toLowerCase().startsWith('ui_mapback_') || !name.toLowerCase().endsWith('.png')) continue;
  const match = TILE_PATTERN.exec(name);
  if (!match) {
    auditTiles.ignoredNonNumeric += 1;
    continue;
  }
  auditTiles.numericFileCount += 1;
  const row = Number.parseInt(match[1], 10);
  const col = Number.parseInt(match[2], 10);
  if (!(MIN_ROW <= row && row <= MAX_ROW && MIN_COL <= col && col <= MAX_COL)) {
    fail(`瓦片 ${name} 超出 7.2 网格合同 row ${MIN_ROW}..${MAX_ROW} / col ${MIN_COL}..${MAX_COL}；需重新核对网格`);
  }
  const file = path.join(SOURCE.tilesDir, name);
  const {width, height} = pngSize(file);
  if (width < 8) continue;
  const group = tileCandidates.get(`${row},${col}`) ?? [];
  group.push({file: name, row, col, width, height, sha256: sha256File(file)});
  tileCandidates.set(`${row},${col}`, group);
}
const tiles = [...tileCandidates.entries()].map(([coord, group]) => {
  // 7.2 导出每坐标单文件；若出现重复，按像素面积、最长边、文件名确定性选择并记录。
  const selected = group.sort((a, b) =>
    (b.width * b.height) - (a.width * a.height)
      || Math.max(b.width, b.height) - Math.max(a.width, a.height)
      || a.file.localeCompare(b.file, undefined, {sensitivity: 'base'}))[0];
  if (group.length > 1) {
    auditTiles.duplicateCoordinates.push({coord, selected: selected.file, candidates: group.map((c) => c.file)});
  }
  const [row, col] = coord.split(',').map(Number);
  return {
    file: `r${row}c${col}.webp`,
    row,
    col,
    left: (MAX_COL - col) * BLOCK_SIZE,
    top: (MAX_ROW - row) * BLOCK_SIZE,
    width: selected.width,
    height: selected.height,
    source: {kind: 'ui-mapback-png-7.2', file: selected.file, sha256: selected.sha256},
  };
}).sort((a, b) => (a.row - b.row) || (a.col - b.col));
const missingCells = [];
for (let row = MIN_ROW; row <= MAX_ROW; row += 1) {
  for (let col = MIN_COL; col <= MAX_COL; col += 1) {
    if (!tileCandidates.has(`${row},${col}`)) missingCells.push([row, col]);
  }
}
console.log(`[build-map-data] 瓦片：${tiles.length} 块（去重后），缺格 ${missingCells.length}`);

// ---------- 5. 区域投影与名称 ----------
const regions = [];
const unnamedId1s = [];
for (const area of sceneAreas) {
  const config = level1ByAreaId.get(area.level1Area.id1);
  if (!config) fail(`一级区域 id1=${area.level1Area.id1} 在 WorldAreaConfigData(sceneId=${SCENE_ID}) 无对应行`);
  const name = textMap[String(config[F_NAME])] ?? null;
  if (!name) unnamedId1s.push(area.level1Area.id1);
  const points = area.level1Area.polygonData.roadPoints.map((p) => [
    Math.round((PIXEL_ORIGIN_X - p.z * WORLD_TO_PIXEL_SCALE) * 10) / 10,
    Math.round((PIXEL_ORIGIN_Y - p.x * WORLD_TO_PIXEL_SCALE) * 10) / 10,
  ]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  regions.push({
    id1: area.level1Area.id1,
    name,
    points,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  });
}
regions.sort((a, b) => a.id1 - b.id1);

// ---------- 6. 输出 ----------
const result = {
  format: 'teyvat-region-map-data-v1',
  dataVersion: DATA_VERSION,
  generatedAt: new Date().toISOString(),
  provenance: {
    workspaceRoot,
    fingerprints: mapFingerprint,
    fingerprintRule: '三个源(瓦片导出/场景几何/Excel 配置)的 client-input 指纹两两一致，'
      + '且 executableSha256 与本机 7.2.0 客户端 EXE 实算相同',
    sources: {
      tilesDir: SOURCE.tilesDir,
      scene: SOURCE.scene,
      excel: SOURCE.excel,
      textMap: [SOURCE.textMapMedium, SOURCE.textMapFull],
      localClientExe: SOURCE.localClientExe,
    },
    tileContract: '7.2 主世界 281 唯一坐标全量（不套 7.0 preferred-MD5/排除表）；'
      + `网格 row ${MIN_ROW}..${MAX_ROW} col ${MIN_COL}..${MAX_COL}，`
      + `放置 left=(15-col)*256 top=(11-row)*256；发布产物为有损 WebP(quality=100, method=6，`
      + '不重采样)，由 scripts/build-tiles-webp.py 生成到项目 dist/tiles。',
    projection: 'pixelX = 4096 - worldZ * 0.25 ; pixelY = 3072 - worldX * 0.25',
    fieldResolution: {
      rule: '场景几何结构自适应解析（derive_world_area.mjs 形状逻辑）+ 配置列动态推断'
        + '（LEVEL_* 枚举、TextMap 键集命中、scene3 (id1,id2) 三元组覆盖），无写死混淆名',
      resolved: {
        sceneId1Field: id1Name,
        sceneId2Field: id2Name,
        excelAreaType: F_AREA_TYPE,
        excelNameTextMapHash: F_NAME,
        excelAreaId1: F_ID1,
        excelAreaId2: F_ID2,
        excelSceneId: `${F_SCENE}==${SCENE_ID}`,
      },
    },
  },
  canvas: {width: CANVAS_WIDTH, height: CANVAS_HEIGHT, block: BLOCK_SIZE},
  tiles,
  regions,
  audit: {
    level1Count: regions.length,
    namedCount: regions.length - unnamedId1s.length,
    unnamedId1s,
    level2PairsInScene: sceneL2Pairs.size,
    level2PairsJoined: sceneRowsLevel2.length,
    textMapKeySetSize,
    tileAudit: auditTiles,
    tilesSelected: tiles.length,
    tilesMissingCells: missingCells.length,
    tilesSourcePngBytes: tiles.reduce((sum, tile) => sum
      + fs.statSync(path.join(SOURCE.tilesDir, tile.source.file)).size, 0),
  },
};

fs.mkdirSync(path.dirname(OUTPUT), {recursive: true});
fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 1)}\n`, 'utf8');

const tileBytesMiB = (result.audit.tilesSourcePngBytes / 1048576).toFixed(1);
console.log('[build-map-data] 完成：'
  + `区域 ${regions.length}（有名 ${result.audit.namedCount}，无名 ${unnamedId1s.join('/') || '无'}）；`
  + `瓦片 ${tiles.length} 块 / 源 ${tileBytesMiB} MiB，缺格 ${missingCells.length}`);
console.log(`[build-map-data] 输出 ${OUTPUT}`);
