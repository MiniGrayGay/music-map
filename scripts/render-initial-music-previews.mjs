import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {link, lstat, readFile, readdir, realpath, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual, promisify} from 'node:util';
import {verifyOpus} from './opus-file.mjs';
import {readWwiseBank, shortId} from './wwise-bank.mjs';
import {readMusicBanks} from './wwise-music-graph.mjs';
import {supportedBankVersion} from './wwise-music.mjs';

const run = promisify(execFile);
const project = path.resolve(import.meta.dirname, '..');
const workspace = path.resolve(project, '../..');
const audioDirectory = path.join(workspace, 'dist/region-bgm-audio');
const scratch = path.join(workspace, 'cache/teyvat-initial-music');
const renderDirectory = path.join(scratch, 'render');
const registryPath = path.join(project, 'src/features/bgm/initialMusicPreviews.json');
const ffmpeg = process.env.TEYVAT_FFMPEG ?? 'E:/Programs/ffmpeg/bin/ffmpeg.exe';
const samplesPerMillisecond = 48;
const samplesPerSecond = 48000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samples = (milliseconds) => Math.round(milliseconds * samplesPerMillisecond);

function rtpcDefaults(bank) {
  const bankVersion = bank.readUInt32LE(8);
  if (bankVersion !== 134 || bankVersion !== supportedBankVersion) {
    throw new Error('STMG RTPC 解析只支持 Wwise 134');
  }

  let settings;
  let bankOffset = 0;
  while (bankOffset + 8 <= bank.length) {
    const begin = bankOffset + 8;
    const end = begin + bank.readUInt32LE(bankOffset + 4);
    if (end > bank.length) throw new Error('初始化 Bank 区块不完整');
    if (bank.toString('ascii', bankOffset, bankOffset + 4) === 'STMG') {
      if (settings) throw new Error('初始化 Bank 中 STMG 不唯一');
      settings = bank.subarray(begin, end);
    }
    bankOffset = end;
  }
  if (!settings || bankOffset !== bank.length) throw new Error('初始化 Bank 缺少完整的 STMG');

  let offset = 0;
  function take(width) {
    const start = offset;
    offset += width;
    if (offset > settings.length) throw new Error('STMG 的 RTPC 记录不完整');
    return start;
  }

  const uint = () => settings.readUInt32LE(take(4));
  // Wwise 134: voice settings, state groups, switch groups, then game parameters.
  take(8);
  const stateGroups = uint();
  for (let index = 0; index < stateGroups; index += 1) {
    take(8);
    take(uint() * 12);
  }
  const switchGroups = uint();
  for (let index = 0; index < switchGroups; index += 1) {
    take(9);
    take(uint() * 12);
  }
  const parameters = uint();
  const defaults = new Map();
  for (let index = 0; index < parameters; index += 1) {
    const id = uint();
    const value = settings.readFloatLE(take(4));
    take(13);
    if (defaults.has(id) || !Number.isFinite(value)) {
      throw new Error('无效的 STMG RTPC 默认值 ' + id);
    }
    defaults.set(id, value);
  }
  if (!defaults.size) throw new Error('STMG 未提供 RTPC 默认值');
  return defaults;
}

async function loadDefaults(root, proof) {
  const id = shortId('Init');
  const banks = Object.entries(proof?.banks ?? {});
  if (proof?.bankId !== id || banks.length < 2) throw new Error('缺少 Init Bank 交叉验证证据');
  const verified = [];
  for (const [file, fingerprint] of banks) {
    if (!/^(?:Minimum|Banks\d+)\.pck$/i.test(file)) {
      throw new Error('无效的 Init Bank 路径 ' + file);
    }
    const bank = await readWwiseBank(path.join(root, file), id);
    if (sha256(bank) !== fingerprint) throw new Error('Init Bank 指纹不符 ' + file);
    verified.push(rtpcDefaults(bank));
  }
  if (!verified.every((defaults) => isDeepStrictEqual(defaults, verified[0]))) {
    throw new Error('两个 Init Bank 的 RTPC 默认值不一致');
  }
  return verified[0];
}

