// 生产样式无头验收：启动 vite preview（隐藏窗口，5177），用本机 Chrome headless
// 走完 7.2 加载 → 悬停高亮 → 指轮缩放 → 拖动 → 触屏点选 → 键盘 → 复位 → 窄窗，
// 断言真实渲染状态（解码、自然尺寸、像素非黑、命中一致性、海色、WebP MIME），
// 截图仅保存到 cache/teyvat-region-map/screenshots，不做任何外部上传。

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import {resolveMusic} from '../src/features/bgm/musicGraph.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(projectDir, '..', '..');
const qaDir = process.env.TEYVAT_QA_DIR ?? path.join(workspaceRoot, 'cache', 'teyvat-region-map');
const shotDir = path.join(qaDir, 'screenshots');
const chromeProfile = path.join(qaDir, 'chrome-profile');
const chromePath = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = Number(process.env.PORT ?? 5177);

const failures = [];
let previewProcess = null;
let browser = null;

function check(condition, label) {
  const ok = Boolean(condition);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

function worldState(page) {
  return page.evaluate(() => {
    const world = document.querySelector('.world');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    const raster = document.querySelector('canvas.tile-layer');
    return {
      scale: matrix.a,
      tx: matrix.e,
      ty: matrix.f,
      dataVersion: document.documentElement.dataset.mapVersion ?? null,
      level: Number(raster.dataset.level),
      tiles: Number(raster.dataset.visible),
      settledTiles: Number(raster.dataset.ready),
      failed: raster.dataset.failed ?? null,
      hoverRegion: document.querySelector('path[data-hovered]')?.dataset.zoneKey ?? null,
      selectedRegion: document.querySelector('path[data-zone-key][aria-current="true"]')?.dataset.zoneKey ?? null,
      tooltipName: document.querySelector('.region-tooltip .name')?.textContent ?? null,
    };
  });
}

async function waitTilesDecoded(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const stats = document.querySelector('canvas.tile-layer')?.dataset;
    return stats && Number(stats.visible) > 0 && stats.ready === stats.visible;
  }, {timeout});
}

function assertTilesPainted(page) {
  return page.evaluate(() => {
    const raster = document.querySelector('canvas.tile-layer');
    const sample = document.createElement('canvas');
    sample.width = 144;
    sample.height = 90;
    const ctx = sample.getContext('2d');
    ctx.drawImage(raster, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let terrain = 0;
    let black = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const [r, g, b] = pixels.subarray(offset, offset + 3);
      if (r > 42 && (g > b || r > b)) terrain += 1;
      if (r < 3 && g < 3 && b < 3) black += 1;
    }
    return {ok: terrain > 10, black, reason: `绘制的地貌样点 ${terrain}`};
  });
}

// 与 MusicPlayer 完全同源的期望曲单：走 musicGraph 解析（含默认昼/夜补偿），
// 数据更新后测试期望与实际播放自然一致，不再读旧 playlists 字段。
function expectedZoneTracks(manifest, stateName, mode) {
  const graph = manifest.musicGraph;
  if (!graph) return manifest.music?.[stateName]?.playlists?.[mode]?.sources ?? [];
  const wwiseId = manifest.music[stateName]?.wwiseId;
  let selection = resolveMusic(graph, wwiseId, mode, {});
  const dayNight = selection.conditions.find((group) => group.title === '昼夜');
  if (selection.tracks.length === 0 && dayNight && !dayNight.value) {
    const daytime = dayNight.entries.find((entry) => entry.label === '白天');
    if (daytime) selection = resolveMusic(graph, wwiseId, mode, {[dayNight.id]: daytime.key});
  }
  return selection.tracks.map((track) => track.id);
}

async function openFloorGroup(page, name) {
  await page.click('button[aria-label="切换分层地图"]');
  const searchSelector = '#layer-group-panel[data-panel-open] input[aria-label="搜索分层区域"]';
  await page.waitForFunction((selector) => document.querySelector(selector)
    || document.querySelector('.layer-piece'), {}, searchSelector);
  if (await page.evaluate((name) => document.querySelector('button[aria-label="分层区域"]')
    ?.title.includes(name), name)) return;
  if (!await page.$(searchSelector)) await page.click('button[aria-label="分层区域"]');
  await page.type(searchSelector, name);
  // 键盘流验证：回车必须选中可见的匹配项，而不是置顶的旧已选组。
  await page.waitForFunction((name) => document.querySelector('#layer-group-panel[data-panel-open] [role="option"]')
    ?.textContent.includes(name), {}, name);
  await page.keyboard.press('Enter');
  await page.waitForFunction((name) => document.querySelector('button[aria-label="分层区域"]')
    ?.title.includes(name), {}, name);
}

async function panelClosed(page, selector) {
  try {
    await page.waitForSelector(selector, {hidden: true, timeout: 2500});
    return true;
  } catch {
    return false;
  }
}

async function openMeropide(page) {
  await openFloorGroup(page, '梅洛彼得堡');
  await page.waitForFunction(() => document.querySelector('path[data-zone-key^="layer-3:3360102-"]'));
  await page.evaluate(() => Promise.all([...document.querySelectorAll('.layer-piece')].map((image) => image.decode())));
}

function inspectFloor(page, desiredKeys) {
  return page.evaluate(async (entries) => {
    const desired = new Map(entries);
    const images = [...document.querySelectorAll('.layer-piece')];
    await Promise.all(images.map((image) => image.decode()));
    // Let the compositor present the decoded artwork and the SVG hit layer before sampling.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const art = images.map((img) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      return {
        rect: img.getBoundingClientRect(),
        width: canvas.width,
        height: canvas.height,
        rgba: context.getImageData(0, 0, canvas.width, canvas.height).data,
        id: Number(img.src.match(/_(\d+)\.webp$/)[1]),
      };
    });
    const inside = (x, y, rect) => rect.left <= x && x < rect.right && rect.top <= y && y < rect.bottom;
    let target = null;
    let blank = 0;
    let leaks = 0;
    for (let y = Math.ceil(Math.min(...art.map(({rect}) => rect.top))) + 0.5;
      y < Math.max(...art.map(({rect}) => rect.bottom)); y += 2) {
      for (let x = Math.ceil(Math.min(...art.map(({rect}) => rect.left))) + 0.5;
        x < Math.max(...art.map(({rect}) => rect.right)); x += 2) {
        const covered = art.filter(({rect}) => inside(x, y, rect));
        if (!covered.length) continue;
        const onArt = (offsetX, offsetY) => art.some(({rect, width, height, rgba}) => {
          const px = x + offsetX;
          const py = y + offsetY;
          if (!inside(px, py, rect)) return false;
          const column = Math.floor((px - rect.left) / rect.width * width);
          const row = Math.floor((py - rect.top) / rect.height * height);
          return rgba[(row * width + column) * 4 + 3] >= 128;
        });
        const hit = document.elementFromPoint(x, y)?.closest('path[data-zone-key]');
        // CSS raster positioning and vector hit-testing quantize subpixels independently.
        // Sample outside the one-device-pixel antialiasing fringe.
        const fringe = 1 / devicePixelRatio;
        const touchesArt = [0, -fringe, fringe].some((dx) =>
          [0, -fringe, fringe].some((dy) => onArt(dx, dy)));
        if (!touchesArt) {
          blank += 1;
          if (hit) leaks += 1;
        } else if (!target && onArt(0, 0) && desired.has(hit?.dataset.zoneKey)) {
          // 采样点必须离分区边界至少 2 CSS px：中心与四向邻居命中同一分区，
          // 悬停与点击期望才不会把透明交界/亚像素边缘当成用户选区。
          const key = hit.dataset.zoneKey;
          const hitAt = (px, py) => document.elementFromPoint(px, py)
            ?.closest('path[data-zone-key]')?.dataset.zoneKey ?? null;
          const stable = [[0, -2], [0, 2], [-2, 0], [2, 0]]
            .every(([dx, dy]) => hitAt(x + dx, y + dy) === key);
          if (stable) target = {x, y, state: desired.get(key)};
        }
      }
    }
    return {
      ids: art.map(({id}) => id).sort(),
      native: art.every(({rect, width, height}) => rect.width * devicePixelRatio <= width + 0.06
        && rect.height * devicePixelRatio <= height + 0.06),
      blank,
      leaks,
      target,
    };
  }, [...desiredKeys.entries()]);
}

async function waitForAudio(page, source) {
  try {
    await page.waitForFunction((id) => {
      const audio = document.querySelector('.music-player audio');
      return !audio?.paused && audio?.currentTime > 0 && audio.currentSrc.endsWith(`/${id}.opus`);
    }, {timeout: 8000}, source);
  } catch (error) {
    // 超时转储现场：区分未激活、被拦截、曲目不符、音源缺失。
    const state = await page.evaluate(() => {
      const audio = document.querySelector('.music-player audio');
      return {
        player: Boolean(document.querySelector('.music-player')),
        paused: audio?.paused ?? null,
        time: audio?.currentTime ?? null,
        src: audio?.currentSrc ?? audio?.getAttribute('src') ?? null,
        errorCode: audio?.error?.code ?? null,
        track: document.querySelector('.track-name')?.textContent ?? null,
        zone: document.querySelector('.zone-name')?.textContent ?? null,
      };
    });
    throw new Error(`等待音频失败（期望 ${source}）：${JSON.stringify(state)}`);
  }
}

function playerDetailsVisible(page) {
  return page.evaluate(() => Boolean(document.querySelector('.player-drawer')?.getClientRects().length));
}

// 播放器在地图内联展开。展开区在 DOM 中常驻，按实际可见性判断。
async function openPlayerDetails(page, {songs = false} = {}) {
  await page.waitForSelector('.glass-player-enter-active', {hidden: true});
  if (!await playerDetailsVisible(page)) await page.click('button.details-toggle');
  await page.waitForSelector('.player-drawer', {visible: true});
  await page.waitForSelector('.details-reveal.reveal-enter-active', {hidden: true});
  if (songs) {
    await page.waitForSelector('.player-drawer .track-list:not([inert])', {visible: true});
  }
}

async function collapsePlayerDetails(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.player-drawer', {hidden: true});
  return page.evaluate(() => {
    const button = document.querySelector('button.details-toggle');
    return button?.getAttribute('aria-expanded') === 'false' && button === document.activeElement
      && button.title === '歌曲列表' && Boolean(button.querySelector('svg'));
  });
}

