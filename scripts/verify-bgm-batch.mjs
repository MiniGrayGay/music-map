import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {access, lstat, mkdir, readFile, readdir, realpath, stat, statfs} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual, parseArgs, promisify} from 'node:util';
import puppeteer from 'puppeteer-core';
import {preview} from 'vite';
import {normalizeAudioBase} from '../src/features/bgm/audioUrl.js';
import {
  INITIAL_MUSIC_PREVIEW_VERSION, mergedVerifiedTracks,
} from '../src/features/bgm/verifiedTracks.js';

const run = promisify(execFile);
const project = path.resolve(import.meta.dirname, '..');
const dist = path.join(project, 'dist');
const hostedDist = path.join(dist, 'site');
const cacheParent = path.resolve(project, '../../cache');
const qaRoot = path.join(cacheParent, 'teyvat-audio-matrix-test');
const cache = path.join(qaRoot, 'session');
const profile = path.join(cache, 'chrome-profile');
const removeDirectory = 'E:/tools/Remove-Directory.ps1';
const assetRoute = '/region-bgm-audio/';
const probeRoute = '/__teyvat_audio_probe__';
const concurrency = 16;
const durationTolerance = 0.2;
const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const {values} = parseArgs({options: {limit: {type: 'string'}}});
const limit = values.limit === undefined ? undefined : Number(values.limit);
assert.ok(limit === undefined || (Number.isSafeInteger(limit) && limit > 0),
  '--limit 需要正整数，仅用于自检');

async function loadManifest(directory) {
  const filename = path.join(directory, 'data/genshin-region-bgm.json');
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function audioInventory(directory, tracks) {
  const audioDir = path.join(directory, 'region-bgm-audio');
  const ids = new Set(tracks.map(({id}) => id));
  assert.equal(ids.size, tracks.length, `音源编号重复 ${directory}`);
  const files = await readdir(audioDir, {withFileTypes: true});
  const available = new Set(files.filter((file) => file.isFile() && /^\d+\.opus$/.test(file.name))
    .map((file) => file.name));
  const missing = tracks.filter(({id}) => !available.has(`${id}.opus`)).map(({id}) => id);
  const extra = [...available].filter((file) => !ids.has(Number(path.basename(file, '.opus'))));
  assert.ok(missing.length === 0 && extra.length === 0,
    `音频目录与清单不一致 ${directory}，缺少 ${missing}，多出 ${extra}`);
  return Promise.all(tracks.map(async ({id, duration}) => {
    assert.ok(Number.isSafeInteger(id) && id > 0 && Number.isFinite(duration) && duration > 0,
      `音源 ${id} 的编号或时长无效`);
    const filename = `${id}.opus`;
    const {size} = await stat(path.join(audioDir, filename));
    assert.ok(size > 4, `空音源 ${directory}/${filename}`);
    return {id, duration, size, url: assetRoute + filename};
  }));
}

async function verifyReachability(assets, clientVersion) {
  const auditScript = path.join(import.meta.dirname, 'audit-region-bgm.mjs');
  const {stdout} = await run(process.execPath, [auditScript, '--json'], {
    cwd: project,
    windowsHide: true,
  });
  const audit = JSON.parse(stdout);
  assert.equal(audit.manifest.clientVersion, clientVersion);
  assert.equal(audit.scope, 'reachable');
  assert.deepEqual(audit.modesAudited, ['exploration', 'combat']);
  assert.ok(audit.auditedZones > 0, '可达分区为空');
  assert.equal(audit.defaultPaths, audit.auditedZones * audit.modesAudited.length);
  assert.deepEqual(audit.missingOpus.items, [], '已解析音源存在缺失文件');
  assert.ok(audit.resolvedMediaIds.length, '可达路径没有解析出音源');
  const assetIds = new Set(assets.map(({id}) => id));
  const outsideInventory = audit.resolvedMediaIds.filter((id) => !assetIds.has(id));
  assert.deepEqual(outsideInventory, [], '地图路径引用了包清单之外的音源');
  return {
    zones: audit.auditedZones,
    modes: audit.modesAudited,
    defaultPaths: audit.defaultPaths,
    conditionPaths: audit.conditionPaths.count,
    resolvedMedia: audit.resolvedMediaIds.length,
    findings: Object.fromEntries(Object.entries(audit.findings).map(([key, value]) =>
      [key, value.count])),
    incompleteConditionGroups: audit.conditionPaths.incompleteGroups,
  };
}

function servePackage(directory) {
  return preview({
    configFile: false,
    root: project,
    publicDir: false,
    appType: 'custom',
    build: {outDir: directory},
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      headers: {'Cache-Control': 'no-store'},
    },
    plugins: [{
      name: 'teyvat-batch-audio-probe',
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== probeRoute) {
            next();
            return;
          }
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end('<!doctype html><title>音频批量验收</title>');
        });
      },
    }],
  });
}

