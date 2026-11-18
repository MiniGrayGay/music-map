import catalog from './playlist-share-catalog.json' with {type: 'json'};

// 固定码表只追加。分享码以两位 base62 曲目数和组合序号表示歌曲集合。
const indexes = new Map(catalog.map((id, index) => [id, index]));
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const radix = BigInt(alphabet.length);
const maxLength = 2 + Math.ceil(catalog.length / Math.log2(alphabet.length));

function combinations(size, count) {
  if (size < count) return 0n;
  let result = 1n;
  const terms = Math.min(count, size - count);
  for (let term = 1; term <= terms; term += 1) {
    result = result * BigInt(size - term + 1) / BigInt(term);
  }
  return result;
}

export function encodePlaylistShareCode(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > catalog.length) {
    throw new RangeError('曲目数量无效');
  }
  const selection = new Set();
  for (const id of ids) {
    const index = indexes.get(id);
    if (index === undefined || selection.has(index)) throw new RangeError('曲目无效或重复');
    selection.add(index);
  }
  const sorted = [...selection].sort((a, b) => a - b);
  let rank = sorted.reduce((sum, index, slot) => sum + combinations(index, slot + 1), 0n);
  const digits = [];
  do {
    digits.push(alphabet[Number(rank % radix)]);
    rank /= radix;
  } while (rank);
  return alphabet[Math.floor(sorted.length / alphabet.length)]
    + alphabet[sorted.length % alphabet.length]
    + digits.reverse().join('');
}

export function decodePlaylistShareCode(code) {
  if (typeof code !== 'string' || code.length < 3 || code.length > maxLength
    || /[^0-9A-Za-z]/.test(code) || (code.length > 3 && code[2] === alphabet[0])) {
    throw new RangeError('分享码格式无效');
  }
  const count = alphabet.indexOf(code[0]) * alphabet.length + alphabet.indexOf(code[1]);
  if (count < 1 || count > catalog.length) throw new RangeError('曲目数量无效');
  let rank = 0n;
  for (const digit of code.slice(2)) rank = rank * radix + BigInt(alphabet.indexOf(digit));
  if (rank >= combinations(catalog.length, count)) throw new RangeError('分享码超出曲库范围');

  const selection = new Array(count);
  let index = catalog.length - 1;
  for (let slot = count; slot > 0; slot -= 1) {
    let ways = combinations(index, slot);
    while (ways > rank) {
      index -= 1;
      ways = combinations(index, slot);
    }
    selection[slot - 1] = catalog[index];
    rank -= ways;
    index -= 1;
  }
  return selection;
}
