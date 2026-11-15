import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, open, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs, promisify} from 'node:util';
import {verifyOpus} from './opus-file.mjs';
import {readMusicMedia, readMusicMediaIndex} from './wwise-bank.mjs';

const {values: args} = parseArgs({options: {
  manifest: {type: 'string'}, 'audio-assets': {type: 'string'}, 'game-exe': {type: 'string'},
  decoder: {type: 'string'}, ffmpeg: {type: 'string', default: 'ffmpeg'},
  work: {type: 'string'}, out: {type: 'string'}, id: {type: 'string', multiple: true},
}});
if (!args.manifest || !args.decoder || !args.work || !args.out) {
  throw new Error('需要 --manifest、--decoder、--work 和 --out');
}
const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
const audioDirectory = args['audio-assets'] ?? manifest.source?.clientAudioRoot;
const identity = manifest.source?.clientExecutableSha256;
const media = manifest.musicGraph?.media;
if (!audioDirectory || !/^[a-f0-9]{64}$/i.test(identity ?? '') || !media) {
  throw new Error('清单缺少客户端或音源来源');
}
const game = args['game-exe'] ?? path.resolve(audioDirectory, '..', '..', '..', 'YuanShen.exe');
const hash = createHash('sha256');
for await (const bytes of createReadStream(game)) hash.update(bytes);
if (hash.digest('hex') !== identity) throw new Error('客户端指纹与音区清单不符');

const keys = args.id ?? Object.keys(media);
if (!keys.length || new Set(keys).size !== keys.length) throw new Error('音源编号为空或重复');
for (const id of keys) {
  if (!/^\d+$/.test(id) || !Object.hasOwn(media, id) || !Number.isFinite(media[id].duration)
    || media[id].duration <= 0) {
    throw new Error(`清单中没有有效的音源 ${id}`);
  }
}
const index = await readMusicMediaIndex(audioDirectory, keys.map(Number));
const output = path.resolve(args.out);
const source = path.resolve(args.work, 'track.wem');
const run = promisify(execFile);

function completion(process, label) {
  let detail = '';
  process.stderr.setEncoding('utf8');
  process.stderr.on('data', (chunk) => { detail = (detail + chunk).slice(-4000); });
  return new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败 (${signal ?? code}) ${detail.trim()}`));
    });
  });
}

async function transcode(input, target) {
  const decoder = spawn(args.decoder, ['-i', '-W', '4', '-p', input],
    {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const encoder = spawn(args.ffmpeg, [
    '-hide_banner', '-v', 'error', '-nostdin', '-f', 'wav', '-i', 'pipe:0', '-map', '0:a:0',
    '-map_metadata', '-1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on',
    '-compression_level', '10', '-application', 'audio', '-fflags', '+bitexact', '-f', 'opus',
    '-n', target,
  ], {windowsHide: true, stdio: ['pipe', 'ignore', 'pipe']});
  encoder.stdin.on('error', () => {});
  decoder.stdout.pipe(encoder.stdin);
  const jobs = [completion(decoder, 'Wwise 解码'), completion(encoder, 'Opus 编码')];
  try {
    await Promise.all(jobs);
  } catch (error) {
    if (decoder.exitCode === null) decoder.kill();
    if (encoder.exitCode === null) encoder.kill();
    await Promise.allSettled(jobs);
    throw error;
  }
}

async function removeScratch(file) {
  const info = await stat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!info) return;
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      'E:\\tools\\Remove-Directory.ps1', '-Path', file, '-Json'], {windowsHide: true});
  } else {
    await unlink(file);
  }
}

await (await open(source, 'wx')).close();
let bytes = 0;
try {
  await mkdir(output);
  for (const id of keys) {
    const file = path.join(output, `${id}.opus`);
    const pending = `${file}.part`;
    try {
      await writeFile(source, await readMusicMedia(index.get(Number(id))));
      await transcode(source, pending);
      const {size} = await stat(pending);
      await verifyOpus(pending, size, media[id].duration);
      await rename(pending, file);
      bytes += size;
    } finally {
      await removeScratch(pending);
    }
  }
} finally {
  await removeScratch(source);
}
console.log(`已从原始音乐 PCK 生成 ${keys.length} 首试听音轨，共 ${(bytes / 1e6).toFixed(1)} MB`);