const volumeTrigger = 'button[aria-label="音量设置"]';
const volumeRange = '.volume-panel input[aria-label="音量"]';

async function openPlayerVolume(page) {
  await page.click(volumeTrigger);
  await page.waitForSelector(volumeRange, {visible: true});
  await page.waitForSelector('.volume-panel.volume-float-enter-active', {hidden: true});
  await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector),
    {timeout: 5000}, volumeRange);
  return page.evaluate(() => {
    const player = document.querySelector('.music-player');
    const panel = player.querySelector('.volume-panel').getBoundingClientRect();
    const ranges = [...player.querySelectorAll('input[type="range"][aria-label="音量"]')]
      .filter((element) => !element.disabled && element.getClientRects().length);
    const unobstructed = ['[aria-label="关闭播放器"]', 'input[aria-label="播放进度"]']
      .every((selector) => {
        const control = player.querySelector(selector);
        const bounds = control?.getBoundingClientRect();
        if (!bounds?.width || !bounds.height) return false;
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const overlaps = panel.left < bounds.right && panel.right > bounds.left
          && panel.top < bounds.bottom && panel.bottom > bounds.top;
        return !overlaps && control.contains(hit);
      });
    return ranges.length === 1 && ranges[0] === document.activeElement && unobstructed
      && panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight;
  });
}

async function closePlayerVolume(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.volume-panel', {hidden: true});
  return page.$eval(volumeTrigger, (button) =>
    button.getAttribute('aria-expanded') === 'false' && button === document.activeElement);
}

async function chooseTab(page, label, value) {
  await openPlayerDetails(page);
  const selector = `button.modes-toggle[aria-label=${JSON.stringify(label)}]`;
  await page.waitForSelector(selector, {visible: true});
  const count = await page.$eval(selector, (button) => button.querySelectorAll('.mode-option').length);
  const desired = String(value);
  let current = await page.$eval(selector, (button) => button.dataset.value);
  for (let attempt = 0; attempt < count && current !== desired; attempt += 1) {
    await page.click(selector);
    await page.waitForFunction((target, previous) =>
      document.querySelector(target)?.dataset.value !== previous, {}, selector, current);
    current = await page.$eval(selector, (button) => button.dataset.value);
  }
  if (current !== desired) throw new Error(`无法切换到${label}的 ${desired} 项`);
}

async function playFirstListed(page) {
  await openPlayerDetails(page, {songs: true});
  const selector = '.player-drawer .track-list:not([inert]) button';
  await page.waitForFunction((target) => {
    const button = document.querySelector(target);
    const rect = button?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return false;
    return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  }, {}, selector);
  await page.click(selector);
}

async function openMondstadt(page) {
  const key = await page.evaluate(async () => {
    const data = await (await fetch('/data/genshin-region-bgm.json')).json();
    return data.zones.find((zone) => zone.state === 'State_MengDe')?.id;
  });
  const selector = `path[data-zone-key=${JSON.stringify(key)}]`;
  await page.$eval(selector, (element) => element.focus());
  await page.keyboard.press('Enter');
  await page.waitForSelector('.music-player', {visible: true, timeout: 5000});
  await chooseTab(page, '音乐模式', 'exploration');
}

