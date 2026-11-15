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