function supportsTrack(track, parameter) {
  // AkPropID 7 is Priority. A volume RTPC uses the separate ParamID 0 namespace.
  const parameters = track.parameters ?? {};
  return track.type === 0 && track.subTrackCount === 1 && track.clips.length === 1
    && Object.keys(parameters).every((key) => key === 'properties' || key === parameter)
    && !parameters.properties?.some(({pID}) => pID !== 7);
}

function stemVolume(track, defaults) {
  if (!supportsTrack(track, 'rtpc') || track.parameters?.rtpc?.length !== 1) return null;

  const [curve] = track.parameters.rtpc;
  const {RTPCID: id, rtpcType, rtpcAccum, ParamID, eScaling} = curve;
  const points = curve.pRTPCMgr?.AkRTPCGraphPoint;
  if (rtpcType !== 0 || rtpcAccum !== 2 || ParamID !== 0 || eScaling !== 2
    || !Array.isArray(points) || points.length < 2 || !defaults.has(id)
    || points.some(({From, To}, index) => !Number.isFinite(From) || !Number.isFinite(To)
      || (index > 0 && From <= points[index - 1].From))) return null;

  const value = defaults.get(id);
  const endpoint = [points[0], points.at(-1)].find(({From}) => From === value);
  if (!endpoint || (endpoint.To !== 0 && endpoint.To !== -1)) return null;
  return {id, decibels: endpoint.To === 0 ? 0 : -96.3};
}

function clippedStem(clip, decibels, entry, exit) {
  const {trackID, sourceID, eventID, fPlayAt, fBeginTrimOffset, fEndTrimOffset, fSrcDuration} = clip;
  if (trackID !== 0 || eventID !== 0 || !Number.isSafeInteger(sourceID) || sourceID <= 0
    || ![fPlayAt, fBeginTrimOffset, fEndTrimOffset, fSrcDuration].every(Number.isFinite)
    || fBeginTrimOffset < 0 || fEndTrimOffset > 0 || fSrcDuration <= 0) return null;

  const start = Math.max(entry, fPlayAt + fBeginTrimOffset);
  const end = Math.min(exit, fPlayAt + fSrcDuration + fEndTrimOffset);
  const from = Math.max(0, samples(start - fPlayAt));
  const until = samples(end - fPlayAt);
  if (until <= from) return null;
  return {
    source: sourceID,
    sourceSamples: samples(fSrcDuration),
    from,
    until,
    delay: samples(start) - samples(entry),
    decibels,
  };
}

function allowsPreEntry(rule, setting) {
  const {AkMusicTransDstRule: destination, AllocTransObjectFlag: transition} = rule;
  return destination?.bPlayPreEntry === setting && !transition
    && destination.transitionTime === 0 && destination.iFadeOffset === 0
    && destination.uCueFilterHash === 0 && destination.eEntryType === 0
    && destination.uJumpToID === 0 && destination.eJumpToType === 0
    && destination.bDestMatchSourceCueName === 0;
}

function initialPlaybackUsesPreEntry(segmentId, objects) {
  const parents = [];
  for (const object of objects.values()) {
    // An alternate direct entry without playlist transition rules remains unsupported.
    if (object.kind === 'switch' && object.leaves.some(([, target]) => target === segmentId)) {
      return false;
    }
    if (object.kind !== 'playlist') continue;
    const leaves = [];
    function visitItems(items) {
      for (const item of items) {
        if (item.children?.length) visitItems(item.children);
        else leaves.push(item);
      }
    }
    visitItems(object.items);
    if (!leaves.some(({SegmentID}) => SegmentID === segmentId)) continue;
    parents.push({object, leaves});
  }
  return parents.length > 0 && parents.every(({object, leaves}) => {
    if (leaves.length !== 1 || object.transitions.length !== 2) return false;
    const ruleFor = (id) => object.transitions.find(({uNumSrc, srcID, uNumDst, dstID}) =>
      uNumSrc === 1 && uNumDst === 1 && srcID === id && dstID === id);
    const initial = ruleFor(-1);
    const repeat = ruleFor(segmentId);
    return initial && repeat && allowsPreEntry(initial, 255) && allowsPreEntry(repeat, 0);
  });
}

