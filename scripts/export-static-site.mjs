import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {setTimeout as wait} from 'node:timers/promises';
import {normalizeAudioBase} from '../src/features/bgm/audioUrl.js';
import {layerFileNames, tileFileNames} from './asset-layout.mjs';

const dist = path.resolve(import.meta.dirname, '../dist');
const marker = 'data/site-export.json';
const markerFormat = 'teyvat-static-site-v1';
const run = promisify(execFile);

async function statIfPresent(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function validateDestination(output) {
  const status = await statIfPresent(output);
  if (!status) return false;
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`导出目标不是普通目录 ${output}`);
  }
  const entries = await readdir(output, {recursive: true, withFileTypes: true});
  if (!entries.length) return true;
  const stamp = await readFile(path.join(output, marker), 'utf8').then(JSON.parse, (error) => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`导出目标包含其他文件 ${output}`);
  });
  if (stamp.format !== markerFormat || !Array.isArray(stamp.files)
    || !stamp.files.every((file) => typeof file === 'string'
      && /^[A-Za-z0-9_./-]+$/.test(file) && !file.split('/').some((segment) => ['.', '..', ''].includes(segment)))) {
    throw new Error(`导出记录无效 ${output}`);
  }
  const owned = new Set([...stamp.files, marker]);
  const directories = new Set();
  for (const file of owned) {
    for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) {
      directories.add(directory);
    }
  }
  for (const entry of entries) {
    const file = path.relative(output, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    if ((entry.isFile() && owned.has(file)) || (entry.isDirectory() && directories.has(file))) continue;
    throw new Error(`导出目录中有未登记的文件 ${file}`);
  }
  return true;
}

async function discardGenerated(target) {
  if (!await statIfPresent(target)) return;
  if (process.platform === 'win32') {
    await run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'E:\\tools\\Remove-Directory.ps1',
      '-Path', target, '-Json',
    ], {windowsHide: true});
    if (await statIfPresent(target)) throw new Error(`清理未完成 ${target}`);
  } else {
    await rm(target, {recursive: true});
  }
}

async function assetSize(root, relative) {
  const info = await lstat(path.join(root, relative));
  if (!info.isFile() || !info.size) throw new Error(`无效发布文件 ${relative}`);
  return info.size;
}

async function copyAsset(source, target) {
  await mkdir(path.dirname(target), {recursive: true});
  try {
    await link(source, target);
  } catch (error) {
    if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

async function renameDirectory(source, target) {
  const retries = process.platform === 'win32' ? [50, 150, 400, 800, 1600] : [];
  for (const delay of retries) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await wait(delay);
    }
  }
  await rename(source, target);
}

export async function exportStaticSite({source = dist, output = path.join(dist, 'site'), audioBase}) {
  const audioBaseUrl = normalizeAudioBase(audioBase);
  if (!audioBaseUrl) throw new Error('请传入存放音频的公开目录 --audio-base');
  source = path.resolve(source);
  output = path.resolve(output);
  output = path.join(await realpath(path.dirname(output)), path.basename(output));
  source = await realpath(source);
  const relation = path.relative(output, source);
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))) {
    throw new Error('导出目录不能包含完整产物的源目录');
  }
  const stage = `${output}.stage`;
  const prior = `${output}.prior`;
  if (await statIfPresent(prior)) throw new Error(`存在待恢复的上次导出 ${prior}`);

  const relativeFiles = [
    'favicon.svg', 'tiles/meta.json', 'data/map-data.json', 'layers/manifest.json', 'layers/basemaps.json',
  ];
  const [index, tiles, layers, bgm, build] = await Promise.all([
    readFile(path.join(source, 'index.html'), 'utf8'),
    readFile(path.join(source, 'tiles/meta.json'), 'utf8').then(JSON.parse),
    readFile(path.join(source, 'layers/manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(source, 'data/genshin-region-bgm.json'), 'utf8').then(JSON.parse),
    readFile(path.join(source, 'data/build-assets.json'), 'utf8').then(JSON.parse),
  ]);
  const assets = [...new Set(Object.values(build).flatMap((chunk) =>
    [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]))];
  if (assets.some((file) => !/^assets\/[A-Za-z0-9_-]+\.(?:js|css|svg|webp|woff2)$/.test(file))) {
    throw new Error('发现未识别的构建资产路径');
  }
  const entries = Array.from(index.matchAll(/(?:src|href)="(?:\.\/|\/)?assets\/([^"]+)"/g),
    (match) => `assets/${match[1]}`);
  if (entries.length === 0 || entries.some((entry) => !assets.includes(entry))) {
    throw new Error('请先构建可用的网页产物');
  }
  if (!bgm.musicGraph?.media || tiles.version !== bgm.clientVersion
    || layers.game.version !== bgm.clientVersion) {
    throw new Error('网页、地图与音乐文件版本不一致');
  }
  bgm.musicGraph.audioBaseUrl = audioBaseUrl;
  const manifest = JSON.stringify(bgm);
  relativeFiles.push(...assets, ...tileFileNames(tiles), ...layerFileNames(layers));
  const stamp = JSON.stringify({format: markerFormat,
    files: [...relativeFiles, 'index.html', 'data/genshin-region-bgm.json']});
  let bytes = Buffer.byteLength(index) + Buffer.byteLength(manifest) + Buffer.byteLength(stamp);
  for (let index = 0; index < relativeFiles.length; index += 32) {
    const batch = relativeFiles.slice(index, index + 32);
    const sizes = await Promise.all(batch.map((relative) => assetSize(source, relative)));
    bytes += sizes.reduce((sum, current) => sum + current, 0);
  }

  await mkdir(stage);
  try {
    const replace = await validateDestination(output);
    await mkdir(path.join(stage, 'data'));
    for (let index = 0; index < relativeFiles.length; index += 32) {
      const batch = await Promise.allSettled(relativeFiles.slice(index, index + 32).map((relative) =>
        copyAsset(path.join(source, relative), path.join(stage, relative))));
      const failure = batch.find(({status}) => status === 'rejected');
      if (failure) throw failure.reason;
    }
    await writeFile(path.join(stage, 'data/genshin-region-bgm.json'), manifest, {flag: 'wx'});
    await writeFile(path.join(stage, marker), stamp, {flag: 'wx'});
    await writeFile(path.join(stage, 'index.html'), index, {flag: 'wx'});
    if (replace) await renameDirectory(output, prior);
    try {
      await renameDirectory(stage, output);
    } catch (error) {
      if (replace) await renameDirectory(prior, output);
      throw error;
    }
    if (replace) await discardGenerated(prior);
  } finally {
    await discardGenerated(stage);
  }
  return {output, bytes, files: relativeFiles.length + 3, audioBaseUrl};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values: args} = parseArgs({options: {
    'audio-base': {type: 'string'},
    output: {type: 'string'},
  }});
  const site = await exportStaticSite({output: args.output, audioBase: args['audio-base']});
  console.log(`已生成 ${site.files} 个静态文件，共 ${(site.bytes / 1e6).toFixed(1)} MB\n${site.output}`);
}
