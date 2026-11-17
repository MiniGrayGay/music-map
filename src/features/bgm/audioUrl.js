export function normalizeAudioBase(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError('音频地址必须是字符串');
  const base = new URL(value.trim());
  if (!['http:', 'https:'].includes(base.protocol)
    || base.username || base.password || base.search || base.hash) {
    throw new Error('音频来源必须是公开的 HTTP 或 HTTPS 目录');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base.href;
}

const configuredBase = normalizeAudioBase(import.meta.env?.VITE_AUDIO_BASE_URL?.trim());

export function audioUrl(id, audioBase = configuredBase) {
  const file = `${id}.opus`;
  return audioBase ? new URL(file, audioBase).href : `./region-bgm-audio/${file}`;
}
