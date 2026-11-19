export const mapDocument = Object.freeze({map: 0, tiles: 1, layers: 2, bases: 3, music: 4, relief: 5});
const mapDocumentCount = Object.keys(mapDocument).length;

export const releaseJsonPaths = typeof __VERCEL_RELEASE__ !== 'undefined' && __VERCEL_RELEASE__ ? null : [
  'data/map-data.json',
  'tiles/meta.json',
  'layers/manifest.json',
  'layers/basemaps.json',
  'data/genshin-region-bgm.json',
  'relief/index.json',
];
export const releaseIndexAttribute = 'data-packet';
export const releaseIndexSeed = 0x7db32fa5;
const packetPathPattern = /^r\/[a-f0-9]{24}\.data$/;
let packetPaths;

export function packetSeed(path) {
  return Number.parseInt(path.slice(2, 10), 16);
}

// The same byte transform works on the whole file or a fetched byte range.
export function maskPacket(bytes, seed, offset = 0) {
  let index = 0;
  let word = Math.floor(offset / 4);
  let lane = offset & 3;
  while (index < bytes.length) {
    let key = Math.imul(word ^ seed, 0x9e3779b1);
    key = Math.imul(key ^ key >>> 16, 0x85ebca6b);
    key ^= key >>> 13;
    for (; lane < 4 && index < bytes.length; lane++, index++) {
      bytes[index] ^= (key >>> (lane * 8)) & 255;
    }
    word++;
    lane = 0;
  }
  return bytes;
}

export function rasterPacketName(path) {
  let first = 0x7d246b91;
  let second = 0xa911763d;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const hex = (value) => (value >>> 0).toString(16).padStart(8, '0');
  return `r/${hex(first)}${hex(second)}.webp`;
}

function releasePackets() {
  if (packetPaths !== undefined) return packetPaths;
  const encoded = typeof document === 'undefined'
    ? null : document.documentElement.getAttribute(releaseIndexAttribute);
  packetPaths = encoded ? decodeReleaseIndex(encoded) : null;
  return packetPaths;
}

export function decodeReleaseIndex(encoded) {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const paths = JSON.parse(new TextDecoder().decode(maskPacket(bytes, releaseIndexSeed)));
  if (!Array.isArray(paths) || paths.length !== mapDocumentCount + 1
    || !paths.slice(0, mapDocumentCount).every(isReleasePacketName)
    || (paths[mapDocumentCount] !== null && !isReleasePacketName(paths[mapDocumentCount]))) {
    throw new Error('发布数据索引无效');
  }
  return paths;
}

export function isReleasePacketName(name) {
  return typeof name === 'string' && packetPathPattern.test(name);
}

export function rasterAssetUrl(relative) {
  if (!releasePackets()) return relative;
  const [path, query] = relative.split('?', 2);
  return './' + rasterPacketName(path.replace(/^\.\//, '')) + (query ? '?' + query : '');
}

export function reliefAsset(relative) {
  const packet = releasePackets()?.[mapDocumentCount];
  return {url: packet ? './' + packet : relative, seed: packet ? packetSeed(packet) : null};
}

export async function fetchMapDocument(slot, fetcher = fetch) {
  const paths = releasePackets();
  if (!paths) {
    const relative = releaseJsonPaths?.[slot];
    if (!relative) throw new Error('缺少发布数据索引');
    return fetcher('./' + relative);
  }
  const packet = paths[slot];
  if (!packet) throw new Error('缺少发布数据');
  const response = await fetcher('./' + packet);
  if (!response.ok) return response;
  const seed = packetSeed(packet);
  let offset = 0;
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(maskPacket(chunk, seed, offset));
      offset += chunk.byteLength;
    },
  })).pipeThrough(new DecompressionStream('gzip'));
  return new Response(body, {status: response.status, headers: {'Content-Type': 'application/json'}});
}
