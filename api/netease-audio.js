// 网易云外链解析兜底：只读公开元数据接口换取官方 CDN 地址，307 交给浏览器直连。
// 绝不代理或传输音频字节，绝不缓存、硬编码或记录签名地址。曲目 id 仅来自既有曲库白名单。
// 诊断：并行竞速多个上游取首个成功；全部失败时 502 附带脱敏分层原因（不含完整 URL/签名/响应体）。
import catalog from '../src/features/bgm/netease-tracks.json' with {type: 'json'};
import overseasIndex from '../src/features/bgm/overseas-ost.json' with {type: 'json'};

const outerMediaHosts = ['https://music.163.com', 'https://interface3.music.163.com'];
const outerMediaPath = (id) => `/song/media/outer/url?id=${id}.mp3`;
// 海外静态 CDN：索引值必须是「正数版本目录/uuid/aac256.m4a」，样本基准为 3/uuid/aac256.m4a。
const overseasCdnBase = 'https://assets.kuutar.moe/soundtracks/';
const overseasPathPattern = /^\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/aac256\.m4a$/i;
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

// 海外索引：只收格式严格合法的映射项，坏条目直接忽略（fail-closed），绝不透传未校验路径。
const overseasPaths = new Map(
  Object.entries(overseasIndex ?? {}).flatMap(([id, path]) =>
    typeof path === 'string' && overseasPathPattern.test(path) && /^\d+$/.test(id) ? [[id, path]] : [],
  ),
);

function hasOverseasPath(id) {
  return overseasPaths.has(id);
}

// 校验过的静态路径拼接，仅由 overseasPaths 提供值，不含查询串与用户输入。
function overseasCdnUrl(id) {
  const path = overseasPaths.get(id);
  return path ? `${overseasCdnBase}${path}` : null;
}

// 307 重定向出口（海外 CDN / 官方网易云外链），带取源标记供线上验证。
function sendRedirect(response, location, source) {
  response.statusCode = 307;
  response.setHeader('location', location);
  response.setHeader('x-music-map-audio-source', source);
  response.setHeader('cache-control', 'no-store');
  response.end();
}

// 地区分流：CN 或无 Vercel 地区头 → 网易云；其他有效两位字母国家码且有海外映射 → 海外源。
function prefersOverseas(request) {
  const country = request.headers['x-vercel-ip-country'];
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country) && country !== 'CN';
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

// 失败时抛出的脱敏原因：op + 层内细节（HTTP 状态 / JSON 业务 code / 网络错误名）。
class ResolveFailure extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
  }
}

// JSON 元数据上游。resolve：成功返回 CDN 目标，失败抛 ResolveFailure。
// v1 接口（首选，公司侧实测 music.163.com / interface3.music.163.com 均 200 完整非试听）与老接口共用同一套显式校验。
async function attemptJsonApi(label, url, id, remainingMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(perRequestTimeoutMs, remainingMs)));
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: {accept: 'application/json'},
    });
  } catch (error) {
    throw new ResolveFailure(`${label}:conn-${error?.name === 'AbortError' ? 'timeout' : 'error'}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ResolveFailure(`${label}:http-${res.status}`);
  }
  let item;
  try {
    item = (await res.json())?.data?.[0];
  } catch {
    throw new ResolveFailure(`${label}:bad-json`);
  }
  if (item?.id !== Number(id)) throw new ResolveFailure(`${label}:item-mismatch`);
  if (item.code !== 200) throw new ResolveFailure(`${label}:item-${item.code}`);
  if (item.freeTrialInfo !== null) throw new ResolveFailure(`${label}:trial`);
  if (typeof item.url !== 'string' || !item.url) throw new ResolveFailure(`${label}:missing-url`);
  const target = canonicalCdnUrl(item.url);
  if (!target) throw new ResolveFailure(`${label}:bad-cdn`);
  return target;
}

// 网易云官方外链端点：服务端以 redirect:manual 请求，接受经 canonical 校验的 30x Location。
async function attemptOuterMedia(label, host, id, remainingMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(perRequestTimeoutMs, remainingMs)));
  let res;
  try {
    res = await fetch(`${host}${outerMediaPath(id)}`, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {accept: 'audio/mpeg, */*'},
    });
  } catch (error) {
    throw new ResolveFailure(`${label}:conn-${error?.name === 'AbortError' ? 'timeout' : 'error'}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status < 300 || res.status >= 400) {
    // 该端点对不可播曲目常返回 200 + HTML，绝不能当成功，也不能把 HTML 透传出去。
    await res.body?.cancel();
    throw new ResolveFailure(`${label}:http-${res.status}`);
  }
  const location = res.headers.get('location');
  await res.body?.cancel();
  if (!location) throw new ResolveFailure('outer:no-location');
  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    throw new ResolveFailure('outer:bad-location');
  }
  const target = canonicalCdnUrl(location);
  if (!target) throw new ResolveFailure(`${label}:redirect-${parsed.hostname}`);
  return target;
}

