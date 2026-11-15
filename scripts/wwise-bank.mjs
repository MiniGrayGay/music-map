import {open, readdir} from 'node:fs/promises';
import path from 'node:path';

export function shortId(name) {
  let result = 2166136261;
  for (const code of Buffer.from(name.toLowerCase(), 'ascii')) {
    result = Math.imul(result, 16777619) ^ code;
  }
  return result >>> 0;
}

async function readExactly(file, size, position) {
  const result = Buffer.allocUnsafe(size);
  for (let offset = 0; offset < size;) {
    const {bytesRead} = await file.read(result, offset, size - offset, position + offset);
    if (!bytesRead) throw new Error('音频包读取提前结束');
    offset += bytesRead;
  }
  return result;
}

export async function readWwiseBank(packagePath, bankId) {
  const file = await open(packagePath, 'r');
  try {
    const {size: fileSize} = await file.stat();
    const header = await readExactly(file, 28, 0);
    if (header.toString('ascii', 0, 4) !== 'AKPK') throw new Error('音频包缺少 AKPK 头');
    const tableOffset = 28 + header.readUInt32LE(12);
    const tableSize = header.readUInt32LE(16);
    if (tableSize < 4 || tableOffset + tableSize > fileSize) throw new Error('音频包索引不完整');
    const table = await readExactly(file, tableSize, tableOffset);
    if (tableSize !== 4 + table.readUInt32LE(0) * 20) throw new Error('音频包索引长度不符');
    const bank = [];
    for (let offset = 4; offset < tableSize; offset += 20) {
      if (table.readUInt32LE(offset) === bankId) bank.push(offset);
    }
    if (bank.length !== 1) throw new Error('音频 Bank 无法唯一定位');
    const [row] = bank;
    const size = table.readUInt32LE(row + 8);
    const start = table.readUInt32LE(row + 4) * table.readUInt32LE(row + 12);
    if (!Number.isSafeInteger(start) || size < 16 || start + size > fileSize) {
      throw new Error('音频 Bank 超出文件范围');
    }
    const bytes = await readExactly(file, size, start);
    if (bytes.toString('ascii', 0, 4) !== 'BKHD' || bytes.readUInt32LE(12) !== bankId) {
      throw new Error('音频 Bank 身份不符');
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export async function readMusicMediaIndex(directory, ids, family = 'Music') {
  if (!['Music', 'BeydMusic'].includes(family)) throw new Error(`未知音乐 PCK 家族 ${family}`);
  const wanted = new Set(ids);
  const entries = new Map();
  const pattern = new RegExp(`^${family}\\d+\\.pck$`, 'i');
  const packages = (await readdir(directory)).filter((name) => pattern.test(name));
  if (!packages.length) throw new Error(`目录里没有音乐 PCK ${directory}`);
  for (const name of packages) {
    const packagePath = path.join(directory, name);
    const file = await open(packagePath, 'r');
    try {
      const {size: length} = await file.stat();
      const header = await readExactly(file, 28, 0);
      if (header.toString('ascii', 0, 4) !== 'AKPK') throw new Error(`${name} 缺少 AKPK 头`);
      const offset = 28 + header.readUInt32LE(12) + header.readUInt32LE(16);
      const size = header.readUInt32LE(20);
      if (size < 4 || offset + size > length) throw new Error(`${name} 音频索引超出文件范围`);
      const table = await readExactly(file, size, offset);
      if (size !== 4 + table.readUInt32LE(0) * 20) throw new Error(`${name} 音频索引长度不符`);
      for (let row = 4; row < size; row += 20) {
        const id = table.readUInt32LE(row);
        if (!wanted.has(id)) continue;
        const bytes = table.readUInt32LE(row + 8);
        const start = table.readUInt32LE(row + 4) * table.readUInt32LE(row + 12);
        if (entries.has(id) || !Number.isSafeInteger(start)
          || start < offset + size || bytes < 12 || start + bytes > length) {
          throw new Error(`${name} 音源 ${id} 重复或位置无效`);
        }
        entries.set(id, {id, packagePath, start, bytes});
      }
    } finally {
      await file.close();
    }
  }
  const missing = ids.filter((id) => !entries.has(id));
  if (missing.length) throw new Error(`音乐 PCK 缺少 ${missing.length} 个音源，首个 ${missing[0]}`);
  return entries;
}

export async function readMusicMedia({id, packagePath, start, bytes}) {
  const file = await open(packagePath, 'r');
  try {
    const data = await readExactly(file, bytes, start);
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.readUInt32LE(4) + 8 !== bytes
      || data.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`音源 ${id} 的封装不完整`);
    }
    return data;
  } finally {
    await file.close();
  }
}

export async function readMusicDuration({id, packagePath, start, bytes}) {
  const file = await open(packagePath, 'r');
  try {
    const header = await readExactly(file, 48, start);
    // The 7.2 music PCK uses the Wwise Vorbis sample count in the extended fmt chunk.
    if (bytes < 48 || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.readUInt32LE(4) + 8 !== bytes || header.toString('ascii', 8, 16) !== 'WAVEfmt '
      || header.readUInt32LE(16) !== 0x42 || header.readUInt16LE(20) !== 0xffff) {
      throw new Error(`音源 ${id} 不是已核实的 Wwise Vorbis 封装`);
    }
    const rate = header.readUInt32LE(24);
    const samples = header.readUInt32LE(44);
    if (!rate || !samples) throw new Error(`音源 ${id} 缺少采样时长`);
    return samples / rate;
  } finally {
    await file.close();
  }
}

export function* hircRecords(bytes) {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) throw new Error('音频 Bank 段超出文件范围');
    if (type !== 'HIRC') {
      offset = end;
      continue;
    }
    if (length < 4) throw new Error('HIRC 段缺少记录数');
    const count = bytes.readUInt32LE(offset + 8);
    let record = offset + 12;
    for (let index = 0; index < count; index += 1) {
      if (record + 9 > end) throw new Error('HIRC 记录不完整');
      const size = bytes.readUInt32LE(record + 1);
      const next = record + 5 + size;
      if (size < 4 || next > end) throw new Error('HIRC 记录长度无效');
      const payload = bytes.subarray(record + 5, next);
      yield {type: bytes[record], id: payload.readUInt32LE(0), payload};
      record = next;
    }
    if (record !== end) throw new Error('HIRC 记录数与段长度不符');
    return;
  }
  throw new Error('音频 Bank 缺少 HIRC 段');
}
