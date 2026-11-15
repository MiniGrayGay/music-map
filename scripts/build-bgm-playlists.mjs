import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {buildMusicGraph, readMusicBanks, rebuildAreaPlaylists} from './wwise-music-graph.mjs';

const {values: args} = parseArgs({options: {
  bgm: {type: 'string'}, out: {type: 'string'}, 'game-exe': {type: 'string'},
  'audio-assets': {type: 'string'},
}});
if (!args.bgm || !args.out) throw new Error('需要 --bgm 指定已核实的音乐区清单，并以 --out 指定新文件');
const manifest = JSON.parse(await readFile(args.bgm, 'utf8'));
const folder = args['audio-assets'] ?? manifest.source.clientAudioRoot;
const fingerprints = manifest.verification.playlists.bankSha256;
if (!folder || !Object.keys(fingerprints).length || !manifest.musicGraph?.root) {
  throw new Error('音区清单缺少音频包或音乐入口的来源证据');
}
const game = args['game-exe'] ?? path.resolve(folder, '..', '..', '..', 'YuanShen.exe');
const executable = createHash('sha256');
for await (const piece of createReadStream(game)) executable.update(piece);
if (executable.digest('hex') !== manifest.source.clientExecutableSha256) {
  throw new Error('客户端指纹与 MapInfo 数据不符');
}
const {objects} = await readMusicBanks(folder, fingerprints);
const entry = manifest.musicGraph.root;
manifest.musicGraph.nodes = buildMusicGraph(objects, entry);
rebuildAreaPlaylists(manifest);
await writeFile(args.out, `${JSON.stringify(manifest)}\n`, {flag: 'wx'});
console.log(`从客户端重建了 ${Object.keys(manifest.musicGraph.nodes).length} 条音乐节点与 ${Object.keys(manifest.music).length} 个地点状态`);
