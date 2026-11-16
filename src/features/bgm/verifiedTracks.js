// 经人工核实的曲目关联：清单解析为空时按楼层+区域兜底接入。
// 来源：用户现场、官方原声与音频纹理核实（外部地点资料
// https://genshin-impact.fandom.com/wiki/Nursery_of_Nightmares）。
// 初始试听预设：由 scripts/render-initial-music-previews.mjs 生成的渲染产物清单，
// id 为图内真实 segment 节点 ID（issue 为 multipleSourcesPerSegment 的补曲来源）。
import initialMusicPreviews from './initialMusicPreviews.json' with { type: 'json' };

export const VERIFIED_TRACKS = [
  {
    floor: '3:3490801',
    area: 60609,
    id: 618610642,
    name: '造始的噩兆',
    duration: 88.63,
    audioSha256: 'a44b2f272d865d90306a0a0fce52c97c7a08de6b56c9484557387124af6a5b2b',
  },
];

export const INITIAL_MUSIC_PREVIEW_VERSION = initialMusicPreviews.clientVersion;
if (typeof INITIAL_MUSIC_PREVIEW_VERSION !== 'string' || !INITIAL_MUSIC_PREVIEW_VERSION
  || !Array.isArray(initialMusicPreviews.entries)) {
  throw new Error('初始试听清单结构非法');
}
export const INITIAL_MUSIC_PREVIEWS = initialMusicPreviews.entries.map((entry) => {
  if (!Number.isSafeInteger(entry.id) || entry.id <= 0
    || (entry.name !== null && (typeof entry.name !== 'string' || !entry.name.trim()))
    || !Number.isFinite(entry.duration) || entry.duration <= 0
    || !/^[a-f0-9]{64}$/i.test(entry.audioSha256 ?? '')) {
    throw new Error(`非法初始试听条目 ${entry?.id}`);
  }
  return {id: entry.id, name: entry.name, duration: entry.duration, audioSha256: entry.audioSha256};
});

const previewBySegment = new Map(INITIAL_MUSIC_PREVIEWS.map((entry) => [entry.id, entry]));

export function initialPreviewFor(segmentId) {
  return previewBySegment.get(segmentId) ?? null;
}

// 以规范源 ID（字符串化 media id）去重：多个楼层/区域共用同一音源属正常，
// 但同一源出现不一致的时长或指纹时立即报错，绝不凭标签合并。
export function dedupeVerifiedTracks(tracks) {
  const bySource = new Map();
  for (const track of tracks) {
    const id = String(track?.id);
    if (!/^\d+$/.test(id) || !Number.isFinite(track.duration) || track.duration <= 0
      || !/^[a-f0-9]{64}$/i.test(track.audioSha256 ?? '')) {
      throw new Error(`非法已核实兜底音轨 ${id}`);
    }
    const previous = bySource.get(id);
    if (!previous) {
      bySource.set(id, track);
    } else if (previous.duration !== track.duration
      || previous.audioSha256.toLowerCase() !== track.audioSha256.toLowerCase()) {
      throw new Error(`已核实兜底音轨 ${id} 的时长或指纹不一致`);
    }
  }
  return [...bySource.values()];
}

// 两个打包者共用的完整同站音频集合：楼层兜底曲 + 初始试听补曲，
// 以规范源 ID（字符串化）去重，同源不一致立即报错。
export function mergedVerifiedTracks() {
  return dedupeVerifiedTracks([...VERIFIED_TRACKS, ...INITIAL_MUSIC_PREVIEWS]);
}

export function verifiedTrackFor(floor, area) {
  return VERIFIED_TRACKS.find((row) => row.floor === floor && row.area === area) ?? null;
}