async function main() {
  fs.mkdirSync(shotDir, {recursive: true});
  if (!fs.existsSync(chromePath)) throw new Error(`未找到 Chrome：${chromePath}`);

  previewProcess = spawn(
    process.platform === 'win32' ? 'node.exe' : 'node',
    [path.join(projectDir, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'],
    {cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']},
  );
  console.log(`preview PID ${previewProcess.pid}（http://127.0.0.1:${port}）`);
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > 30000) throw new Error('preview 启动超时');
    if (previewProcess.exitCode !== null) throw new Error(`preview 提前退出：${previewProcess.exitCode}`);
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/`, {method: 'HEAD'});
      if (probe.ok) break;
    } catch {
      // 端口尚未就绪，继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir: chromeProfile,
    args: ['--no-first-run', '--disable-background-timer-throttling', '--mute-audio',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.createBrowserContext();
  const home = `http://127.0.0.1:${port}/`;
  const globe = await context.newPage();
  try {
    await globe.setViewport({width: 1440, height: 900});
    await globe.emulateMediaFeatures([{name: 'prefers-reduced-motion', value: 'reduce'}]);
    await globe.goto(home, {waitUntil: 'domcontentloaded'});
    await globe.waitForSelector('.globe-labels .place');
    check(await globe.$('.map-surface') === null && await globe.$('.zoom-controls button[aria-label="球面地图"]') === null,
      '首页直接显示球面，工具栏无平面切换按钮');
    const regionNames = ['蒙德', '璃月', '稻妻', '须弥', '枫丹', '纳塔', '至冬', '挪德卡莱'].sort();
    const visibleRegions = await globe.$$eval('.globe-labels .place', (labels) => labels.map((label) => label.textContent).sort());
    check(JSON.stringify(visibleRegions) === JSON.stringify(regionNames), '球面首页只标注七国和挪德卡莱');
    const inazumaSea = await globe.evaluate(async () => {
      const response = await fetch('./tiles/meta.json');
      const {maps: {Teyvat: {native}}} = await response.json();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      // This sea patch crosses native rows 62–63, beyond 4 GiB in the source raster.
      for (const key of ['80/62', '81/62', '82/62', '83/62', '80/63', '81/63', '82/63', '83/63']) {
        const tile = await fetch(`./tiles/Teyvat/${native.level}/${key}.webp`);
        if (!tile.ok) return false;
        const image = await createImageBitmap(await tile.blob());
        context.drawImage(image, image.width / 2, image.height * .75, 1, 1, 0, 0, 1, 1);
        image.close();
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        if (a !== 255 || g < 36 || b < 36 || g <= r) return false;
      }
      return true;
    });
    check(inazumaSea, '稻妻南边 8 张原像素瓦片的海面可解码且没有黑块');
    await globe.screenshot({path: path.join(shotDir, '00-default-globe.png')});
    const moonLink = 'button[aria-label="进入霜月"]:not([hidden])';
    const resetMoon = 'button[aria-label="复位到霜月全览"]';
    const returnToWorld = 'button[aria-label="返回全局预览"]';
    const currentMapName = () => globe.$eval('.map-switcher .select-value', (label) => label.textContent.trim());
    await globe.waitForSelector(moonLink, {visible: true});
    await globe.click(moonLink);
    await globe.waitForSelector(returnToWorld);
    await globe.waitForSelector(moonLink, {hidden: true});
    await globe.click('button[aria-label="放大"]');
    await globe.waitForSelector(resetMoon);
    await globe.click(resetMoon);
    await globe.waitForSelector(returnToWorld);
    check(await currentMapName() === '霜月', '霜月放大后复位回到霜月全览');
    await globe.click(returnToWorld);
    await globe.waitForSelector('.globe-labels .place');
    check(await currentMapName() === '提瓦特' && await globe.$('.lunar-transition:not([hidden])') === null,
      '霜月全览复位返回提瓦特，减少动态效果时直接切换');
    const search = 'input[aria-label="跳转到地点"]';
    await globe.click(search);
    await globe.type(search, '枫丹廷');
    await globe.waitForSelector('.globe-results button');
    check(await globe.$$eval('.globe-results button', (buttons) =>
      buttons.filter((button) => button.querySelector('span')?.textContent === '枫丹廷区').length === 1),
    '球面搜索合并同名同音乐状态的重复结果');
    await globe.keyboard.press('ArrowDown');
    check(await globe.$eval(search, (node) =>
      document.getElementById(node.getAttribute('aria-activedescendant'))?.textContent === '枫丹廷区'),
    '搜索方向键可选择下一条结果');
    await globe.click('.map-switcher .select-trigger');
    await globe.waitForSelector('.select-popup', {visible: true});
    check(await globe.$('.globe-results') === null, '地图菜单打开时搜索结果关闭');
    await globe.keyboard.press('Escape');
    await globe.click(search);
    await globe.keyboard.down('Control');
    await globe.keyboard.press('KeyA');
    await globe.keyboard.up('Control');
    await globe.type(search, '新基捷城');
    await globe.waitForSelector('.globe-results button');
    await globe.keyboard.press('Enter');
    const activeLabel = await globe.waitForSelector('.globe-labels .active-zone-label', {visible: true});
    check(await activeLabel.evaluate((label) => label.textContent) === '新基捷城'
      && await globe.$('.music-player') === null, '搜索只定位和标注音乐分区');
    await globe.waitForSelector('.relief-dock canvas[aria-label="新基捷城地形高程点阵"]', {visible: true});
    await globe.focus('.globe-canvas');
    await globe.keyboard.press('Enter');
    await globe.waitForSelector('.music-player', {visible: true});
    check(await globe.$('.music-player') !== null, '从原有地图入口选中分区才打开播放器');
    const dragSample = await globe.evaluateHandle(() => {
      const label = document.querySelector('.active-zone-label');
      const initialTransform = label.style.transform;
      const drawing = CanvasRenderingContext2D.prototype;
      const original = drawing.drawImage;
      const sample = {frames: 0, retained: true, lifted: true, moved: false};
      drawing.drawImage = function (source, ...coords) {
        if (source?.matches?.('.globe-canvas') && coords.length === 8 && source.width < source.clientWidth) {
          sample.frames += 1;
          sample.retained &&= document.querySelector('.active-zone-label') === label;
          sample.lifted &&= coords[1] * source.clientHeight / source.height - coords[5] > 0;
        }
        return original.call(this, source, ...coords);
      };
      return {
        finish() {
          drawing.drawImage = original;
          sample.moved = label.style.transform !== initialTransform;
          return sample;
        },
      };
    });
    await globe.mouse.move(594, 429);
    await globe.mouse.down();
    await globe.mouse.move(666, 429, {steps: 10});
    await globe.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const dragged = await dragSample.evaluate((probe) => probe.finish());
    await globe.mouse.up();
    await dragSample.dispose();
    check(dragged.frames > 0 && dragged.retained && dragged.lifted && dragged.moved,
      '球面拖动时浮层继续绘制，文字保留同一节点并随地图移动');
    await globe.click('button[aria-label="关闭播放器"]');
    await globe.waitForSelector('.globe-labels .active-zone-label', {hidden: true});
    await globe.waitForSelector('button[aria-label="切换分层地图"]', {visible: true});
    const layerButton = 'button[aria-label="切换分层地图"]';
    check(await globe.evaluate(() => {
      const map = document.querySelector('.map-switcher').getBoundingClientRect();
      const layers = document.querySelector('.layer-picker .bar').getBoundingClientRect();
      const search = document.querySelector('.globe-search-field').getBoundingClientRect();
      return map.top === layers.top && map.right < layers.left && search.top > layers.bottom
        && search.left === map.left && search.right === layers.right;
    }), '地图下拉与分层同处左上一行，搜索框和整行等宽');
    await globe.click(layerButton);
    await globe.waitForSelector('#layer-group-panel', {visible: true});
    await globe.click(layerButton);
    await globe.waitForSelector('#layer-group-panel', {hidden: true});
    check(await globe.$eval(layerButton, (button) =>
      button.getAttribute('aria-expanded') === 'false' && document.activeElement === button),
    '分层入口再次点击收起目录并保持焦点');
    await globe.click(layerButton);
    await globe.waitForSelector('#layer-group-list [role="option"]', {visible: true});
    await globe.click('#layer-group-list [role="option"]');
    await globe.waitForSelector('.layer-piece');
    await globe.click(layerButton);
    await globe.waitForSelector('.globe-labels .place');
    check(await globe.$('.layer-piece') === null, '退出分层回到球面');
  } finally {
    await globe.close();
  }

  const page = await context.newPage();
  await page.setViewport({width: 1440, height: 900, deviceScaleFactor: 1, hasTouch: true});
  // 后续地表瓦片和 SVG 命中用例覆盖 WebGL 2 不可用时的降级入口。
  await page.evaluateOnNewDocument(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
      if (kind === 'webgl2' && this.classList.contains('globe-canvas')) return null;
      return getContext.call(this, kind, ...options);
    };
  });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  const tileResponses = [];
  const resourceErrors = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/tiles/') && new URL(url).pathname.endsWith('.webp')) {
      tileResponses.push({status: response.status(), type: response.headers()['content-type'] ?? ''});
    }
    if (response.status() >= 400) resourceErrors.push({url, status: response.status()});
  });

  await page.goto(home, {waitUntil: 'domcontentloaded'});
  const bgmManifest = await (await fetch(`http://127.0.0.1:${port}/data/genshin-region-bgm.json`)).json();
  const audioUrl = `http://127.0.0.1:${port}/region-bgm-audio/128266555.opus`;
  const [fullAudio, range] = await Promise.all([
    fetch(audioUrl, {method: 'HEAD'}),
    fetch(audioUrl, {headers: {Range: 'bytes=0-15'}}),
  ]);
  const segment = Buffer.from(await range.arrayBuffer());
  check(fullAudio.ok && Number(fullAudio.headers.get('content-length')) > 16
    && range.status === 206 && range.headers.get('content-range')?.startsWith('bytes 0-15/')
    && segment.length === 16 && segment.subarray(0, 4).toString() === 'OggS',
  '纯静态产物的音频支持 HEAD 和字节范围');
  await page.waitForSelector('.map-surface', {timeout: 30000});
  await page.waitForSelector('path[data-zone-key]', {timeout: 30000});
  await page.evaluate(async () => {
    const response = await fetch('/data/map-data.json');
    const data = await response.json();
    document.documentElement.dataset.mapVersion = data.dataVersion;
    window.__pyramidSource = await (await fetch('/tiles/meta.json')).json();
  });
  await waitTilesDecoded(page);

  let state = await worldState(page);
  check(state.dataVersion === '7.2.0', `数据版本 7.2.0（实际 ${state.dataVersion}）`);
  check(state.tiles > 1 && state.tiles <= 16, `初始只加载 LOD 可见块（${state.tiles} 张，级别 ${state.level}）`);
  check(state.settledTiles === state.tiles && !state.failed, '可见瓦片已解码和绘制');
  const painted = await assertTilesPainted(page);
  check(painted.ok, `瓦片真实画布样点（${painted.reason}）`);
  check(painted.black < 12, `全图无黑色空瓦片（黑样点 ${painted.black}）`);
  check(tileResponses.length <= 24
    && tileResponses.every((item) => (item.status === 200 && item.type.includes('image/webp'))
      || item.status === 304),
    `首次仅请求在屏瓦片（${tileResponses.length} 个）`);
  const groundGeometry = await page.evaluate(() => {
    const hits = [...document.querySelectorAll('path[data-zone-key]')];
    return {
      count: hits.length,
      invalid: hits.filter((path) => !path.getAttribute('d') || /NaN|Infinity/.test(path.getAttribute('d'))).length,
      edgeLength: document.querySelector('.region-boundaries')?.getAttribute('d')?.length ?? 0,
    };
  });
  check(groundGeometry.count > 0 && groundGeometry.invalid === 0 && groundGeometry.edgeLength > 0,
    `全图地表的 ${groundGeometry.count} 个分区边线及命中坐标有效`);
  await page.screenshot({path: path.join(shotDir, '01-full-map.png')});

  // 地图切换（共享自绘下拉）：开合、选项、Escape 关闭并还焦点、点外关闭。
  await page.waitForSelector('.map-switcher .select-trigger', {visible: true});
  await page.click('.map-switcher .select-trigger');
  await page.waitForSelector('.select-popup', {visible: true});
  const mapChoices = await page.$$eval('.select-popup li[role="option"]', (lis) => lis.map((li) => ({
    text: li.innerText.trim(),
    selected: li.getAttribute('aria-selected') === 'true',
  })));
  check(mapChoices.length === 5, `地图下拉列出全部地图（${mapChoices.map((o) => o.text).join(',')}）`);
  check(mapChoices.filter((o) => o.selected).length === 1 && mapChoices[0].selected,
    '地图下拉恰有当前项（提瓦特）选中');
  await page.keyboard.press('Escape');
  check(await panelClosed(page, '.select-popup'), 'Escape 只关地图下拉');
  check(await page.$eval('.map-switcher .select-trigger', (b) => document.activeElement === b),
    '地图下拉关闭后焦点回到触发器');
  await page.click('.map-switcher .select-trigger');
  await page.waitForSelector('.select-popup', {visible: true});
  await page.mouse.click(20, 880); // 空白海面：点外部关闭下拉
  check(await panelClosed(page, '.select-popup'), '点击下拉外部关闭地图菜单');

  await page.click('button[aria-label="切换分层地图"]');
  const layerScroller = '.panel .group-scroll .scroll-viewport';
  await page.waitForSelector(layerScroller, {visible: true});
  await page.waitForSelector('#layer-group-panel[data-liquid-morph]', {hidden: true});
  const scrolling = await page.$eval(layerScroller, (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const track = getComputedStyle(node, '::-webkit-scrollbar-track');
    const arrows = getComputedStyle(node, '::-webkit-scrollbar-button');
    const hidden = matchMedia('(max-width: 700px), (pointer: coarse)').matches;
    return {
      top: node.scrollTop,
      range: node.scrollHeight - node.clientHeight,
      space: node.offsetWidth - node.clientWidth,
      hidden,
      correctScrollbar: hidden ? style.scrollbarWidth === 'none'
        : style.scrollbarGutter === 'stable' && arrows.display === 'none',
      frame: style.borderRightWidth + ' ' + track.borderLeftWidth,
      bottomGap: node.closest('.panel').getBoundingClientRect().bottom - rect.bottom,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  });
  check(scrolling.range > 0 && (scrolling.hidden ? scrolling.space === 0 : scrolling.space > 0)
    && scrolling.correctScrollbar && scrolling.frame === '0px 0px' && scrolling.bottomGap >= 10,
  `分层目录可滚动，${scrolling.hidden ? '触屏隐藏滚动条' : `桌面细滑块占 ${scrolling.space}px 且无箭头`}`);
  const fixedMap = await worldState(page);
  await page.mouse.move(scrolling.x, scrolling.y);
  await page.mouse.wheel({deltaY: 240});
  await page.waitForFunction((selector, top) => document.querySelector(selector)?.scrollTop > top,
    {timeout: 3000}, layerScroller, scrolling.top);
  const afterWheel = await worldState(page);
  check(afterWheel.tx === fixedMap.tx && afterWheel.ty === fixedMap.ty && afterWheel.scale === fixedMap.scale,
    '楼层列表滚动不会平移或缩放地图');
  await page.screenshot({path: path.join(shotDir, '14-floor-scrollbar.png')});
  await page.keyboard.press('Escape');
  check(await panelClosed(page, '#layer-group-panel'), '滚动后 Escape 关闭分层目录');

  // 只通过当前清单中的真实音乐分区检查悬停。
  const hoverPoint = await page.evaluate(() => {
    for (const zone of document.querySelectorAll('path[data-zone-key]')) {
      const rect = zone.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (document.elementFromPoint(x, y) === zone) return {x, y, key: zone.dataset.zoneKey};
    }
    return null;
  });
  check(await page.$('.app-header, .locator-toggle, path[data-region-id]') === null,
    '地图无多余页头或行政区域');
  if (hoverPoint) {
    await page.mouse.move(hoverPoint.x, hoverPoint.y, {steps: 4});
    await page.waitForSelector('.region-tooltip', {visible: true});
    state = await worldState(page);
    check(state.hoverRegion === hoverPoint.key && state.tooltipName !== null, '悬停真实音乐分区');
    await page.screenshot({path: path.join(shotDir, '02-hover-region.png')});
    // 鼠标左键点选同一分区：播放器真实打开，Escape 收起。
    await page.mouse.click(hoverPoint.x, hoverPoint.y);
    await page.waitForSelector('.music-player', {visible: true, timeout: 5000});
    state = await worldState(page);
    check(state.selectedRegion === hoverPoint.key, '鼠标左键点选打开分区播放器');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.music-player', {hidden: true});
    check(await panelClosed(page, '.music-player'), 'Escape 收起左键打开的播放器');
  } else {
    check(await page.$('.music-player') === null, '没有可点击分区时隐藏播放器');
  }

  // 键盘 + 一次（视口中心锚）：中心点世界坐标必须保持不变（锚点保真）。
  const centerWorldBefore = await page.evaluate(() => {
    const world = document.querySelector('.world');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    return {x: (720 - matrix.e) / matrix.a, y: (450 - matrix.f) / matrix.a};
  });
  await page.focus('.map-surface');
  await page.keyboard.press('+');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const centerWorldAfter = await page.evaluate(() => {
    const world = document.querySelector('.world');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    return {x: (720 - matrix.e) / matrix.a, y: (450 - matrix.f) / matrix.a};
  });
  check(Math.abs(centerWorldBefore.x - centerWorldAfter.x) < 0.5
    && Math.abs(centerWorldBefore.y - centerWorldAfter.y) < 0.5,
    `中心锚点缩放保真（Δ=${Math.abs(centerWorldBefore.x - centerWorldAfter.x).toFixed(3)},`
    + `${Math.abs(centerWorldBefore.y - centerWorldAfter.y).toFixed(3)} world px）`);

  // 指轮缩放（以指针为锚）；钳制可能移动锚下内容，属正常。
  const scaleBefore = state.scale;
  await page.mouse.move(720, 450);
  for (let i = 0; i < 8; i += 1) await page.mouse.wheel({deltaY: -240});
  await new Promise((resolve) => setTimeout(resolve, 400));
  await waitTilesDecoded(page, 60000);
  state = await worldState(page);
  check(state.scale > scaleBefore * 1.6, `指轮放大生效（${scaleBefore.toFixed(3)} → ${state.scale.toFixed(3)}）`);
  const centerProbe = await page.evaluate(() => {
    const hit = document.elementFromPoint(720, 450);
    return hit?.closest?.('path[data-zone-key]')?.dataset.zoneKey ?? null;
  });
  await page.mouse.move(720, 450, {steps: 4});
  await new Promise((resolve) => setTimeout(resolve, 200));
  state = await worldState(page);
  check(state.hoverRegion === centerProbe,
    `缩放后悬停命中一致（hover=${state.hoverRegion}，elementFromPoint=${centerProbe}）`);
  if (centerProbe !== null) {
    check(state.tooltipName !== null, `缩放后 tooltip 显示（${state.tooltipName}）`);
  }
  const paintedZoomed = await assertTilesPainted(page);
  check(paintedZoomed.ok, `放大后瓦片仍真实解码（${paintedZoomed.ok ? 'ok' : paintedZoomed.reason}）`);
  await page.screenshot({path: path.join(shotDir, '03-zoomed-hover.png')});

  // 拖动平移；拖动后高亮清除。
  const {tx, ty} = state;
  await page.mouse.move(700, 500);
  await page.mouse.down();
  await page.mouse.move(940, 650, {steps: 10});
  check(await page.$('.region-tooltip') === null, '拖动期间提示框隐藏');
  await page.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitTilesDecoded(page, 60000);
  state = await worldState(page);
  check(Math.abs(state.tx - tx) > 100 && Math.abs(state.ty - ty) > 80,
    `拖动平移生效（tx ${tx.toFixed(0)}→${state.tx.toFixed(0)}，ty ${ty.toFixed(0)}→${state.ty.toFixed(0)}）`);
  // 拖动释放捕获后，悬停按指针终点坐标刷新：指针落在区域上则高亮该区域，
  // 落在空白（海/无格）则必须清除——两种情况都要与命中检测一致。
  const afterDragHit = await page.evaluate(() => {
    const hit = document.elementFromPoint(940, 650);
    return hit?.closest?.('path[data-zone-key]')?.dataset.zoneKey ?? null;
  });
  check(state.hoverRegion === afterDragHit,
    `拖动后悬停与命中一致（hover=${state.hoverRegion}，elementFromPoint=${afterDragHit}）`);
  check(afterDragHit === null ? state.tooltipName === null : true, '拖动到空白后 tooltip 清除');
  await page.screenshot({path: path.join(shotDir, '04-panned.png')});

  // 在同一真实分区验证触屏点选，空清单仅验证地图复位。
  await page.click('button[aria-label="复位到全图"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await waitTilesDecoded(page, 60000);
  if (hoverPoint) {
    await page.touchscreen.tap(hoverPoint.x, hoverPoint.y);
    await page.waitForSelector('path[data-zone-key][aria-current="true"]', {timeout: 5000});
    state = await worldState(page);
    check(state.selectedRegion === hoverPoint.key, '触屏点选真实音乐分区');
    await page.screenshot({path: path.join(shotDir, '05-touch-tap.png')});
  }

  // 键盘：+ 放大（画布超出视口后方向键才有平移空间）、方向键平移、Escape 清除点选。
  await page.focus('.map-surface');
  const beforePlus = await worldState(page);
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('+');
  await page.waitForFunction((startScale) => {
    const world = document.querySelector('.world');
    return new DOMMatrixReadOnly(getComputedStyle(world).transform).a > startScale * 3;
  }, {timeout: 5000}, beforePlus.scale);
  const afterPlus = await worldState(page);
  check(afterPlus.scale > beforePlus.scale * 3, `键盘 + 放大生效（${beforePlus.scale.toFixed(3)} → ${afterPlus.scale.toFixed(3)}）`);
  const beforeKeys = await worldState(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(({tx, ty}) => {
    const world = document.querySelector('.world');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    return matrix.e < tx - 50 && matrix.f < ty - 50;
  }, {timeout: 5000}, beforeKeys);
  const afterKeys = await worldState(page);
  check(afterKeys.tx < beforeKeys.tx - 50 && afterKeys.ty < beforeKeys.ty - 50,
    `键盘方向键平移生效（tx ${beforeKeys.tx.toFixed(0)}→${afterKeys.tx.toFixed(0)}，ty ${beforeKeys.ty.toFixed(0)}→${afterKeys.ty.toFixed(0)}）`);
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterEscape = await worldState(page);
  check(afterEscape.selectedRegion === null, 'Escape 清除点选高亮');

  // 最终复位到全图。
  await page.click('button[aria-label="复位到全图"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await waitTilesDecoded(page, 60000);
  state = await worldState(page);
  check(state.scale < 0.35, `复位回到全图缩放（${state.scale.toFixed(3)}）`);
  await page.screenshot({path: path.join(shotDir, '06-reset.png')});

  const overlay = {x: state.tx + state.scale * 1969.7, y: state.ty + state.scale * 1664};
  await page.mouse.move(overlay.x, overlay.y);
  const frames = page.evaluate(() => new Promise((resolve) => {
    const intervals = [];
    let last = performance.now();
    function sample(now) {
      intervals.push(now - last);
      last = now;
      if (intervals.length < 45) requestAnimationFrame(sample);
      else resolve(intervals.slice(1).sort((a, b) => a - b));
    }
    requestAnimationFrame(sample);
  }));
  for (let step = 0; step < 12; step += 1) await page.mouse.wheel({deltaY: -120});
  await page.mouse.down();
  await page.mouse.move(overlay.x + 130, overlay.y + 60, {steps: 20});
  await page.mouse.up();
  await waitTilesDecoded(page);
  const intervals = await frames;
  check(intervals[Math.floor(intervals.length * 0.95)] <= 50,
    `缩放并拖动的帧间隔 p95 ${intervals[Math.floor(intervals.length * 0.95)].toFixed(1)}ms`);
  check((await worldState(page)).level > state.level, '放大时请求更高编辑器瓦片级别');
  await page.mouse.move(9, 9);
  await page.screenshot({path: path.join(shotDir, '11-nodkrai-overlay.png')});
  await page.click('button[aria-label="复位到全图"]');

  await openMondstadt(page);
  await chooseTab(page, '昼夜', '582789890');
  await playFirstListed(page);
  await waitForAudio(page, 994723831);
  await chooseTab(page, '昼夜', '3815942830');
  await playFirstListed(page);
  await waitForAudio(page, 168715686);
  check((await page.$eval('.track-name', (label) => label.textContent)).trim() === '蒙德的一日',
    '蒙德城区按昼夜分支切播，并显示游戏内中文曲名');
  const playerText = await page.$eval('.music-player', (node) => node.innerText);
  check(!playerText.includes('0x') && !playerText.includes('·'),
    '播放器可见文案无状态十六进制与中点拼接');
  // 蒙德当前条件的曲内前后曲与歌曲列表抽屉。期望曲单走同一解析路径，
  // 与播放器消费的 resolveMusic 完全同源。
  const mondstadtResolve = (overrides = {}) => resolveMusic(bgmManifest.musicGraph,
    bgmManifest.music.State_MengDe?.wwiseId, 'exploration', overrides);
  const mondstadtDay = (() => {
    const group = mondstadtResolve().conditions.find((candidate) => candidate.title === '昼夜');
    const key = group?.entries.find((entry) => entry.label === '白天')?.key;
    return key ? mondstadtResolve({[group.id]: key}) : mondstadtResolve();
  })();
  if (mondstadtDay.tracks.length > 1) {
    const count = await page.$eval('.music-player .count', (node) => ({
      tag: node.tagName, text: node.textContent.trim(),
    }));
    check(count.tag === 'SPAN' && count.text === `1 / ${mondstadtDay.tracks.length}`,
      `曲数计数是非交互文本（${count.tag} “${count.text}”）`);
    await page.click('button[aria-label="下一首"]');
    await waitForAudio(page, mondstadtDay.tracks[1].id);
    await page.click('button[aria-label="上一首"]');
    await waitForAudio(page, mondstadtDay.tracks[0].id);
    check(true, '蒙德前后曲按钮只在当前条件曲单内切换');
    await openPlayerDetails(page, {songs: true});
    check(await page.$eval('.player-drawer', (drawer) => {
      const map = document.elementFromPoint(innerWidth * .65, innerHeight * .4);
      return Boolean(drawer.closest('.music-player') && map?.closest('.map-surface'));
    }), '歌曲列表在播放器内展开，地图仍可操作');
    await page.screenshot({path: path.join(shotDir, '12-music-conditions.png')});
    check(await collapsePlayerDetails(page), 'Escape 只收歌曲列表并恢复入口焦点');
  } else {
    const count = await page.$$eval('.player-drawer .track-list button', (items) => items.length);
    check(count === 1, '单曲曲单提供可点击的歌曲行');
  }

  // 播放条件抽屉只收已核实的开关（组名与全部选项 label 均经证实）。按实际
  // 清单定位有此类开关的分区走完整下拉回归；当前清单没有时，该按钮按数据
  // 不出现。
  const graph = bgmManifest.musicGraph;
  const zoneSelection = (zone, mode = 'exploration', overrides = {}) =>
    resolveMusic(graph, bgmManifest.music[zone.state].wwiseId, mode, overrides);
  const namedConditionZone = bgmManifest.zones.find((zone) => {
    if (bgmManifest.music?.[zone.state]?.wwiseId == null) return false;
    return zoneSelection(zone).conditions.some((group) => group.named && group.title !== '昼夜'
      && group.entries.every((entry) => entry.label));
  });
  const openZoneByState = async (state) => {
    const key = await page.evaluate(async (stateName) => {
      const data = await (await fetch('/data/genshin-region-bgm.json')).json();
      return data.zones.find((zone) => zone.state === stateName)?.id;
    }, state);
    await page.$eval(`path[data-zone-key=${JSON.stringify(key)}]`, (element) => element.focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.music-player', {visible: true, timeout: 5000});
  };
  if (namedConditionZone) {
    await openZoneByState(namedConditionZone.state);
    await openPlayerDetails(page);
    await page.waitForSelector('.condition-row', {visible: true});
    const drawerText = await page.$eval('.player-drawer', (node) => node.innerText);
    check(!drawerText.includes('0x') && !drawerText.includes('Wwise') && !drawerText.includes('未命名'),
      '条件抽屉组名只用已核实名称，无内部标识或未命名条件');
    const closedTriggerText = await page.$eval('.condition-row .select-trigger .select-value',
      (node) => node.textContent.trim());
    check(closedTriggerText.length > 0, `条件触发器闭合态有可读文案（${closedTriggerText}）`);
    await page.screenshot({path: path.join(shotDir, '14-conditions-drawer.png')});
    await page.click('.condition-row .select-trigger');
    await page.waitForSelector('.select-popup', {visible: true});
    const popupInfo = await page.evaluate(() => {
      const popup = document.querySelector('.select-popup');
      const options = [...popup.querySelectorAll('li[role="option"]')];
      const rect = popup.getBoundingClientRect();
      const trigger = document.querySelector('.condition-row .select-trigger')
        .getBoundingClientRect();
      const transport = document.querySelector('.music-player .transport').getBoundingClientRect();
      return {
        inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        aboveTrigger: rect.bottom <= trigger.top + 1,
        overlapsTransport: rect.left < transport.right && rect.right > transport.left
          && rect.top < transport.bottom && rect.bottom > transport.top,
        count: options.length,
        chosen: options.filter((li) => li.getAttribute('aria-selected') === 'true').length,
        metaOk: options.every((li) => {
          const text = li.innerText.trim();
          return /\d+ 首$/.test(text) || text === '无曲目';
        }),
        hasHex: options.some((li) => li.innerText.includes('0x')),
        first: options[0]?.innerText.replace(/\n/g, ' '),
      };
    });
    check(popupInfo.count >= 2, `条件下拉列出真实分支（${popupInfo.count} 项）`);
    check(popupInfo.hasHex === false, '下拉选项不以状态十六进制作主要文案');
    check(popupInfo.metaOk, '下拉选项曲数以“N 首”独立展示，无曲目分支写明无曲目');
    check(popupInfo.chosen === 1, '下拉恰有一项当前选中');
    check(popupInfo.inViewport, '下拉弹层完整落在视口内');
    check(popupInfo.aboveTrigger, '条件下拉优先向上展开（不遮触发行）');
    check(popupInfo.overlapsTransport === false, '条件下拉不遮盖播放控制，播放状态与选项同屏');
    await page.screenshot({path: path.join(shotDir, '15-conditions-select-open.png')});
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const activeOption = await page.evaluate(() => {
      const id = document.querySelector('.condition-row .select-trigger')
        ?.getAttribute('aria-activedescendant');
      return {id, text: id ? document.getElementById(id)?.innerText.split('\n')[0] : null};
    });
    check(Boolean(activeOption.id), '方向键移动下拉活动选项');
    // 条件切换的面板连续性：切到某分支后昼夜两向曲单可能相同，昼/夜行按
    // 「不展示重复选项」真实消失，面板高度允许一次到位变化；断言逐帧采样中
    // 节点与音频不重建、高度不往复闪动（至多一个中间值）。
    await page.evaluate(() => {
      window.__condStop = false;
      const panel = document.querySelector('.music-player');
      const audio = panel.querySelector('audio');
      window.__condSample = new Promise((resolve) => {
        const heights = [];
        const tick = () => {
          const current = document.querySelector('.music-player');
          const intact = current === panel && current.querySelector('audio') === audio;
          heights.push(intact ? Math.round(current.getBoundingClientRect().height) : -1);
          if (!window.__condStop) requestAnimationFrame(tick);
          else resolve(heights);
        };
        requestAnimationFrame(tick);
        setTimeout(() => { window.__condStop = true; }, 800);
      });
    });
    await page.keyboard.press('Enter');
    const triggerAfter = await page.$eval('.condition-row .select-trigger .select-value',
      (node) => node.textContent.trim());
    check(triggerAfter === activeOption.text, `Enter 键盘选择生效（触发器显示 ${triggerAfter}）`);
    const panelHeights = await page.evaluate(() => window.__condSample);
    const distinctHeights = [...new Set(panelHeights)];
    check(!panelHeights.includes(-1) && distinctHeights.length <= 2,
      `条件切换播放面板连续（高度序列 ${distinctHeights.join('→')}，节点与音频不重建）`);
    check(await panelClosed(page, '.select-popup') && await playerDetailsVisible(page),
      '选择后下拉关闭，条件抽屉保留');
    check(await collapsePlayerDetails(page), 'Escape 只收试听选项并恢复入口焦点');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.music-player', {hidden: true});
    check(await panelClosed(page, '.music-player'), '再次 Escape 关闭播放器');
  } else {
    check(true, '当前清单没有已核实的非昼夜条件开关，播放条件按钮按数据出现');
  }

  // 歌曲列表：枫丹廷白天众水之诗、夜间月夕花朝，各自打开列表核对当前条件
  // 的真实曲目。期望值全部从清单解析推导，不写死曲目；备选曲单（轻雨何故落）
  // 已随 alternatives 一并移除，列表不得再出现。
  const cityZone = bgmManifest.zones.find((zone) => zone.state === 'State_FD40_City'
    && bgmManifest.music?.[zone.state]?.wwiseId != null);
  check(cityZone !== undefined, '清单中存在枫丹廷分区');
  if (cityZone) {
    await openZoneByState(cityZone.state);
    await openPlayerDetails(page);
    await page.waitForSelector('[aria-label="昼夜"]', {visible: true});
    const cityResolve = (mode = 'exploration', overrides = {}) => resolveMusic(
      bgmManifest.musicGraph, bgmManifest.music[cityZone.state].wwiseId, mode, overrides);
    const dayNightGroup = cityResolve().conditions.find((group) => group.title === '昼夜');
    const dayEntry = dayNightGroup.entries.find((entry) => entry.label === '白天');
    const nightEntry = dayNightGroup.entries.find((entry) => entry.label === '夜间');
    const cityTracks = (key) => cityResolve('exploration', {[dayNightGroup.id]: key}).tracks;
    // 核对内联曲目列表，展开区保留供后续试听。
    const auditSongDrawer = async (key, label) => {
      const expected = cityTracks(key);
      await openPlayerDetails(page, {songs: true});
      const drawer = await page.evaluate(() => ({
        text: document.querySelector('.player-drawer').innerText,
        names: [...document.querySelectorAll('.player-drawer .track-list:not([inert]) .queue-name')]
          .map((span) => span.textContent.trim()),
        player: document.querySelector('.music-player').innerText,
        disclosure: document.querySelector('button.details-toggle').title,
      }));
      check(drawer.names.length === expected.length && expected.length === 4,
        `${label}歌曲列表只列当前条件 4 首真实曲目（${drawer.names.length} 行）`);
      check(drawer.names.join('|') === expected.map((track) => track.name).join('|'),
        `${label}列表曲目与解析期望一致（${drawer.names[0]} 等）`);
      check(!drawer.text.includes('轻雨何故落') && !drawer.text.includes('未命名')
        && !drawer.text.includes('0x'),
      `${label}列表无备选曲目、未命名条件或内部标识`);
      check(!drawer.player.includes('其他曲单') && !drawer.player.includes('返回主曲单'),
        '播放器无其他曲单或返回主曲单入口');
      check(drawer.disclosure === '收起歌曲列表', '展开时列表图标的提示明确显示收起动作');
      const scrollBox = await page.$eval('.player-drawer .scroll-viewport', (node) => {
        const style = getComputedStyle(node);
        const hidden = matchMedia('(max-width: 700px), (pointer: coarse)').matches;
        const arrowStyle = getComputedStyle(node, '::-webkit-scrollbar-button');
        return {
          correct: hidden ? style.scrollbarWidth === 'none'
            : style.scrollbarGutter === 'stable' && arrowStyle.display === 'none',
          borderX: style.borderLeftWidth,
          rail: Boolean(document.querySelector('.scroll-rail'))};
      });
      check(scrollBox.correct && scrollBox.borderX === '0px' && !scrollBox.rail,
        '歌曲列表沿用共享的原生滚动样式');
    };

    // 白天：众水之诗起播，计数为非交互文本。
    await chooseTab(page, '昼夜', dayEntry.key);
    await playFirstListed(page);
    await waitForAudio(page, cityTracks(dayEntry.key)[0].id);
    check((await page.$eval('.track-name', (node) => node.textContent.trim()))
      === cityTracks(dayEntry.key)[0].name,
    `枫丹廷白天起播当前条件首曲（${cityTracks(dayEntry.key)[0].name}）`);
    check((await page.$eval('.music-player .count', (node) => node.textContent.trim()))
      === `1 / ${cityTracks(dayEntry.key).length}`,
    '白天曲数计数按当前条件显示');
    await auditSongDrawer(dayEntry.key, '白天');
    await page.screenshot({path: path.join(shotDir, '14-song-list-drawer.png')});
    check(await collapsePlayerDetails(page), 'Escape 收起歌曲列表并恢复入口焦点');

    // 浏览夜间曲单时，白天歌曲继续播放，点曲目才提交夜间曲单。
    await openPlayerDetails(page);
    await page.waitForSelector('[aria-label="昼夜"]', {visible: true});
    const playingDay = await page.$eval('.music-player audio', (node) => ({
      src: node.src, time: node.currentTime,
    }));
    await page.click('button[aria-label="昼夜"] .mode-option--selected');
    await auditSongDrawer(nightEntry.key, '夜间');
    check(await page.$eval('.music-player audio', (node, original) =>
      node.src === original.src && node.currentTime >= original.time, playingDay),
    '点已选的白天一侧可浏览夜间曲单，当前音源和进度保持连续');
    check(await page.$eval('.music-player .count', (node) => node.textContent.trim())
      === `1 / ${cityTracks(dayEntry.key).length}`, '浏览夜间曲单时播放区仍显示白天曲单');
    await playFirstListed(page);
    await waitForAudio(page, cityTracks(nightEntry.key)[0].id);
    const secondSong = '.player-drawer .track-list:not([inert]) > li:nth-child(2) > button';
    await page.click(secondSong);
    await waitForAudio(page, cityTracks(nightEntry.key)[1].id);
    check(await page.$eval(secondSong, (button) => button.getAttribute('aria-current') === 'true'),
    '点选列表曲目直接试听并标记当前项');
    await auditSongDrawer(nightEntry.key, '切歌后');

    // 切回白天，点曲目提交队列，播放器与 audio 元素身份保持。
    await page.evaluate(() => {
      window.__panelEl = document.querySelector('.music-player');
      window.__audioEl = document.querySelector('.music-player audio');
    });
    await chooseTab(page, '昼夜', dayEntry.key);
    await playFirstListed(page);
    await waitForAudio(page, cityTracks(dayEntry.key)[0].id);
    check(await page.evaluate(() => document.querySelector('.music-player') === window.__panelEl
      && document.querySelector('.music-player audio') === window.__audioEl),
    '昼夜切换播放器与 audio 元素不重挂');
    check((await page.$eval('.music-player .count', (node) => node.textContent.trim()))
      === `1 / ${cityTracks(dayEntry.key).length}`,
    '切回白天计数回到白天曲目数');

    check(await page.$eval('.music-player', (player) =>
      !player.querySelector('[aria-label*="试听时间"]') && !player.innerText.includes('试听时间')),
    '昼夜音区的播放器及歌曲列表无试听时间入口');

    // 战斗回探索：身份保持，尊重前次昼夜选择。
    const modeToggle = 'button.modes-toggle[aria-label="音乐模式"]';
    const edge = await page.$eval(modeToggle, (button) => {
      const bounds = button.getBoundingClientRect();
      return {x: bounds.left + 1, y: bounds.top + bounds.height / 2};
    });
    await page.mouse.click(edge.x, edge.y);
    await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.value === 'combat',
      {}, modeToggle);
    check(true, '点音乐模式 Tab 的边缘也能切换');
    const combatTracks = cityResolve('combat');
    if (combatTracks.tracks.length) {
      await playFirstListed(page);
      await waitForAudio(page, combatTracks.tracks[0].id);
    }
    await chooseTab(page, '音乐模式', 'exploration');
    await playFirstListed(page);
    await waitForAudio(page, cityTracks(dayEntry.key)[0].id);
    check(await page.evaluate(() => document.querySelector('.music-player') === window.__panelEl
      && document.querySelector('.music-player audio') === window.__audioEl),
    '战斗回探索播放器与 audio 元素不重挂');
    check(await page.$eval('button[aria-label="昼夜"]',
      (button, key) => button.dataset.value === String(key), dayEntry.key),
    '战斗回探索尊重前次昼夜选择');

    // 切区：优先蒙德（该区已在地表地图可达时），身份保持且标题更新。
    const nextZone = bgmManifest.zones.find((zone) => zone.state === 'State_MengDe');
    if (await page.$(`path[data-zone-key=${JSON.stringify(nextZone.id)}]`) !== null) {
      await openZoneByState(nextZone.state);
      check(await page.evaluate(() => document.querySelector('.music-player') === window.__panelEl
        && document.querySelector('.music-player audio') === window.__audioEl),
      '切换分区播放器与 audio 元素不重挂');
      await page.waitForFunction(
        (name) => document.querySelector('.zone-name')?.textContent === name,
        {timeout: 5000}, nextZone.name);
      check((await page.$eval('.zone-name', (node) => node.textContent)) === nextZone.name,
        `切区后播放器标题更新为新分区（${nextZone.name}）`);
    }

    // 先收展开区，再关闭播放器，后续楼层回归从无播放器状态开始。
    check(await playerDetailsVisible(page), '切换分区保留已展开的试听选项');
    check(await collapsePlayerDetails(page), '切区后 Escape 先收试听选项并恢复入口焦点');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.music-player', {hidden: true});
    check(await panelClosed(page, '.music-player'), 'Escape 关闭播放器');
  }

  const sourcePath = process.env.TEYVAT_BGM_MANIFEST ?? path.join(workspaceRoot, 'dist/genshin-region-bgm.json');
  const sourceBgm = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const floorAudit = await page.evaluate(async ({floorVolumeBindings, floorAnchors}) => {
    const data = await (await fetch('/data/genshin-region-bgm.json')).json();
    const byFloor = new Map();
    for (const [id, floor] of Object.entries(data.layerFloor)) {
      if (!byFloor.has(floor)) byFloor.set(floor, new Set());
      byFloor.get(floor).add(Number(id));
    }
    const ground = new Set([data.zones, ...Object.values(data.scenes)].flat()
      .flatMap((zone) => zone.areaIds));
    if (Object.keys(data.surfaceLayerExclusions).some((id) => ground.has(Number(id)))) return false;
    return Object.entries(data.floorViews).every(([key, zones]) => zones.every((zone) => {
      if (zone.heightIndependent) return zone.lines.length === 0;
      if (zone.inheritedFrom) {
        return zone.lines.length === 0 && floorAnchors[key]?.some(({layerId, areaId, state}) =>
          byFloor.get(key)?.has(layerId) && areaId === zone.inheritedFrom && state === zone.state);
      }
      return zone.areaIds.every((id) => floorVolumeBindings[id]
        ?.some((layer) => byFloor.get(key)?.has(layer)));
    }));
  }, {floorVolumeBindings: sourceBgm.floorVolumeBindings, floorAnchors: sourceBgm.floorAnchors});
  check(floorAudit, '逐条核对楼层各自的音区来源，楼层专属区不盖到地面');
  await openFloorGroup(page, '残辉岩窟');
  await page.waitForSelector('.tile-layer.floor-context ~ .layer-piece[src*="3740001"]');
  const caveKey = 'layer-3:3740001-70500';
  await page.waitForSelector(`path[data-zone-key="${caveKey}"]`);
  check(await panelClosed(page, '.music-player')
    && !(await page.$eval('.region-boundaries', (edge) => edge.getAttribute('d'))),
    '残辉岩窟打开时使用本层贴片，地表边线不跟随');
  const cave = sourceBgm.floorViews['3:3740001'][0];
  const caveHit = await inspectFloor(page, new Map([[caveKey, cave.state]]));
  check(caveHit.blank > 0 && caveHit.leaks === 0 && caveHit.target,
    '残辉岩窟试听范围贴合这层的非透明贴片，空处无命中');
  await page.mouse.move(caveHit.target.x, caveHit.target.y);
  await page.mouse.click(caveHit.target.x, caveHit.target.y);
  await waitForAudio(page, expectedZoneTracks(sourceBgm, cave.state, 'exploration')[0]);
  check((await page.$eval('.music-player', (node) => node.innerText)).includes('残辉岩窟'),
    '点击楼层可听同一音乐状态，播放器使用实际楼层名称');
  await page.screenshot({path: path.join(shotDir, '13-cave-independent.png')});
  check(await page.$eval('button.reset', (b) => b.getAttribute('aria-label')) === '复位到当前楼层',
    '分层模式复位按钮名称与真实行为一致（当前楼层）');
  await page.click('button[aria-label="切换分层地图"]');
  await page.waitForSelector('.music-player', {hidden: true});
  check(await panelClosed(page, '.music-player'), '回到地表清理楼层播放选择');
  check(await page.$eval('button.reset', (b) => b.getAttribute('aria-label')) === '复位到全图',
    '回地表后复位按钮名称恢复（全图）');

  // 长组名不缩字 + 搜索空状态 + 面板 Escape 还焦点。
  await openFloorGroup(page, '月矩力');
  const groupLabelBox = await page.$eval('button[aria-label="分层区域"]', (button) => {
    const label = button.querySelector('.group-label');
    return {font: getComputedStyle(label).fontSize, clipped: label.scrollWidth > label.clientWidth + 1};
  });
  check(groupLabelBox.font === '14px', `长组名保持基准字号不缩字（${groupLabelBox.font}）`);
  check(groupLabelBox.clipped === false, '长组名在按钮内完整显示');
  await page.click('button[aria-label="分层区域"]');
  await page.type('input[aria-label="搜索分层区域"]', 'zzzz');
  await page.waitForSelector('.no-match', {visible: true});
  const staleOptions = await page.$$eval('#layer-group-panel [role="option"]', (lis) => lis.length);
  check(staleOptions === 0, `搜索不匹配时不置顶旧已选组（${staleOptions} 项残留）`);
  check(true, '搜索无匹配显示自然空状态');
  await page.keyboard.press('Escape');
  check(await panelClosed(page, '#layer-group-panel'), 'Escape 关闭分组搜索面板');
  check(await page.$eval('button[aria-label="分层区域"]', (b) => document.activeElement === b),
    '分组面板关闭后焦点回到分组按钮');
  await page.click('button[aria-label="切换分层地图"]');

  await openMeropide(page);
  // 目标分区与期望曲单同源（graph 解析含昼夜补偿）：保证右键命中的分区
  // 与等待播放的曲目来自同一条 UI 消费路径。
  const meropideDesired = new Map();
  for (const zone of bgmManifest.floorViews['3:3360102']) {
    const tracks = expectedZoneTracks(bgmManifest, zone.state, 'exploration');
    if (tracks.length === 3) meropideDesired.set(`layer-3:3360102-${zone.id}`, zone.state);
  }
  if (meropideDesired.size === 0) throw new Error('监舍区没有曲单完整的分区可试听');
  const floor = await inspectFloor(page, meropideDesired);
  check(floor.ids.join(',') === '3360102,3360103', '监舍区只绘制当前两张贴片');
  check(floor.native, '监舍区贴片在原生像素上限以内');
  check(floor.blank > 0 && floor.leaks === 0, `透明留白无音乐区命中（${floor.blank} 个样点）`);
  if (!floor.target) throw new Error('未找到梅洛彼得堡三首曲目的实际地图命中点');
  floor.expectedSources = expectedZoneTracks(bgmManifest, floor.target.state, 'exploration');
  floor.expectedCombat = expectedZoneTracks(bgmManifest, floor.target.state, 'combat')[0] ?? null;
  await page.mouse.move(floor.target.x, floor.target.y);
  await page.waitForSelector('.region-tooltip', {visible: true});
  await page.screenshot({path: path.join(shotDir, '08-floor-hover.png')});
  await page.mouse.click(floor.target.x, floor.target.y, {button: 'right'});
  await waitForAudio(page, floor.expectedSources[0]);
  check(await page.$('.region-tooltip') === null, '播放器打开后收起同一区域的提示');
  await page.waitForFunction(() => {
    const panel = document.querySelector('.music-player');
    if (!panel || panel.classList.contains('glass-player-enter-active')) return false;
    const style = getComputedStyle(panel);
    return style.transform === 'none' && style.opacity === '1';
  });
  await page.evaluate(() => {
    const panel = document.querySelector('.music-player');
    const audio = panel.querySelector('audio');
    const start = panel.getBoundingClientRect();
    const frames = [];
    const sample = () => {
      const current = document.querySelector('.music-player');
      const rect = current?.getBoundingClientRect();
      frames.push(current === panel && current.querySelector('audio') === audio
        && rect.y === start.y && rect.height === start.height);
      if (!window.__stopPlayerSample) requestAnimationFrame(sample);
    };
    window.__playerFrameSample = frames;
    requestAnimationFrame(sample);
  });
  await page.click('button[aria-label="下一首"]');
  await waitForAudio(page, floor.expectedSources[1]);
  await page.click('button[aria-label="下一首"]');
  await waitForAudio(page, floor.expectedSources[2]);
  await page.waitForFunction(() => window.__playerFrameSample.length > 2);
  const stable = await page.evaluate(() => {
    window.__stopPlayerSample = true;
    return window.__playerFrameSample.length > 2 && window.__playerFrameSample.every(Boolean);
  });
  check(stable, '切歌逐帧保留播放器、音频节点和外框尺寸');
  check(await page.$eval('button[aria-label="下一首"]', (button) => button.disabled),
    '监舍区通过右键试听同一播放列表内的三首音轨');
  await page.screenshot({path: path.join(shotDir, '09-floor-player.png')});
  if (floor.expectedCombat) {
    await openPlayerDetails(page);
    await chooseTab(page, '音乐模式', 'combat');
    await playFirstListed(page);
    await waitForAudio(page, floor.expectedCombat);
    check(true, '切到战斗时播放对应的战斗音轨');
    check(await collapsePlayerDetails(page), 'Escape 收起楼层试听选项并恢复入口焦点');
  }
  await page.click('button[aria-label="切换分层地图"]');
  await page.waitForFunction(() => !document.querySelector('.layer-piece, path[data-zone-key^="layer-"], .music-player'));
  check(await page.$('path[aria-label*="梅洛彼得堡"]') === null, '返回地表后无梅洛彼得堡楼层区边线或命中');
  await page.click('button[aria-label="复位到全图"]');

  const desktopVolume = await context.newPage();
  try {
    await desktopVolume.setViewport({width: 1100, height: 750});
    await desktopVolume.goto(`http://127.0.0.1:${port}/`);
    await desktopVolume.waitForSelector('button[aria-label="切换分层地图"]', {visible: true});
    await openMeropide(desktopVolume);
    const {target} = await inspectFloor(desktopVolume, meropideDesired);
    if (!target) throw new Error('桌面音量验证缺少可试听分区');
    await desktopVolume.mouse.click(target.x, target.y);
    await desktopVolume.waitForSelector(volumeTrigger, {visible: true});
    await desktopVolume.waitForSelector('.glass-player-enter-active', {hidden: true});
    const desktopTransport = await desktopVolume.evaluate(() => {
      const panel = document.querySelector('.music-player');
      const list = panel.querySelector('.transport .details-toggle');
      if (!list) return false;
      const bounds = panel.getBoundingClientRect();
      const right = bounds.right - parseFloat(getComputedStyle(panel.querySelector('.player-body')).paddingRight);
      const play = panel.querySelector('.play-toggle').getBoundingClientRect();
      const next = panel.querySelector('[aria-label="下一首"]').getBoundingClientRect();
      const repeatControl = panel.querySelector('.repeat-toggle');
      const repeat = repeatControl.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(repeatControl.parentElement).getPropertyValue('--transport-gap'));
      return Math.abs(list.getBoundingClientRect().right - right) < 1
        && Math.abs(repeat.left - next.right - gap) < 1
        && Math.abs((play.left + play.right) / 2 - (bounds.left + bounds.right) / 2) < 1;
    });
    check(desktopTransport, '桌面主播放键居中，循环紧接下一首，歌曲列表靠右');
    check(await openPlayerVolume(desktopVolume), '桌面音量展开后滑杆可用，关闭和进度无遮挡');
    await desktopVolume.keyboard.press('Home');
    await desktopVolume.keyboard.press('ArrowRight');
    check(await desktopVolume.$eval('.music-player audio', (audio) =>
      audio.volume === 0.01 && !audio.muted), '桌面键盘音量控制真实改变音频音量');
    check(await closePlayerVolume(desktopVolume), '桌面 Escape 关闭音量并还原焦点');
  } finally {
    await desktopVolume.close();
  }

  // 390×844 窄窗：无横向溢出、控件在视口内、悬停命中仍正确。
  await page.setViewport({width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true});
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitTilesDecoded(page, 60000);
  const narrow = await page.evaluate(() => {
    const controls = document.querySelector('.app-controls').getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      controlsRight: controls.right,
      controlsBottom: controls.bottom,
    };
  });
  check(narrow.scrollWidth <= 390, `窄窗无横向溢出（scrollWidth=${narrow.scrollWidth}）`);
  check(narrow.controlsRight <= 390 && narrow.controlsBottom <= 844, '窄窗缩放控件在视口内');
  const narrowHover = await page.evaluate(() => {
    const path = document.querySelector('path[data-zone-key]');
    if (!path) return {point: {x: 195, y: 422}, regionId: null};
    const rect = path.getBoundingClientRect();
    const point = {x: Math.min(Math.max(rect.left + rect.width / 2, 10), 380),
                   y: Math.min(Math.max(rect.top + rect.height / 2, 10), 830)};
    const hit = document.elementFromPoint(point.x, point.y);
    return {point, regionId: hit?.closest?.('path[data-zone-key]')?.dataset.zoneKey ?? null};
  });
  await page.mouse.move(narrowHover.point.x, narrowHover.point.y, {steps: 4});
  await new Promise((resolve) => setTimeout(resolve, 200));
  state = await worldState(page);
  check(state.hoverRegion === narrowHover.regionId,
    `窄窗悬停命中一致（hover=${state.hoverRegion}，elementFromPoint=${narrowHover.regionId}）`);
  await page.screenshot({path: path.join(shotDir, '07-narrow-390.png')});
  await openMeropide(page);
  const narrowFloor = await inspectFloor(page, meropideDesired);
  check(narrowFloor.native && narrowFloor.leaks === 0 && narrowFloor.target !== null,
    `高 DPI 窄窗分层一致（原生像素 ${narrowFloor.native}，背景命中 ${narrowFloor.leaks}/${narrowFloor.blank}）`);
  if (!narrowFloor.target) throw new Error('窄窗未找到可试听的监舍区');
  narrowFloor.expectedSources = expectedZoneTracks(bgmManifest, narrowFloor.target.state, 'exploration');
  const tapMark = await page.evaluate(({x, y}) =>
    getComputedStyle(document.elementFromPoint(x, y)).getPropertyValue('-webkit-tap-highlight-color'),
  narrowFloor.target);
  check(tapMark === 'rgba(0, 0, 0, 0)', '触屏分区只用矢量高亮，浏览器点击矩形为透明');
  await page.touchscreen.tap(narrowFloor.target.x, narrowFloor.target.y);
  await openPlayerDetails(page);
  await chooseTab(page, '音乐模式', 'exploration');
  await openPlayerDetails(page, {songs: true});
  await playFirstListed(page);
  await waitForAudio(page, narrowFloor.expectedSources[0]);
  await page.screenshot({path: path.join(shotDir, '10-narrow-floor-player.png')});

  // 390px：播放器与条件抽屉、下拉弹层完整落在视口内，Escape 分层关闭。
  const narrowPlayerBox = await page.$eval('.music-player', (node) => {
    const rect = node.getBoundingClientRect();
    const mapControls = document.querySelectorAll('.zoom-controls, .layer-picker .floors');
    const overlapsControls = [...mapControls].some((control) => {
      const bounds = control.getBoundingClientRect();
      return rect.left < bounds.right && rect.right > bounds.left
        && rect.top < bounds.bottom && rect.bottom > bounds.top;
    });
    return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, overlapsControls};
  });
  check(narrowPlayerBox.left >= 0 && narrowPlayerBox.right <= 390
    && narrowPlayerBox.top >= 0 && narrowPlayerBox.bottom <= 844
    && narrowPlayerBox.overlapsControls === false,
    `窄窗播放器完整可见且不遮挡地图与分层控件（${JSON.stringify(narrowPlayerBox)}）`);
  if (await playerDetailsVisible(page)) {
    const narrowDrawerBox = await page.evaluate(() => {
      const rect = document.querySelector('.player-drawer').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.player-drawer li button, .player-drawer .condition-row')]
        .map((row) => row.getBoundingClientRect().height);
      return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        rowHeight: rows.length ? Math.min(...rows) : 0};
    });
    check(narrowDrawerBox.left >= 0 && narrowDrawerBox.right <= 390
      && narrowDrawerBox.top >= 0 && narrowDrawerBox.bottom <= 844,
      `窄窗试听展开区完整落在视口内（${JSON.stringify(narrowDrawerBox)}）`);
    check(narrowDrawerBox.rowHeight >= 30,
      `窄窗队列行高可触达（${narrowDrawerBox.rowHeight.toFixed(0)}px）`);
    if (await page.$('.condition-row .select-trigger')) {
      // 下拉层独立定位，检查它与视口、触发器和播放控制的关系。
      await page.click('.condition-row .select-trigger');
      await page.waitForSelector('.select-popup', {visible: true});
      const narrowPopupBox = await page.evaluate(() => {
        const popup = document.querySelector('.select-popup').getBoundingClientRect();
        const trigger = document.querySelector('.condition-row .select-trigger')
          .getBoundingClientRect();
        const transport = document.querySelector('.music-player .transport').getBoundingClientRect();
        const first = document.querySelector('.select-popup li[role="option"]');
        return {
          left: popup.left, right: popup.right, top: popup.top, bottom: popup.bottom,
          aboveTrigger: popup.bottom <= trigger.top + 1,
          overlapsTransport: popup.left < transport.right && popup.right > transport.left
            && popup.top < transport.bottom && popup.bottom > transport.top,
          optionHeight: first ? first.getBoundingClientRect().height : 0,
        };
      });
      check(narrowPopupBox.left >= 0 && narrowPopupBox.right <= 390
        && narrowPopupBox.top >= 0 && narrowPopupBox.bottom <= 844,
        `窄窗下拉弹层落在视口内（${JSON.stringify(narrowPopupBox)}）`);
      check(narrowPopupBox.aboveTrigger && narrowPopupBox.overlapsTransport === false,
        '窄窗条件下拉向上展开且不遮挡播放控制');
      check(narrowPopupBox.optionHeight >= 30,
        `窄窗下拉选项行高可触达（${narrowPopupBox.optionHeight.toFixed(0)}px）`);
      await page.screenshot({path: path.join(shotDir, '16-narrow-conditions.png')});
      await page.keyboard.press('Escape');
      check(await panelClosed(page, '.select-popup') && await playerDetailsVisible(page),
        '窄窗 Escape 先关下拉，试听展开区保留');
    } else {
      await page.screenshot({path: path.join(shotDir, '16-narrow-drawer.png')});
    }
    check(await collapsePlayerDetails(page), '窄窗 Escape 收起展开区并恢复入口焦点');
  }

  await page.click('button[aria-label="暂停"]');
  await page.waitForFunction(() => document.querySelector('.music-player audio').paused);
  await page.focus('input[aria-label="播放进度"]');
  await page.keyboard.press('ArrowRight');
  check(await page.$eval('.music-player audio', (audio) => audio.paused && audio.currentTime > 0.1),
    '暂停时可以调节进度，播放意图保持暂停');
  check(await page.$(volumeTrigger) === null && await page.$('.volume-panel') === null,
    '移动端无应用音量入口或滑杆');
  check(await page.$eval('.music-player audio', (audio) => audio.volume === 1 && !audio.muted),
    '移动端播放由系统音量控制');
  await page.click('button[aria-label="播放"]');
  await page.waitForFunction(() => !document.querySelector('.music-player audio').paused);
  await page.$eval('.music-player audio', (audio) => { audio.currentTime = audio.duration - 0.08; });
  await waitForAudio(page, narrowFloor.expectedSources[1]);
  check(true, '曲目结束后继续播放曲单的下一首');
  const repeatButton = '.music-player .repeat-toggle';
  check(await page.$eval(repeatButton, (button) => button.title === '列表循环'),
    '播放器默认列表循环');
  await page.click('button[aria-label="下一首"]');
  await waitForAudio(page, narrowFloor.expectedSources[2]);
  await page.$eval('.music-player audio', (audio) => { audio.currentTime = audio.duration - 0.08; });
  await waitForAudio(page, narrowFloor.expectedSources[0]);
  check(true, '循环播放在曲单结尾回到第一首');
  await page.click(repeatButton);
  check(await page.$eval(repeatButton, (button) => button.title === '单曲循环'
    && Boolean(button.querySelector('[data-repeat-one]')))
    && await page.$eval('.music-player audio', (audio) => audio.loop),
  '单曲循环显示带 1 的图标并启用原生循环');
  const loopingSource = await page.$eval('.music-player audio', (audio) => {
    audio.currentTime = audio.duration - 0.08;
    return audio.src;
  });
  await page.waitForFunction((source) => {
    const audio = document.querySelector('.music-player audio');
    return audio.src === source && !audio.paused && audio.currentTime < 1;
  }, {timeout: 5000}, loopingSource);
  check(true, '单曲循环回到当前曲目的开头');
  await page.click('button[aria-label="关闭播放器"]');
  await page.waitForSelector('.music-player', {hidden: true});
  await page.waitForFunction(() => !document.querySelector('.music-player audio'), {timeout: 3500});
  check(!(await page.$('.music-player audio')), '关闭播放器释放音频节点');
  check(resourceErrors.length === 0 && consoleErrors.length === 0,
    `无意外加载失败（资源 ${JSON.stringify(resourceErrors)}；控制台 ${consoleErrors.length} 条）`);

  await page.touchscreen.tap(narrowFloor.target.x, narrowFloor.target.y);
  await waitForAudio(page, narrowFloor.expectedSources[0]);
  await openPlayerDetails(page);
  check(await page.$eval('.music-player audio', (audio) => audio.volume === 1 && !audio.muted)
    && await page.$eval(repeatButton, (button) => button.title === '单曲循环'),
  '移动端重开播放器仍用系统音量并保留单曲循环');
  check(await collapsePlayerDetails(page), '复查循环设置后可收起歌曲列表');
  await page.click(repeatButton);
  check(await page.$eval(repeatButton, (button) => button.title === '列表循环'
    && !button.querySelector('[data-repeat-one]'))
    && await page.$eval('.music-player audio', (audio) => !audio.loop),
  '从单曲循环直接切回列表循环');
  await page.click('button[aria-label="下一首"]');
  await page.click('button[aria-label="上一首"]');
  await waitForAudio(page, narrowFloor.expectedSources[0]);
  check(true, '快速切换后以最新选择为准');

  const failedSource = narrowFloor.expectedSources[1];
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  let injectFailure = true;
  function intercept(request) {
    const url = new URL(request.url());
    if (injectFailure && url.pathname.endsWith(`/${failedSource}.opus`)) {
      void request.abort('failed');
    } else {
      void request.continue();
    }
  }
  page.on('request', intercept);
  try {
    await page.click('button[aria-label="下一首"]');
    await page.waitForSelector('button[aria-label="重试播放"]', {visible: true});
    check(await page.$eval('.track-name', (node) => node.dataset.source) === String(failedSource)
      && await page.$eval('.playback-status[role="status"]',
        (node) => node.textContent.trim()) === '音源读取失败',
    '音源断开时保留选中的曲目，并显示可重试状态');
    injectFailure = false;
    await page.click('button[aria-label="重试播放"]');
    await waitForAudio(page, failedSource);
    check(await page.$('.playback-status') === null, '重试成功后恢复播放并清除故障状态');
  } finally {
    await page.setRequestInterception(false);
    page.off('request', intercept);
  }

  await page.setViewport({width: 320, height: 640, deviceScaleFactor: 1, hasTouch: true});
  await page.waitForFunction(() => innerWidth === 320 && innerHeight === 640
    && document.querySelector('.app')?.clientHeight === innerHeight);
  const compact = await page.evaluate(() => {
    const player = document.querySelector('.music-player');
    const panel = player.getBoundingClientRect();
    const insideViewport = panel.left >= 0 && panel.top >= 0
      && panel.right <= innerWidth && panel.bottom <= innerHeight;
    const controls = [...player.querySelectorAll('.transport button, .transport input, .transport .time')]
      .filter((control) => !control.closest('[inert]'));
    controls.push(player.querySelector('button[aria-label="关闭播放器"]'),
      player.querySelector('input[aria-label="播放进度"]'));
    const blockedControls = controls
      .filter((control) => {
        if (!control) return true;
        const bounds = control.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return !bounds.width || !bounds.height || bounds.left < panel.left
          || bounds.right > panel.right || bounds.top < panel.top || bounds.bottom > panel.bottom
          || !control.contains(hit);
      }).map((control) => control?.getAttribute('aria-label') ?? '缺少控件');
    return {
      insideViewport,
      blockedControls,
      viewport: [innerWidth, innerHeight],
      panel: [panel.left, panel.top, panel.right, panel.bottom],
    };
  });
  check(compact.insideViewport && compact.blockedControls.length === 0,
    `320px 下的播放、关闭和进度控件均在屏内且可命中（${JSON.stringify(compact)}）`);
  await page.screenshot({path: path.join(shotDir, '18-compact-player.png')});
  check(await page.$(volumeTrigger) === null && await page.$(volumeRange) === null,
    '320px 下音量控件不进入布局或焦点顺序');
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('teyvat-bgm-playback')).volume === 0.01),
    '移动端播放不覆盖保存的桌面音量');

  const retryPage = await context.newPage();
  let failManifest = true;
  await retryPage.setRequestInterception(true);
  retryPage.on('request', (request) => {
    if (failManifest && new URL(request.url()).pathname === '/data/genshin-region-bgm.json') {
      void request.abort('failed');
    } else {
      void request.continue();
    }
  });
  await retryPage.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'domcontentloaded'});
  await retryPage.waitForSelector('.music-unavailable', {visible: true});
  check(await retryPage.$('.globe-canvas') !== null, '音乐清单失败时地图仍可使用');
  failManifest = false;
  await retryPage.click('.music-unavailable button');
  await retryPage.waitForSelector('.music-unavailable', {hidden: true, timeout: 10000});
  check(await retryPage.$('.music-unavailable') === null, '音乐清单重试后恢复分区');
  await retryPage.close();

  console.log(JSON.stringify({
    ok: failures.length === 0,
    screenshots: fs.readdirSync(shotDir),
    tileRequests: tileResponses.length,
    failures,
  }, null, 2));
}

try {
  await main();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (previewProcess) {
    previewProcess.kill();
    const exited = new Promise((resolve) => previewProcess.on('exit', resolve));
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    console.log(`preview PID ${previewProcess.pid} 已关闭`);
  }
}
process.exit(failures.length === 0 ? 0 : 1);