function preEntryFade(track, stem) {
  const curves = track.parameters.clipAutomation;
  const curve = curves?.[0];
  const points = curve?.pArrayGraphPoints?.AkRTPCGraphPoint;
  if (curves?.length !== 1 || curve.uClipIndex !== 0 || curve.eAutoType !== 4
    || curve.uNumPoints !== 3 || points?.length !== 3) return null;
  const [hold, fadeStart, fadeEnd] = points;
  if (hold.From !== 0 || hold.To !== 1 || hold.Interp !== 9
    || fadeStart.To !== 1 || fadeStart.Interp !== 6
    || fadeEnd.To !== 0 || fadeEnd.Interp !== 9
    || !Number.isFinite(fadeStart.From) || !Number.isFinite(fadeEnd.From)) return null;
  // Automation point times are stored in seconds, unlike clip positions.
  const from = fadeStart.From * samplesPerSecond;
  const until = fadeEnd.From * samplesPerSecond;
  if (from < stem.from || until <= from || Math.round(until) !== stem.until) return null;
  return {from, until};
}

function preEntryPlan(id, tracks, objects, media, entry, exit) {
  if (entry <= 0 || !tracks.every((track) => supportsTrack(track, 'clipAutomation'))) return null;
  const ordered = [...tracks].sort((left, right) => left.clips[0].fPlayAt - right.clips[0].fPlayAt);
  if (ordered[1].parameters.clipAutomation) return null;
  const clips = ordered.map(({clips: [clip]}) => ({
    ...clip,
    fBeginTrimOffset: samples(clip.fBeginTrimOffset) === 0 ? 0 : clip.fBeginTrimOffset,
  }));
  const [intro, body] = clips;
  if (intro.fPlayAt < 0 || intro.fPlayAt + intro.fSrcDuration + intro.fEndTrimOffset
    > body.fPlayAt + body.fBeginTrimOffset) return null;
  const stems = clips.map((clip) => clippedStem(clip, 0, 0, exit));
  if (stems.some((stem) => !stem) || stems[0].source === stems[1].source
    || stems[0].delay + stems[0].until - stems[0].from !== samples(entry)
    || stems[1].delay !== samples(entry)
    || stems[1].delay + stems[1].until - stems[1].from !== samples(exit)) return null;
  const name = media[stems[0].source]?.title;
  if (typeof name !== 'string' || !name.trim() || name !== media[stems[1].source]?.title) return null;
  const fade = preEntryFade(ordered[0], stems[0]);
  if (!fade || !initialPlaybackUsesPreEntry(id, objects)) return null;
  stems[0].fade = fade;
  return {id, name, length: samples(exit), stems};
}