// 并行竞速所有路径，取首个成功；全部失败时聚合脱敏原因。
async function resolveUpstreamUrl(id) {
  const attempts = [];
  const start = Date.now();
  const makeRemaining = () => totalDeadlineMs - (Date.now() - start);
  // 首选：v1 接口（level=standard 非试听完整曲目），music.163.com 与 interface3 双路。
  const v1JsonUrl = (host, id) =>
    `${host}/api/song/enhance/player/url/v1?${new URLSearchParams({level: 'standard', encodeType: 'mp3', ids: `[${id}]`})}`;
  attempts.push(attemptJsonApi('music-json', v1JsonUrl('https://music.163.com', id), id, makeRemaining()));
  attempts.push(attemptJsonApi('interface3-json', v1JsonUrl('https://interface3.music.163.com', id), id, makeRemaining()));
  attempts.push(attemptOuterMedia('outer', outerMediaHosts[0], id, makeRemaining()));
  attempts.push(attemptOuterMedia('interface3-outer', outerMediaHosts[1], id, makeRemaining()));
  // 保留：老接口一路兜底。
  const legacyQuery = new URLSearchParams({br: '128000', ids: `[${id}]`});
  attempts.push(attemptJsonApi(
    'interface-json',
    `https://interface.music.163.com/api/song/enhance/player/url?${legacyQuery}`,
    id,
    makeRemaining(),
  ));
  try {
    return await Promise.any(attempts);
  } catch (error) {
    if (error instanceof AggregateError) {
      // 顺序与 attempts 一致，拼出可读的分层诊断串，如
      // "music-json:item-mismatch;interface3-json:http-403;outer:redirect-music.163.com;..."。
      throw new Error(error.errors.map((e) => e?.detail ?? 'unknown').join(';'));
    }
    throw error;
  }
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, {error: 'method-not-allowed'});
    return;
  }
  let id;
  let route;
  try {
    const parsed = new URL(request.url, `https://${request.headers.host ?? 'localhost'}`);
    id = parsed.searchParams.get('id') ?? '';
    route = parsed.searchParams.get('route') ?? '';
  } catch {
    id = '';
    route = '';
  }
  if (!isWhitelisted(id)) {
    sendJson(response, 400, {error: 'unknown-track'});
    return;
  }
  if (route !== '' && route !== 'primary' && route !== 'alternate') {
    sendJson(response, 400, {error: 'unknown-route'});
    return;
  }

  // 分流决策（只决定 307 目标，绝不代理音频字节）：
  // - 无 route（旧前端）：主路已失效，有海外映射即走海外源；未映射保留网易云已有处理。
  // - primary：非 CN 有效地区且有映射 → 海外源；其余走网易云已有处理。
  // - alternate：有映射时换另一路（海外主路换网易云，网易云主路换海外源）；未映射同 primary。
  const overseas = hasOverseasPath(id);
  const overseasPreferred = prefersOverseas(request);
  let useOverseas = overseas;
  if (route === 'primary') useOverseas = overseas && overseasPreferred;
  else if (route === 'alternate') useOverseas = overseas && !overseasPreferred;

  if (useOverseas) {
    sendRedirect(response, overseasCdnUrl(id), 'overseas');
    return;
  }

  // 中国访问（及真实海外初选失败回退）不走 Vercel 服务端解析：服务端对网易云常 502，
  // 改为立即 307 到官方外链端点，由浏览器直连换取 CDN 地址。
  if (route === 'primary' || (route === 'alternate' && overseasPreferred && overseas)) {
    sendRedirect(response, `${outerMediaHosts[0]}${outerMediaPath(id)}`, route === 'primary' ? 'netease/primary' : 'netease/alternate-overseas');
    return;
  }

  let upstreamUrl;
  let failureDetail;
  try {
    upstreamUrl = await resolveUpstreamUrl(id);
  } catch (error) {
    failureDetail = typeof error?.message === 'string' && error.message ? error.message : undefined;
    upstreamUrl = null;
  }
  if (!upstreamUrl) {
    sendJson(response, 502, failureDetail
      ? {error: 'upstream-unavailable', detail: failureDetail}
      : {error: 'upstream-unavailable'});
    return;
  }

  sendRedirect(response, upstreamUrl, 'netease/resolved');
}
