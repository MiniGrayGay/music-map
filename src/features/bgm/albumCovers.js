// 原专辑封面索引：沿用旧站点核实过的 track→专辑映射（HOYO-MiX 曲目 id 与
// 本清单 musicGraph.media/SegmentID 同一 id 空间），封面与署名随源码打包，
// 构建时由 Vite 哈希引用；无匹配时回退占位音符，不猜专辑名。
import index from './album-covers/album-covers.json';

const coverUrls = import.meta.glob('./album-covers/*.jpg', {eager: true, query: '?url', import: 'default'});

export function albumForTrack(id) {
  const albumId = index.tracks[String(id)];
  const album = albumId ? index.albums[albumId] : null;
  if (!album) return null;
  const url = coverUrls[`./album-covers/${album.file}`];
  return url ? {title: album.title, source: album.source, url} : null;
}
