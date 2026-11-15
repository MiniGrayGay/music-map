import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {buildMusicGraph, derivePlaylist} from './wwise-music-graph.mjs';

const homeGroup = 'StateGroup_musicHomeWorld';

function shortId(name) {
  let result = 2166136261;
  for (const code of Buffer.from(name.toLowerCase(), 'ascii')) {
    result = Math.imul(result, 16777619) ^ code;
  }
  return result >>> 0;
}

async function readProvenJson(file, expected) {
  const input = await readFile(file);
  if (createHash('sha256').update(input).digest('hex') !== expected) {
    throw new Error(`原始曲名表指纹不符 ${file}`);
  }
  return JSON.parse(input.toString('utf8').replace(/^\uFEFF/, ''));
}

function findTitleColumn(table, localized) {
  const hits = new Map();
  for (const row of table) {
    for (const [name, value] of Object.entries(row)) {
      if (Number.isSafeInteger(value) && localized[value]) {
        hits.set(name, (hits.get(name) ?? 0) + 1);
      }
    }
  }
  const [[name, count] = [], [, second] = []] = [...hits].sort((a, b) => b[1] - a[1]);
  if (!name || count < table.length * 0.9 || count === second) {
    throw new Error('HomeWorldBgmExcelConfigData 无法唯一连接中文曲名字段');
  }
  return name;
}

export async function homeTitles({tableFile, textMapFile, evidence, objects, musicGraph}) {
  const [table, localized] = await Promise.all([
    readProvenJson(tableFile, evidence.tableSha256),
    readProvenJson(textMapFile, evidence.textMapSha256),
  ]);
  const titleColumn = findTitleColumn(table, localized);
  const group = shortId(homeGroup);
  const roots = [...objects].filter(([, node]) => node.kind === 'switch' && node.groups.includes(group));
  if (roots.length !== 1 || roots[0][0] !== evidence.root) {
    throw new Error('无法从本机音频包验证尘歌壶曲目入口');
  }
  const [[root, rootNode]] = roots;
  const slot = rootNode.groups.indexOf(group);
  const graph = {
    root, nodes: buildMusicGraph(objects, root), noneState: musicGraph.noneState, media: musicGraph.media,
  };
  const candidates = new Map();
  for (const row of table) {
    const title = localized[row[titleColumn]];
    const bindings = Object.values(row).filter((value) =>
      typeof value === 'string' && value.startsWith(`${homeGroup}=`));
    if (!title || bindings.length !== 1) continue;
    const state = bindings[0].slice(homeGroup.length + 1);
    const id = shortId(state);
    const playlist = derivePlaylist(graph, {[group]: id});
    const [source] = playlist.sources;
    if (playlist.sources.length !== 1 || playlist.unresolved || playlist.path?.[0]?.keys[slot] !== id) {
      continue;
    }
    if (!candidates.has(source)) candidates.set(source, new Map());
    candidates.get(source).set(title, state);
  }
  return new Map([...candidates].filter(([, titles]) => titles.size === 1)
    .map(([id, titles]) => [id, [...titles][0]]));
}
