import {createHash} from 'node:crypto';
import {reliefBlockBytes} from '../src/features/map/reliefFormat.js';

export function reliefZoneSignature(zones) {
  return createHash('sha256').update(JSON.stringify(zones.map(({id, rings}) => [String(id), rings]))).digest('hex');
}

export function reliefFileNames(index, bgm) {
  if (index.schema !== 1 || index.version !== bgm.clientVersion
    || index.zoneSignature !== reliefZoneSignature(bgm.zones)
    || !/^[a-f0-9]{64}$/.test(index.sha256)
    || index.file !== `points-${index.sha256.slice(0, 16)}.f32`
    || !Number.isSafeInteger(index.bytes) || index.bytes < 12
    || !/^[a-f0-9]{64}$/.test(index.modelSources?.registrySha256 ?? '')
    || !Array.isArray(index.modelSources.datasets) || !index.modelSources.datasets.length
    || !index.zones || Array.isArray(index.zones) || typeof index.zones !== 'object') {
    throw new Error('分区点阵索引与音乐分区不一致');
  }
  const zoneIds = new Set(bgm.zones.map(({id}) => String(id)));
  let offset = 0;
  for (const [id, entry] of Object.entries(index.zones).sort((a, b) => a[1].offset - b[1].offset)) {
    if (!zoneIds.has(id) || entry.offset !== offset || !Number.isInteger(entry.count) || entry.count < 1
      || !Number.isInteger(entry.modelCount) || entry.modelCount < 0 || entry.modelCount > entry.count) {
      throw new Error(`分区点阵段无效 ${id}`);
    }
    offset += reliefBlockBytes(entry);
  }
  if (offset !== index.bytes) throw new Error('分区点阵字节数不符');
  return ['relief/index.json', `relief/${index.file}`];
}

export function tileFileNames(tiles) {
  const files = [];
  for (const [name, map] of Object.entries(tiles.maps)) {
    if (!/^[A-Za-z]+$/.test(name)
      || !Number.isInteger(map.maxTileZoom) || map.maxTileZoom < 0
      || ![map.imageWidth, map.imageHeight].every((size) => Number.isInteger(size) && size > 0)
      || map.maxDim !== Math.max(map.imageWidth, map.imageHeight)
      || !Number.isInteger(map.tileSize) || map.tileSize <= 0
      || map.tileSize * 2 ** map.maxTileZoom > map.maxDim) {
      throw new Error(`无效瓦片索引 ${name}`);
    }
    for (let zoom = 0; zoom <= map.maxTileZoom; zoom += 1) {
      const span = map.maxDim / 2 ** zoom;
      for (let x = 0; x < Math.ceil(map.imageWidth / span); x += 1) {
        for (let y = 0; y < Math.ceil(map.imageHeight / span); y += 1) {
          files.push(`tiles/${name}/${zoom}/${x}/${y}.webp`);
        }
      }
    }
    if (map.native) {
      const {imageWidth, imageHeight, tileSize, level, tiles: keys, sourceIdentity} = map.native;
      if (imageWidth !== map.imageWidth * 2 || imageHeight !== map.imageHeight * 2
        || tileSize !== map.tileSize || level !== map.maxTileZoom + 1
        || !/^[a-f0-9]{64}$/.test(sourceIdentity) || !Array.isArray(keys) || !keys.length
        || new Set(keys).size !== keys.length) throw new Error(`无效原图瓦片索引 ${name}`);
      for (const key of keys) {
        if (!/^\d+\/\d+$/.test(key)) throw new Error(`非法原图瓦片坐标 ${key}`);
        const [x, y] = key.split('/').map(Number);
        if (x * tileSize >= imageWidth || y * tileSize >= imageHeight) {
          throw new Error(`原图瓦片坐标超限 ${key}`);
        }
        files.push(`tiles/${name}/${level}/${key}.webp`);
      }
    }
  }
  return files;
}

export function layerFileNames(layers) {
  return [...new Set(layers.layers.map(({image}) => {
    if (!/^[A-Za-z]+\/UI_Map_LayeredMap_\d+\.webp$/.test(image)) {
      throw new Error(`非法楼层贴片路径 ${image}`);
    }
    return `layers/${image}`;
  }))];
}
