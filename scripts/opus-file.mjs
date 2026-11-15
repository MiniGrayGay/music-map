import {open} from 'node:fs/promises';

export async function verifyOpus(file, size, expectedDuration) {
  const stream = await open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 512));
    const {bytesRead: headBytes} = await stream.read(head, 0, head.length, 0);
    const header = 27 + head[26];
    if (headBytes !== head.length || head.length < 27 || head[4] !== 0 || !(head[5] & 2)
      || head.subarray(0, 4).toString() !== 'OggS' || header + 19 > head.length
      || head.subarray(header, header + 8).toString() !== 'OpusHead') {
      throw new Error(`音频缺少 Ogg Opus 头 ${file}`);
    }
    const serial = head.readUInt32LE(14);
    const preSkip = head.readUInt16LE(header + 10);
    const tail = Buffer.alloc(Math.min(size, 65536));
    const {bytesRead: tailBytes} = await stream.read(tail, 0, tail.length, size - tail.length);
    if (tailBytes !== tail.length) throw new Error(`音频末尾读取提前结束 ${file}`);
    for (let offset = tail.lastIndexOf('OggS'); offset >= 0;) {
      if (offset + 27 <= tail.length && tail[offset + 4] === 0 && (tail[offset + 5] & 4)
        && tail.readUInt32LE(offset + 14) === serial) {
        const payload = offset + 27 + tail[offset + 26];
        const end = tail.subarray(offset + 27, payload).reduce((sum, bytes) => sum + bytes, payload);
        if (end === tail.length) {
          const duration = (Number(tail.readBigUInt64LE(offset + 6)) - preSkip) / 48000;
          if (duration <= 0 || Math.abs(duration - expectedDuration) > 0.1) {
            throw new Error(`音频时长与清单不符 ${file}`);
          }
          return duration;
        }
      }
      offset = offset > 0 ? tail.lastIndexOf('OggS', offset - 1) : -1;
    }
    throw new Error(`音频末尾不完整 ${file}`);
  } finally {
    await stream.close();
  }
}