function planSegment(id, segment, objects, media, defaults) {
  if (segment.kind !== 'segment' || segment.issue !== 'multipleSourcesPerSegment'
    || segment.tracks?.length !== 2) return null;
  const bankSegment = objects.get(id);
  if (bankSegment?.kind !== 'segment' || bankSegment.trackIds.length !== 2
    || !isDeepStrictEqual(bankSegment.trackIds, segment.tracks.map(({id: trackId}) => trackId))) {
    throw new Error('音乐片段与已验证 Bank 不一致 ' + id);
  }

  const tracks = segment.tracks.map((track) => {
    const original = objects.get(track.id);
    // The exported graph uses JSON numbers, which normalize signed zero.
    if (original?.kind !== 'track' || JSON.stringify(track.clips) !== JSON.stringify(original.clips)
      || JSON.stringify(track.parameters ?? {}) !== JSON.stringify(original.parameters)) {
      throw new Error('音乐音轨与已验证 Bank 不一致 ' + track.id);
    }
    return original;
  });
  const {markers, duration} = bankSegment;
  if (markers.length < 2 || markers[0].name !== '' || markers.at(-1).name !== '') return null;
  const entry = markers[0].position;
  const exit = markers.at(-1).position;
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry < 0 || exit <= entry
    || !Number.isFinite(duration) || exit > duration + 0.001) return null;
  if (Object.hasOwn(media, id)) throw new Error('试听片段和原音源 ID 冲突 ' + id);

  const volumes = tracks.map((track) => stemVolume(track, defaults));
  if (volumes.some((value) => !value) || volumes[0].id !== volumes[1].id
    || volumes[0].decibels === volumes[1].decibels) {
    // Named interior sync cues do not interrupt this one-shot render.
    if (markers.slice(1, -1).some(({name, position}, index) => !name
      || !Number.isFinite(position) || position <= markers[index].position || position >= exit)) {
      return null;
    }
    return preEntryPlan(id, tracks, objects, media, entry, exit);
  }
  if (markers.length !== 2) return null;
  const stems = tracks.map((track, index) =>
    clippedStem(track.clips[0], volumes[index].decibels, entry, exit));
  if (stems.some((stem) => !stem) || stems[0].source === stems[1].source) return null;
  const title = media[stems.find(({decibels}) => decibels === 0).source]?.title;

  return {
    id,
    name: typeof title === 'string' && title.trim() ? title : null,
    length: samples(exit) - samples(entry),
    stems: stems.sort((left, right) => left.source - right.source),
  };
}

function fadeFilter(fade, sourceStart) {
  if (!fade) return '';
  const sampleIndex = 'n+' + sourceStart;
  const u = '((' + sampleIndex + '-' + fade.from + ')/' + (fade.until - fade.from) + ')';
  // Wwise Exp1 interpolates with u * (u + 1) / 2.
  const gain = 'if(lt(' + sampleIndex + ',' + fade.from + '),1,if(gte('
    + sampleIndex + ',' + fade.until + '),0,1-' + u + '*(' + u + '+1)/2))';
  return "aeval=exprs='val(ch)*" + gain + "':channel_layout=stereo,";
}

async function render(plan, media, verifiedInputs) {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror'];
  for (const stem of plan.stems) {
    const file = path.join(audioDirectory, stem.source + '.opus');
    if (!verifiedInputs.has(stem.source)) {
      const info = await lstat(file);
      if (!info.isFile() || !Number.isFinite(media[stem.source]?.duration)) {
        throw new Error('试听音源资料缺失 ' + stem.source);
      }
      const actual = await verifyOpus(file, info.size, media[stem.source].duration);
      verifiedInputs.set(stem.source, Math.round(actual * samplesPerSecond));
    }
    if (verifiedInputs.get(stem.source) !== stem.sourceSamples || stem.until > stem.sourceSamples) {
      throw new Error('试听音源与 Bank 的采样长度不符 ' + stem.source);
    }
    args.push('-i', file);
  }
  const filters = plan.stems.map(({from, until, delay, decibels, fade}, index) =>
    '[' + index + ':a]aformat=sample_rates=48000:channel_layouts=stereo,'
    + 'atrim=start_sample=' + from + ':end_sample=' + until + ',asetpts=PTS-STARTPTS,'
    + fadeFilter(fade, from)
    + 'adelay=' + delay + 'S:all=1,volume=' + decibels + 'dB[stem' + index + ']');
  filters.push('[stem0][stem1]amix=inputs=2:normalize=0,apad,atrim=end_sample=' + plan.length);
  args.push('-filter_complex', filters.join(';'), '-map_metadata', '-1', '-c:a', 'libopus',
    '-b:a', '192k', '-vbr', 'off', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    '-f', 'opus', 'pipe:1');

  const {stdout} = await run(ffmpeg, args, {
    encoding: 'buffer',
    env: {...process.env, TEMP: scratch, TMP: scratch},
    maxBuffer: Math.ceil(plan.length / samplesPerSecond * 30000) + 65536,
    windowsHide: true,
  });
  const file = path.join(renderDirectory, plan.id + '.opus');
  await writeFile(file, stdout, {flag: 'wx'});
  const duration = await verifyOpus(file, stdout.length, plan.length / samplesPerSecond);
  if (Math.round(duration * samplesPerSecond) !== plan.length) {
    throw new Error('试听产物采样长度不符 ' + plan.id);
  }
  return {file, duration, audioSha256: sha256(stdout)};
}

