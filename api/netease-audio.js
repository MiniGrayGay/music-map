// 网易云外链解析兜底：只读公开元数据接口换取官方 CDN 地址，307 交给浏览器直连。
// 绝不代理或传输音频字节，绝不缓存、硬编码或记录签名地址。曲目 id 仅来自既有曲库白名单。
import catalog from '../src/features/bgm/netease-tracks.json' with {type: 'json'};

const upstreamHosts = [
  'https://music.163.com',
  'https://interface.music.163.com',
];
const upstreamPath = '/api/song/enhance/player/url';
const perRequestTimeoutMs = 2500;
const totalDeadlineMs = 5500;

// 白名单：catalog.tracks 的对象键是内部 Wwise ID，公开曲目 id 在各条目的 id 字段。
const publicTrackIds = new Set(Object.values(catalog.tracks).map(({id}) => String(id)));

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

// 只放行曲库里的公开曲目 id，杜绝参数里塞任意 id。
function isWhitelisted(id) {
  return /^\d+$/.test(id) && publicTrackIds.has(id);
}

async function resolveUpstreamUrl(id) {
  const query = new URLSearchParams({br: '128000', ids: `[${id}]`});
  const deadline = Date.now() + totalDeadlineMs;
  for (const host of upstreamHosts) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(perRequestTimeoutMs, remaining));
    try {
      const res = await fetch(`${host}${upstreamPath}?${query}`, {
        signal: controller.signal,
        redirect: 'error',
        headers: {accept: 'application/json'},
      });
      if (!res.ok) {
        // 立即取消响应体，不等连接自然收尾。
        await res.body?.cancel();
        continue;
      }
      const item = (await res.json())?.data?.[0];
      // 只接受完整曲目：id 对得上、code 200、非试听、有 url。
      if (item?.id === Number(id) && item.code === 200 && item.freeTrialInfo === null
        && typeof item.url === 'string' && item.url) {
        // 返回前先 canonical，得到有效 CDN 目标才采用，否则换下一个上游。
        const target = canonicalCdnUrl(item.url);
        if (target) return target;
      }
    } catch {
      // 换下一个上游继续。
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// 只放行网易云 CDN 的原始 http(s) 地址，http 升级 https；拒绝凭证、异常端口与非 126.net 音乐域。
function canonicalCdnUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  const hostname = parsed.hostname;
  if (hostname !== 'music.126.net' && !hostname.endsWith('.music.126.net')) return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  return parsed.href;
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, {error: 'method-not-allowed'});
    return;
  }
  let id;
  try {
    const parsed = new URL(request.url, `https://${request.headers.host ?? 'localhost'}`);
    id = parsed.searchParams.get('id') ?? '';
  } catch {
    id = '';
  }
  if (!isWhitelisted(id)) {
    sendJson(response, 400, {error: 'unknown-track'});
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = await resolveUpstreamUrl(id);
  } catch {
    upstreamUrl = null;
  }
  if (!upstreamUrl) {
    sendJson(response, 502, {error: 'upstream-unavailable'});
    return;
  }

  response.statusCode = 307;
  response.setHeader('location', upstreamUrl);
  response.setHeader('cache-control', 'no-store');
  response.end();
}
