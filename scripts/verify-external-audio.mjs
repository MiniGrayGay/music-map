import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {resolveMusic} from '../src/features/bgm/musicGraph.js';
import {parseByteRange} from './byte-range.mjs';
import {exportStaticSite} from './export-static-site.mjs';
import {readReleaseDocument} from './release-data.mjs';

const project = path.resolve(import.meta.dirname, '..');
const release = path.join(project, 'dist');
const qa = path.resolve(process.env.TEYVAT_QA_DIR
  ?? path.join(project, '../../cache/teyvat-external-audio'));
const mediaRequests = [];
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.opus': 'audio/ogg; codecs=opus',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function startServer(root, {media = false} = {}) {
  let rejected;
  const held = new Map();
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (media && !/^\/music\/\d+\.opus$/.test(pathname)) {
      response.writeHead(404).end();
      return;
    }
    const relative = media ? path.basename(pathname)
      : pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const info = await lstat(file);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      if (media && relative === rejected) {
        mediaRequests.push({relative, status: 503});
        response.writeHead(503).end();
        return;
      }
      if (held.has(relative)) await held.get(relative).ready;
      if (response.destroyed) return;
      const range = request.method === 'GET' ? parseByteRange(request.headers.range, info.size) : null;
      if (range?.unsatisfiable) {
        response.writeHead(416, {'Content-Range': `bytes */${info.size}`}).end();
        return;
      }
      const {start, end} = range ?? {start: 0, end: info.size - 1};
      const headers = {
        'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      const status = range ? 206 : 200;
      if (media) mediaRequests.push({relative, status, range: request.headers.range});
      response.writeHead(status, headers);
      if (request.method === 'HEAD') response.end();
      else {
        const stream = createReadStream(file, {start, end});
        stream.once('error', () => response.destroy());
        response.once('close', () => stream.destroy());
        stream.pipe(response);
      }
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    reject(id) { rejected = id === undefined ? undefined : `${id}.opus`; },
    hold(id) {
      const relative = `${id}.opus`;
      const {promise, resolve} = Promise.withResolvers();
      held.set(relative, {ready: promise, release: resolve});
      return () => {
        held.delete(relative);
        resolve();
      };
    },
    close() {
      for (const {release} of held.values()) release();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

let media;
let site;
let browser;
try {
  await mkdir(qa, {recursive: true});
  media = await startServer(path.join(release, 'region-bgm-audio'), {media: true});
  const output = path.join(qa, 'site');
  const firstExport = await exportStaticSite({source: release, output, audioBase: `${media.origin}/old`});
  const [faviconSource, faviconSnapshot] = await Promise.all([release, output].map((directory) =>
    lstat(path.join(directory, 'favicon.svg'), {bigint: true})));
  assert.ok(faviconSource.dev !== faviconSnapshot.dev || faviconSource.ino !== faviconSnapshot.ino,
    '导出文件必须与下次构建可能改写的源文件独立');
  const exported = await exportStaticSite({source: release, output, audioBase: `${media.origin}/music`});
  assert.equal(exported.files, firstExport.files);
  const ownNote = path.join(output, 'local-note.txt');
  await writeFile(ownNote, 'must survive', {flag: 'wx'});
  await assert.rejects(exportStaticSite({source: release, output, audioBase: `${media.origin}/rejected`}),
    /未登记/);
  assert.equal(await readFile(ownNote, 'utf8'), 'must survive');
  await rename(ownNote, path.join(qa, 'local-note.txt'));
  console.log('重复导出已切换地址，验证失败时原站点和其他文件保留');
  assert.ok(exported.bytes - exported.reliefBytes < 100_000_000);
  console.log(`独立音频发布目录 ${exported.files} 个文件，${(exported.bytes / 1e6).toFixed(1)} MB`);
  site = await startServer(output);
  console.log(`临时站点 ${site.origin}，临时音频源 ${media.origin}`);
  assert.equal((await fetch(`${site.origin}/region-bgm-audio/128266555.opus`)).status, 404);

  assert.equal((await fetch(`${site.origin}/data/genshin-region-bgm.json`)).status, 404);
  const manifest = await readReleaseDocument(output, 'data/genshin-region-bgm.json');
  assert.equal(manifest.musicGraph.audioBaseUrl, `${media.origin}/music/`);
  const zone = manifest.zones.find((item) => item.state === 'State_MengDe');
  const graph = manifest.musicGraph;
  const state = manifest.music[zone.state].wwiseId;
  const day = resolveMusic(graph, state, 'exploration').conditions.find((group) => group.title === '昼夜');
  const daytime = day.entries.find((entry) => entry.label === '白天');
  const [first, second] = resolveMusic(graph, state, 'exploration', {[day.id]: daytime.key}).tracks;
  assert.ok(first && second && first.url.startsWith(`${media.origin}/music/`));

  const suffix = await fetch(first.url, {headers: {Range: 'bytes=-32'}});
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 32);
  const invalid = await fetch(first.url, {headers: {Range: 'bytes=900000000-'}});
  assert.equal(invalid.status, 416);
  await invalid.arrayBuffer();

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    userDataDir: path.join(qa, 'external-chrome'),
    args: ['--mute-audio', '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({width: 390, height: 844, hasTouch: true, deviceScaleFactor: 1});
  await page.goto(site.origin, {waitUntil: 'domcontentloaded'});
  const releaseFirst = media.hold(first.id);
  const search = 'input[aria-label="跳转到地点"]';
  await page.waitForSelector('.globe-canvas', {visible: true});
  await page.waitForSelector('.globe-status', {hidden: true});
  await page.click(search);
  await page.type(search, zone.name);
  await page.waitForSelector('.globe-results[data-panel-open] button');
  await page.keyboard.press('Enter');
  const daytimeSelector = `button[data-value="${daytime.key}"]`;
  await page.waitForSelector(daytimeSelector, {visible: true});
  await page.click(daytimeSelector);
  const playing = (url) => page.waitForFunction((expected) => {
    const element = document.querySelector('audio');
    return element?.currentSrc === expected && !element.paused && element.currentTime > 0;
  }, {timeout: 15000}, url);
  const slider = await page.$('input[aria-label="播放进度"]');
  const rect = await slider.boundingBox();
  await page.waitForFunction(() => {
    const element = document.querySelector('audio');
    return element.readyState === 0;
  });
  await page.mouse.click(rect.x + rect.width * 0.68, rect.y + rect.height / 2);
  assert.ok(await slider.evaluate((input) => Number(input.value) > Number(input.max) / 2));
  releaseFirst();
  await playing(first.url);
  await page.waitForFunction(() => {
    const element = document.querySelector('audio');
    return !element.seeking && element.currentTime > element.duration / 2;
  });
  console.log('音轨信息加载前拖动进度，加载后从所选位置开始播放');
  assert.ok(mediaRequests.some(({relative, status, range}) => relative === `${first.id}.opus`
    && status === 206 && range?.startsWith('bytes=0-')));

  await page.click('button[aria-label="暂停"]');
  await page.mouse.click(rect.x + rect.width * 0.38, rect.y + rect.height / 2);
  await page.waitForFunction(() => {
    const element = document.querySelector('audio');
    return element.paused && !element.seeking
      && element.currentTime > 0.2 * element.duration && element.currentTime < 0.5 * element.duration;
  }, {timeout: 10000});

  media.reject(second.id);
  await page.click('button[aria-label="下一首"]');
  await page.waitForSelector('button[aria-label="重试播放"]', {visible: true});
  assert.ok(mediaRequests.some(({relative, status}) => relative === `${second.id}.opus` && status === 503));
  media.reject();
  await page.click('button[aria-label="重试播放"]');
  await playing(second.url);
  assert.equal(await page.$('.playback-status'), null);

  const releaseStalled = media.hold(first.id);
  await page.click('button[aria-label="上一首"]');
  await page.waitForFunction((url) => {
    const element = document.querySelector('audio');
    return element.currentSrc === url && element.readyState === 0;
  }, {}, first.url);
  await page.waitForSelector('button[aria-label="暂停"][aria-busy="true"]', {visible: true});
  await page.click('button[aria-label="暂停"]');
  await page.waitForSelector('button[aria-label="播放"]', {visible: true});
  await page.mouse.click(rect.x + rect.width * 0.62, rect.y + rect.height / 2);
  await page.click('button[aria-label="播放"]');
  await page.waitForFunction(() => document.querySelector('.playback-status')?.textContent
    === '音源响应超时', {timeout: 25000});
  assert.ok(await page.$eval('audio', (element) => element.paused && !element.hasAttribute('src')));
  assert.ok(await slider.evaluate((input) => Number(input.value) > Number(input.max) / 2));
  releaseStalled();
  await page.screenshot({path: path.join(qa, 'external-timeout.png')});
  await page.click('button[aria-label="重试播放"]');
  await playing(first.url);
  await page.waitForFunction(() => {
    const element = document.querySelector('audio');
    return !element.seeking && element.currentTime > element.duration / 2;
  });
  assert.equal(await page.$('.playback-status'), null);
  console.log('无响应的音源可以暂停等待，超时后保留选曲与进度，并从所选位置重试播放');

  assert.deepEqual(errors, []);
  await page.screenshot({path: path.join(qa, 'external-playback.png')});
  console.log('浏览器通过独立源播放、暂停定位、切歌和故障重试，站点目录无音频文件');
} finally {
  await browser?.close();
  await Promise.all([site?.close(), media?.close()]);
}