async function validateTarget(file, artifact) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || sha256(await readFile(file)) !== artifact.audioSha256) {
      throw new Error('保留已有正式资源，禁止覆盖 ' + file);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const manifest = JSON.parse(await readFile(path.join(workspace, 'dist/genshin-region-bgm.json'), 'utf8'));
const previous = JSON.parse(await readFile(registryPath, 'utf8'));
const root = manifest.source.clientAudioRoot;
const graph = manifest.musicGraph;
if (typeof manifest.clientVersion !== 'string' || previous.clientVersion !== manifest.clientVersion
  || !Array.isArray(previous.entries)) throw new Error('试听注册表与客户端版本不一致');

const [work, target] = await Promise.all([realpath(renderDirectory), realpath(audioDirectory)]);
if (path.relative(workspace, work) !== path.join('cache', 'teyvat-initial-music', 'render')
  || path.relative(workspace, target) !== path.join('dist', 'region-bgm-audio')
  || (await readdir(work)).length) {
  throw new Error('请先登记并建立空的工作区 cache/teyvat-initial-music/render');
}

const [defaults, {objects}] = await Promise.all([
  loadDefaults(root, manifest.verification.musicClock),
  readMusicBanks(root, manifest.verification.playlists.bankSha256),
]);

const plans = [];
for (const [key, segment] of Object.entries(graph.nodes)) {
  const plan = planSegment(Number(key), segment, objects, graph.media, defaults);
  if (plan) plans.push(plan);
}
if (!plans.length) throw new Error('当前版本没有可以核对的初始试听');

const rendered = new Map();
const publications = [];
const verifiedInputs = new Map();
for (const plan of plans) {
  const recipe = JSON.stringify([plan.length, plan.stems]);
  if (!rendered.has(recipe)) rendered.set(recipe, await render(plan, graph.media, verifiedInputs));
  const artifact = rendered.get(recipe);
  const output = path.join(audioDirectory, plan.id + '.opus');
  publications.push({plan, artifact, output, exists: await validateTarget(output, artifact)});
}

// Verify the entire batch before publishing its links or replacing the registry.
for (const {artifact, output, exists} of publications) {
  if (exists) continue;
  try {
    await link(artifact.file, output);
  } catch (error) {
    if (error.code !== 'EEXIST' || !await validateTarget(output, artifact)) throw error;
  }
}

const entries = publications.map(({plan, artifact}) => ({
  id: plan.id,
  name: plan.name,
  duration: artifact.duration,
  audioSha256: artifact.audioSha256,
})).sort((left, right) => left.id - right.id);
const stage = path.join(renderDirectory, 'initialMusicPreviews.json');
await writeFile(stage, JSON.stringify({clientVersion: manifest.clientVersion, entries}, null, 2) + '\n',
  {flag: 'wx'});
await rename(stage, registryPath);
const missingTitles = entries.filter(({name}) => name === null).map(({id}) => id);
console.log(JSON.stringify({rendered: rendered.size, entries, missingTitles}));

