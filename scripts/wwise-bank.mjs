import {open} from 'node:fs/promises';

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
