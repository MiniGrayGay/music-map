import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {setTimeout as wait} from 'node:timers/promises';
import {normalizeAudioBase} from '../src/features/bgm/audioUrl.js';
import {
  INITIAL_MUSIC_PREVIEW_VERSION, INITIAL_MUSIC_PREVIEWS, mergedVerifiedTracks,
} from '../src/features/bgm/verifiedTracks.js';
import {layerFileNames, reliefFileNames, tileFileNames} from './asset-layout.mjs';

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
  if (!status) return null;
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`导出目标不是普通目录 ${output}`);
  }
  const entries = await readdir(output, {recursive: true, withFileTypes: true});
  if (!entries.length) return {files: [], directories: []};
  if (entries.some((entry) => !entry.isFile() && !entry.isDirectory())) {
    throw new Error(`导出目录包含链接或其他非普通内容 ${output}`);
  }
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
  const snapshot = {files: [], directories: []};
  for (const entry of entries) {
    const file = path.relative(output, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    if (entry.isFile() && owned.has(file)) snapshot.files.push(file);
    else if (entry.isDirectory() && directories.has(file)) snapshot.directories.push(file);
    else throw new Error(`导出目录中有未登记的文件 ${file}`);
  }
  snapshot.files.sort();
  snapshot.directories.sort();
  return snapshot;
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
  // Exported files must stay independent of source files rewritten by a later build.
  await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

async function preserveAsset(source, target) {
  await mkdir(path.dirname(target), {recursive: true});
  // The export directory is discarded right after preservation, so hard links keep
  // the rollback snapshot without duplicating the previous site on disk.
  try {
    await link(source, target);
  } catch (error) {
    await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
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

async function copyFiles(source, target, files, transfer = copyAsset) {
  for (let index = 0; index < files.length; index += 32) {
    const batch = await Promise.allSettled(files.slice(index, index + 32).map((relative) =>
      transfer(path.join(source, relative), path.join(target, relative))));
    const failure = batch.find(({status}) => status === 'rejected');
    if (failure) throw failure.reason;
  }
}

async function createDirectories(output, directories) {
  for (const relative of directories) await mkdir(path.join(output, relative), {recursive: true});
}

async function missingSnapshotFiles(output, snapshot) {
  const status = await statIfPresent(output);
  if (!status) return snapshot.files;
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`待恢复路径已改变 ${output}`);
  const missing = new Set(snapshot.files);
  const directories = new Set(snapshot.directories);
  for (const entry of await readdir(output, {recursive: true, withFileTypes: true})) {
    const relative = path.relative(output, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    if (entry.isFile() && missing.delete(relative)) continue;
    if (entry.isDirectory() && directories.has(relative)) continue;
    throw new Error(`待恢复目录出现未登记内容 ${relative}`);
  }
  return [...missing];
}

async function copySite(source, target, snapshot, {preserve = false} = {}) {
  const transfer = preserve ? preserveAsset : copyAsset;
  await mkdir(target);
  try {
    await createDirectories(target, snapshot.directories);
    await copyFiles(source, target, snapshot.files.filter((name) => name !== 'index.html' && name !== marker), transfer);
    for (const relative of ['index.html', marker]) {
      if (snapshot.files.includes(relative)) await transfer(path.join(source, relative), path.join(target, relative));
    }
    if (JSON.stringify(await validateDestination(target)) !== JSON.stringify(snapshot)) {
      throw new Error(`复制后的站点文件不完整 ${target}`);
    }
  } catch (error) {
    try {
      await missingSnapshotFiles(target, snapshot);
      await discardGenerated(target);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `无法清理未完成的站点 ${target}`);
    }
    throw error;
  }
}

function isWindowsRenameLock(error) {
  return process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
}

async function installSite(source, target, snapshot) {
  try {
    await renameDirectory(source, target);
  } catch (error) {
    if (!isWindowsRenameLock(error) || await statIfPresent(target)) throw error;
    await copySite(source, target, snapshot);
  }
}

async function restoreAfterRemovalFailure(output, prior, snapshot) {
  if (!await statIfPresent(output)) {
    await installSite(prior, output, snapshot);
    await discardGenerated(prior);
    return;
  }
  const missing = await missingSnapshotFiles(output, snapshot);
  await createDirectories(output, snapshot.directories);
  await copyFiles(prior, output, missing);
  await discardGenerated(prior);
}

async function preserveDestination(output, prior, snapshot) {
  try {
    await renameDirectory(output, prior);
    return;
  } catch (error) {
    if (!isWindowsRenameLock(error)) throw error;
  }
  // Windows may block a directory rename while permitting removal of the generated snapshot.
  await copySite(output, prior, snapshot, {preserve: true});
  try {
    const current = await validateDestination(output);
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error(`导出目录在打包时发生变化 ${output}`);
  } catch (error) {
    await discardGenerated(prior);
    throw error;
  }
  try {
    await discardGenerated(output);
  } catch (error) {
    try {
      await restoreAfterRemovalFailure(output, prior, snapshot);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `无法恢复旧站点，已保留 ${prior}`);
    }
    throw error;
  }
  console.log('Windows 目录改名受限，已保留上一版快照并释放导出目录');
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
  const [index, tiles, layers, bgm, build, relief] = await Promise.all([
    readFile(path.join(source, 'index.html'), 'utf8'),
    readFile(path.join(source, 'tiles/meta.json'), 'utf8').then(JSON.parse),
    readFile(path.join(source, 'layers/manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(source, 'data/genshin-region-bgm.json'), 'utf8').then(JSON.parse),
    readFile(path.join(source, 'data/build-assets.json'), 'utf8').then(JSON.parse),
    readFile(path.join(source, 'relief/index.json'), 'utf8').then(JSON.parse),
  ]);
  const assets = [...new Set(Object.values(build).flatMap((chunk) =>
    [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]))];
  if (assets.some((file) => !/^assets\/[A-Za-z0-9_-]+\.(?:js|css|svg|webp|jpg|png|woff2)$/.test(file))) {
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
  // 已核实兜底曲与初始试听补曲整组随站点导出（同站绝对路径试听）：先核对
  // 现有音频指纹，与 dist/region-bgm-audio 下的完整音频大库相互独立，仅按
  // 清单精确取文件。初始试听版本须与站点清单客户端版本一致，segment id
  // 不得与图内音源冲突。
  if (INITIAL_MUSIC_PREVIEW_VERSION !== bgm.clientVersion) {
    throw new Error(`初始试听清单版本 ${INITIAL_MUSIC_PREVIEW_VERSION} 与客户端 ${bgm.clientVersion} 不一致`);
  }
  for (const track of INITIAL_MUSIC_PREVIEWS) {
    if (Object.hasOwn(bgm.musicGraph.media, String(track.id))) {
      throw new Error(`初始试听补曲 ${track.id} 与图内音源 id 冲突`);
    }
  }
  const verified = mergedVerifiedTracks();
  const verifiedFiles = verified.map((track) => `region-bgm-audio/${track.id}.opus`);
  await Promise.all(verified.map(async (track, index) => {
    const digest = createHash('sha256').update(
      await readFile(path.join(source, verifiedFiles[index])),
    ).digest('hex');
    if (digest !== track.audioSha256.toLowerCase()) {
      throw new Error(`已核实兜底音轨 ${track.id} 指纹不符`);
    }
  }));
  const reliefFiles = reliefFileNames(relief, bgm);
  const reliefSizes = await Promise.all(reliefFiles.map((relative) => assetSize(source, relative)));
  if (reliefSizes[1] !== relief.bytes) throw new Error('分区点阵发布字节数不符');
  const reliefBytes = reliefSizes[0] + reliefSizes[1];
  relativeFiles.push(...assets, ...verifiedFiles, ...tileFileNames(tiles), ...layerFileNames(layers), ...reliefFiles);
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
    await copyFiles(source, stage, relativeFiles);
    await writeFile(path.join(stage, 'data/genshin-region-bgm.json'), manifest, {flag: 'wx'});
    await writeFile(path.join(stage, marker), stamp, {flag: 'wx'});
    await writeFile(path.join(stage, 'index.html'), index, {flag: 'wx'});
    const snapshot = await validateDestination(stage);
    if (replace) await preserveDestination(output, prior, replace);
    try {
      await installSite(stage, output, snapshot);
    } catch (error) {
      if (replace) {
        try {
          await installSite(prior, output, replace);
          await discardGenerated(prior);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `无法恢复旧站点，已保留 ${prior}`);
        }
      }
      throw error;
    }
    if (replace) {
      const kept = await validateDestination(prior);
      if (JSON.stringify(kept) !== JSON.stringify(replace)) {
        throw new Error(`新站点已导出，备份目录发生变化并已保留 ${prior}`);
      }
      await discardGenerated(prior);
    }
  } finally {
    await discardGenerated(stage);
  }
  return {output, bytes, reliefBytes, files: relativeFiles.length + 3, audioBaseUrl};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values: args} = parseArgs({options: {
    'audio-base': {type: 'string'},
    output: {type: 'string'},
  }});
  const site = await exportStaticSite({output: args.output, audioBase: args['audio-base']});
  console.log(`已生成 ${site.files} 个静态文件，共 ${(site.bytes / 1e6).toFixed(1)} MB\n${site.output}`);
}
