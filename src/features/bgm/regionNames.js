// 7.2 客户端 WorldArea 的部分音区没有可解析的中文名称。只在原清单使用
// 编号时补显示名称，并核对场景、区域 id 与 Wwise 状态，以免覆盖游戏名称。
const names = new Map([
  // 同一音乐范围包含有名的一级区域；其余小块用已核实的所属地点。
  ['3:4001:State_XuMi_SenZhiLi', '桓那兰那'],
  ['3:4301:State_XuMi_CaoShenDian', '二净甸'],
  ['3:4407:State_XuMi_CengDieZhiSen', '善见地'],
  ['3:4602:State_XuMi_DiaoLingZhiSen', '往昔的桓那兰那'],
  ['3:4807:State_XuMi31_ARuDeDaoYing', '阿如的倒影'],
  ['3:41101:State_XuMi36_GanLuHuaHai', '甘露花海'],
  // Layer 3390302 / 3390402 分别显示这两块遗迹的游戏名称。
  ['3:50704:State_FD42_SiXiangFengYin_C', '莫尔泰区·神秘的遗迹'],
  ['3:50705:State_FD42_SiXiangFengYin_D', '莫尔泰区·神秘的遗迹'],
  ['3:99101:State_NT58_NaTaGongHai_One', '纳塔外海'],
  // 与同场景的圣山之心 680009 共用 YuZhaoTongDie 的内部/外部状态族。
  ['101:680010:State_NT55_YuZhaoTongDieNeiBu', '圣山之心'],
]);
const numberedName = /^区域\s*\d+(?:等)?$/u;
const unnamedLocation = '未命名地点';

// 兼容旧版合并音区清单中附在地名末尾的「等」。
export function stripMergedRegionSuffix({name, id, areaIds}) {
  return typeof id === 'string' && id.includes(':') && Array.isArray(areaIds) && areaIds.length > 1
    ? name.replace(/等$/u, '') : name;
}

export function geographicName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  return text && text !== unnamedLocation && !numberedName.test(text) && !/^[?？\s]+$/u.test(text)
    ? text : null;
}

export function displayRegionName(row, clientVersion, sceneId, floorName) {
  const original = stripMergedRegionSuffix(row).trim();
  if (!numberedName.test(original)) return original;
  if (floorName) return floorName;
  if (clientVersion === '7.2.0') {
    const areaId = String(row.id).split(':', 1)[0];
    const name = names.get(`${sceneId}:${areaId}:${row.state}`);
    if (name) return name;
  }
  return unnamedLocation;
}