async function playPackage(page, server, assets, label) {
  const {port} = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${port}${probeRoute}`, {waitUntil: 'domcontentloaded'});
  const sample = limit === undefined ? assets : assets.slice(0, limit);
  const results = await page.evaluate(async (entries, parallel, tolerance) => {
    async function verifyResponse(asset) {
      const opts = {cache: 'no-store', redirect: 'error'};
      const [head, prefix] = await Promise.all([
        fetch(asset.url, {...opts, method: 'HEAD', signal: AbortSignal.timeout(12000)}),
        fetch(asset.url, {...opts, headers: {Range: 'bytes=0-3'},
          signal: AbortSignal.timeout(12000)}),
      ]);
      const length = Number(head.headers.get('content-length'));
      if (!head.ok || length !== asset.size) {
        await prefix.body?.cancel();
        throw new Error(`HEAD HTTP ${head.status}，长度 ${length} 字节，期待 ${asset.size} 字节`);
      }
      if (prefix.status !== 206 || prefix.headers.get('content-range') !== `bytes 0-3/${asset.size}`) {
        await prefix.body?.cancel();
        throw new Error(`音源首 4 字节范围返回错误 HTTP ${prefix.status}`);
      }
      if (await prefix.text() !== 'OggS') throw new Error('音源缺少 OggS 文件头');
    }

    async function play(asset) {
      try {
        await verifyResponse(asset);
        return await new Promise((resolve) => {
          const audio = new Audio();
          let finished = false;
          const timer = setTimeout(() => finish('播放未推进'), 10000);
          function finish(error) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            const result = {
              id: asset.id,
              duration: audio.duration,
              progress: audio.currentTime,
              ...(error ? {error} : {}),
            };
            audio.onloadedmetadata = null;
            audio.ontimeupdate = null;
            audio.onerror = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            resolve(result);
          }
          audio.muted = true;
          audio.onloadedmetadata = () => {
            if (!Number.isFinite(audio.duration) || audio.duration <= 0
              || Math.abs(audio.duration - asset.duration) > tolerance) {
              finish(`时长 ${audio.duration} 秒，期待 ${asset.duration} 秒`);
            }
          };
          audio.onerror = () => finish(audio.error?.message || '媒体解码失败');
          audio.ontimeupdate = () => {
            if (!audio.paused && audio.currentTime >= Math.min(0.12, asset.duration / 2)) finish();
          };
          audio.src = asset.url;
          audio.play().catch((error) => finish(error.message));
        });
      } catch (error) {
        return {id: asset.id, error: error.message};
      }
    }

    let next = 0;
    const results = [];
    await Promise.all(Array.from({length: Math.min(parallel, entries.length)}, async () => {
      while (next < entries.length) {
        const index = next++;
        results[index] = await play(entries[index]);
      }
    }));
    return results;
  }, sample, concurrency, durationTolerance);
  const errors = results.filter(({error}) => error);
  return {label, origin: `http://127.0.0.1:${port}`, expected: assets.length,
    tested: results.length, passed: results.length - errors.length,
    sourceBytes: sample.reduce((total, asset) => total + asset.size, 0), errors};
}

async function logicalBytes(directory) {
  const entries = await readdir(directory, {withFileTypes: true, recursive: true});
  const sizes = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = path.join(entry.parentPath, entry.name);
    const file = await stat(filename, {bigint: true}).catch((error) => {
      if (error.code === 'ENOENT') return null; // Chrome 可能刚好关闭并清除自己的日志。
      throw error;
    });
    if (!file) continue;
    sizes.set(file.ino === 0n ? filename : `${file.dev}:${file.ino}`, file.size);
  }
  return Number([...sizes.values()].reduce((total, size) => total + size, 0n));
}

async function removeCache(directory) {
  assert.equal(await realpath(directory), directory, '音频验收缓存已被替换');
  const {stdout} = await run('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', removeDirectory, '-Path', directory,
  ], {windowsHide: true});
  console.log(stdout.trim());
  await assert.rejects(lstat(directory), {code: 'ENOENT'});
}

