const SUPPORTED_DATA_VERSION = '7.2.0';

export async function loadMapData() {
  const [dataResponse, indexResponse] = await Promise.all([
    fetch('/data/map-data.json'),
    fetch('/tiles/meta.json'),
  ]);
  if (!dataResponse.ok) {
    throw new Error(`map-data.json 加载失败（HTTP ${dataResponse.status}）；先运行 pnpm run data`);
  }
  if (!indexResponse.ok) {
    throw new Error(`tiles/index.json 加载失败（HTTP ${indexResponse.status}）；先运行 pnpm run tiles`);
  }
  const raw = await dataResponse.json();
  const tilesIndex = await indexResponse.json();
  if (raw.format !== 'teyvat-region-map-data-v1') {
    throw new Error(`map-data.json 格式不识别：${raw.format}`);
  }
  if (raw.dataVersion !== SUPPORTED_DATA_VERSION) {
    throw new Error(`地图数据版本 ${raw.dataVersion} 不是当前客户端 ${SUPPORTED_DATA_VERSION}；请重新生成`);
  }
  if (tilesIndex.format !== 'teyvat-map-editor-pyramid-v1') {
    throw new Error(`瓦片索引格式不识别：${tilesIndex.format}`);
  }
  const pyramid = tilesIndex.maps?.Teyvat;
  if (tilesIndex.version !== raw.dataVersion || !pyramid
    || pyramid.imageWidth !== raw.canvas.width * 4 || pyramid.imageHeight !== raw.canvas.height * 4) {
    throw new Error('瓦片版本或画布坐标与 7.2 地图不一致');
  }
  return {
    canvas: raw.canvas,
    pyramid,
    pyramids: tilesIndex.maps,
    seaColor: '#163c4c',
    dataVersion: raw.dataVersion,
  };
}
