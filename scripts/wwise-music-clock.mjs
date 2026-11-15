import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readWwiseBank, shortId} from './wwise-bank.mjs';

function readGlobalSettings(bank) {
  const version = bank.readUInt32LE(8);
  if (version !== 134) throw new Error(`未支持的 Wwise STMG 版本 ${version}`);
  let stmg;
  for (let offset = 0; offset + 8 <= bank.length;) {
    const end = offset + 8 + bank.readUInt32LE(offset + 4);
    if (end > bank.length) throw new Error('初始化 Bank 区块超出文件范围');
    if (bank.toString('ascii', offset, offset + 4) === 'STMG') {
      if (stmg) throw new Error('初始化 Bank 含多个 STMG 区块');
      stmg = bank.subarray(offset + 8, end);
    }
    offset = end;
  }
  if (!stmg) throw new Error('初始化 Bank 缺少 STMG 区块');
  return stmg;
}

// Wwise 134 STMG 中，音量与语音限制字段后依次是状态组、开关曲线和 RTPC 定义。
function readSwitchCurves(data, groupId) {
  let offset = 8;
  const take = (size) => {
    if (offset + size > data.length) throw new Error('STMG 状态组或开关曲线不完整');
    const start = offset;
    offset += size;
    return start;
  };
  const uint = () => data.readUInt32LE(take(4));
  const stateGroups = uint();
  for (let index = 0; index < stateGroups; index += 1) {
    take(8);
    const transitions = uint();
    take(transitions * 12);
  }
  const switchGroups = uint();
  const matches = [];
  for (let index = 0; index < switchGroups; index += 1) {
    const id = uint();
    const parameter = uint();
    const type = data.readUInt8(take(1));
    const count = uint();
    const start = take(count * 12);
    if (id !== groupId) continue;
    const points = Array.from({length: count}, (_, point) => {
      const position = start + point * 12;
      if (data.readUInt32LE(position + 8) !== 9) throw new Error('音乐时段曲线不是常量插值');
      return [data.readFloatLE(position), data.readUInt32LE(position + 4)];
    });
    matches.push({parameter, type, points});
  }
  if (matches.length !== 1) throw new Error('STMG 音乐时段开关组无法唯一定位');
  return matches[0];
}

export async function readMusicClock(root, packages, graph) {
  const groups = Object.entries(graph.groups).filter(([, definition]) => definition.name === '昼夜');
  if (groups.length !== 1) throw new Error('音乐图的昼夜开关组无法唯一定位');
  const [[id, definition]] = groups;
  const group = Number(id);
  const supported = new Set(Object.keys(definition.options).map(Number));
  const usesGroup = Object.values(graph.nodes).some((node) => {
    const slot = node.groups?.indexOf(group) ?? -1;
    return slot >= 0 && node.groupTypes?.[slot] === 0;
  });
  if (!usesGroup) throw new Error('昼夜开关组没有在音乐决策树中使用');
  if (!packages.length || !packages.every((file) => /^(?:Minimum|Banks\d+)\.pck$/i.test(file))) {
    throw new Error('需要提供客户端初始化 Bank 所属的 PCK 文件名');
  }
  const bankId = shortId('Init');
  const records = await Promise.all([...new Set(packages)].map(async (file) => {
    const bank = await readWwiseBank(path.join(root, file), bankId);
    const settings = readGlobalSettings(bank);
    return {
      file,
      sha256: createHash('sha256').update(bank).digest('hex'),
      curve: readSwitchCurves(settings, group),
    };
  }));
  const {points, parameter, type} = records[0].curve;
  if (!parameter || type !== 0 || points[0]?.[0] !== 0 || points.at(-1)?.[0] !== 24
    || points.some(([hour, key], index) => !Number.isFinite(hour)
      || (index > 0 && hour <= points[index - 1][0]) || (key !== 0 && !supported.has(key)))
    || [...supported].some((key) => !points.some((point) => point[1] === key))
    || records.some(({curve}) => !isDeepStrictEqual(curve, records[0].curve))) {
    throw new Error('初始化 Bank 的音乐时段曲线或值集不一致');
  }
  return {
    clock: {group, points},
    evidence: {bankId, parameter, banks: Object.fromEntries(records.map(({file, sha256}) => [file, sha256]))},
  };
}