const [localManifest, hostedManifest] = await Promise.all([
  loadManifest(dist),
  loadManifest(hostedDist),
]);
const {audioBaseUrl: localBase, ...localGraph} = localManifest.musicGraph;
const {audioBaseUrl: hostedBase, ...hostedGraph} = hostedManifest.musicGraph;
assert.equal(localManifest.clientVersion, INITIAL_MUSIC_PREVIEW_VERSION);
assert.equal(normalizeAudioBase(localBase), undefined, '本机成品应读取本地音频');
assert.ok(normalizeAudioBase(hostedBase), '站点成品缺少独立音频源设置');
assert.ok(isDeepStrictEqual(
  {...localManifest, musicGraph: localGraph},
  {...hostedManifest, musicGraph: hostedGraph},
), '本机与站点的音区和音源清单不一致');

const native = Object.entries(localGraph.media).map(([key, track]) => ({
  id: Number(key),
  duration: track.duration,
}));
const supplemental = mergedVerifiedTracks();
const [localAssets, hostedAssets] = await Promise.all([
  audioInventory(dist, [...native, ...supplemental]),
  audioInventory(hostedDist, supplemental),
]);

assert.equal(await realpath(cacheParent), cacheParent, '工作区 cache 路径不符');
await Promise.all([access(chrome), access(removeDirectory)]);
const free = await statfs(cacheParent, {bigint: true});
assert.ok(free.bavail * free.bsize >= 128_000_000n, '没有足够空间启动独立 Chrome profile');
console.log(JSON.stringify({cache, use: '单个临时 Chrome profile 和两路本机 Vite 预览',
  cleanup: '验收结束时关闭预览和浏览器并清理', parallel: concurrency}));
// 启动 pnpm 时可把其临时区放在 qaRoot。已有根目录由启动者负责，命令只清理自己创建的会话。
const createdRoot = await mkdir(qaRoot).then(() => true, (error) => {
  if (error.code !== 'EEXIST') throw error;
  return false;
});
assert.equal(await realpath(qaRoot), qaRoot, '音频验收根目录不符');

const servers = [];
let browser;
let context;
let createdCache = false;
try {
  await mkdir(cache);
  createdCache = true;
  process.env.TEMP = cache;
  process.env.TMP = cache;
  console.log(JSON.stringify({
    reachability: await verifyReachability(localAssets, localManifest.clientVersion),
    inventory: {native: native.length, supplemental: supplemental.length,
      local: localAssets.length, hosted: hostedAssets.length},
  }));
  for (const directory of [dist, hostedDist]) {
    const server = await servePackage(directory);
    servers.push(server);
    console.log(JSON.stringify({directory, port: server.httpServer.address().port, pid: process.pid}));
  }
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run',
      '--disable-crash-reporter', '--disable-background-networking'],
  });
  console.log(JSON.stringify({chromePid: browser.process()?.pid, profile}));
  // 默认 profile 的媒体缓存和 Blob 存储均可能写入大文件。使用独立隐私上下文，
  // 验收页面直接播放 Vite 的 HTTP 音源，结束后关闭该上下文。
  context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setCacheEnabled(false);
  const local = await playPackage(page, servers[0], localAssets, 'dist');
  const hosted = await playPackage(page, servers[1], hostedAssets, 'dist/site 随包音源');
  console.log(JSON.stringify({mode: limit === undefined ? 'full' : 'sample', local, hosted}));
  console.log(JSON.stringify({activeSessionLogicalBytes: await logicalBytes(cache)}));
  if (local.errors.length || hosted.errors.length) process.exitCode = 1;
} finally {
  try {
    await context?.close();
  } finally {
    try {
      const closed = await Promise.allSettled([browser?.close(), ...servers.map((server) => server.close())]);
      if (browser) console.log(JSON.stringify({
        profileLogicalBytes: await logicalBytes(profile),
        sessionLogicalBytes: await logicalBytes(cache),
      }));
      const failures = closed.filter(({status}) => status === 'rejected').map(({reason}) => reason);
      if (failures.length) throw new AggregateError(failures, '未能关闭音频验收资源');
    } finally {
      if (createdRoot) await removeCache(qaRoot);
      else if (createdCache) await removeCache(cache);
    }
  }
}
