export const musicTypes = {segment: 10, track: 11, switch: 12, playlist: 13};
export const supportedBankVersion = 134;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  skip(length) {
    const start = this.offset;
    const end = start + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > this.bytes.length) {
      throw new Error(`字段超出记录范围，偏移 ${start}，长度 ${length}`);
    }
    this.offset = end;
    return start;
  }

  u8() { return this.bytes.readUInt8(this.skip(1)); }
  u16() { return this.bytes.readUInt16LE(this.skip(2)); }
  i16() { return this.bytes.readInt16LE(this.skip(2)); }
  u32() { return this.bytes.readUInt32LE(this.skip(4)); }
  i32() { return this.bytes.readInt32LE(this.skip(4)); }
  f32() { return this.bytes.readFloatLE(this.skip(4)); }
  f64() { return this.bytes.readDoubleLE(this.skip(8)); }

  id() {
    const id = this.u32();
    return id === 0xffffffff ? -1 : id;
  }

  propertyValue(property) {
    if (property === 0x38 || property === 0x39 || property === 0x46) return this.id();
    const offset = this.skip(4);
    const bits = this.bytes.readUInt32LE(offset);
    return bits <= 0x10000000 ? bits : this.bytes.readFloatLE(offset);
  }

  variable() {
    let number = 0;
    for (let position = 0; position < 5; position += 1) {
      const field = this.u8();
      number = number * 128 + (field & 127);
      if (number > 0xffffffff) break;
      if (!(field & 128)) return number;
    }
    throw new Error('无效的可变长度整数');
  }

  list(count, minimumWidth, read) {
    if (count > Math.floor((this.bytes.length - this.offset) / minimumWidth)) {
      throw new Error(`数组超出记录范围，偏移 ${this.offset}，数量 ${count}`);
    }
    return Array.from({length: count}, (_, index) => read(index));
  }

  remaining() { return this.bytes.length - this.offset; }
}

function positioning(reader) {
  const flags = reader.u8();
  if ((flags & 3) !== 3) return;
  reader.u8();
  if (!(flags & 96)) return;
  reader.skip(5); // Path mode and transition duration.
  reader.skip(reader.u32() * 16); // Position and duration per vertex.
  reader.skip(reader.u32() * 20); // Vertex span and automation ranges per path.
}

function graphPoints(reader, count) {
  return reader.list(count, 12, () => ({
    From: reader.f32(), To: reader.f32(), Interp: reader.u32(),
  }));
}

function nodeParameters(reader) {
  reader.u8(); // Override parent effects.
  const effectCount = reader.u8();
  if (effectCount) reader.skip(1 + effectCount * 7);
  reader.skip(10); // Attachment override, output bus, parent and priority flags.
  const propertyIds = reader.list(reader.u8(), 5, () => reader.u8());
  const properties = propertyIds.map((pID) => ({pID, pValue: reader.propertyValue(pID)}));
  reader.skip(reader.u8() * 9); // Ranged properties.
  positioning(reader);
  if (reader.u8() & 8) reader.skip(16); // Four auxiliary bus IDs.
  reader.skip(6); // Virtual voice and instance limits.

  reader.list(reader.variable(), 3, () => {
    reader.variable(); // RTPC property ID.
    reader.skip(2); // Accumulation mode and decibel flag.
  });
  const stateGroups = reader.list(reader.variable(), 6, () => {
    const ulStateGroupID = reader.id();
    const eStateSyncType = reader.u8();
    const ulNumStates = reader.variable();
    const states = reader.list(ulNumStates, 8, () => ({
      ulStateID: reader.id(), ulStateInstanceID: reader.id(),
    }));
    return {ulStateGroupID, eStateSyncType, ulNumStates,
      pStates: states.length ? {AkState: collapse(states)} : {}};
  });
  const rtpc = reader.list(reader.u16(), 14, () => {
    const fields = {
      RTPCID: reader.id(), rtpcType: reader.u8(), rtpcAccum: reader.u8(),
      ParamID: reader.variable(), rtpcCurveID: reader.id(), eScaling: reader.u8(),
      ulSize: reader.u16(),
    };
    const points = graphPoints(reader, fields.ulSize);
    return {...fields, pRTPCMgr: points.length ? {AkRTPCGraphPoint: collapse(points)} : {}};
  });
  return Object.fromEntries(Object.entries({properties, stateGroups, rtpc})
    .filter(([, records]) => records.length));
}

function musicParameters(reader) {
  reader.u8(); // Music MIDI flags.
  nodeParameters(reader);
  const children = reader.list(reader.u32(), 4, () => reader.id());
  reader.skip(23); // Meter including two doubles, tempo, time signature and override.
  reader.skip(reader.u32() * 24); // Stingers.
  return children;
}

function collapse(items) {
  return items.length === 1 ? items[0] : items;
}

function fade(reader) {
  return {transitionTime: reader.i32(), eFadeCurve: reader.u32(), iFadeOffset: reader.i32()};
}

function transitionRules(reader) {
  return reader.list(reader.u32(), 54, () => {
    const uNumSrc = reader.u32();
    const sources = reader.list(uNumSrc, 4, () => reader.id());
    const uNumDst = reader.u32();
    const destinations = reader.list(uNumDst, 4, () => reader.id());
    const AkMusicTransSrcRule = {...fade(reader), eSyncType: reader.u32(),
      uCueFilterHash: reader.u32(), bPlayPostExit: reader.u8()};
    const AkMusicTransDstRule = {...fade(reader), uCueFilterHash: reader.u32(),
      uJumpToID: reader.id(), eJumpToType: reader.u16(), eEntryType: reader.u16(),
      bPlayPreEntry: reader.u8(), bDestMatchSourceCueName: reader.u8()};
    const AllocTransObjectFlag = reader.u8();
    const rule = {uNumSrc, ...(uNumSrc ? {srcID: collapse(sources)} : {}), uNumDst,
      ...(uNumDst ? {dstID: collapse(destinations)} : {}), AkMusicTransSrcRule,
      AkMusicTransDstRule, AllocTransObjectFlag};
    if (AllocTransObjectFlag) {
      rule.AkMusicTransitionObject = {segmentID: reader.id(), fadeInParams: fade(reader),
        fadeOutParams: fade(reader), bPlayPreEntry: reader.u8(), bPlayPostExit: reader.u8()};
    }
    return rule;
  });
}

function decisionTree(reader, depth, size) {
  const nodeWidth = 12;
  if (!size || size % nodeWidth || size !== reader.remaining()) {
    throw new Error(`无效决策树长度 ${size}`);
  }
  const nodes = reader.list(size / nodeWidth, nodeWidth, () => ({
    key: reader.id(), link: reader.u32(), weight: reader.u16(), probability: reader.u16(),
  }));
  if (depth >= nodes.length) throw new Error(`无效决策树深度 ${depth}`);
  const leaves = [];
  const explored = new Set();
  function visit(index, keys, chances) {
    if (explored.has(index)) throw new Error(`决策树重复引用 ${index}`);
    explored.add(index);
    const {key, link, weight, probability} = nodes[index];
    if (index) {
      keys = [...keys, key];
      chances = [...chances, probability];
    }
    if (keys.length === depth) {
      leaves.push([keys, link === 0xffffffff ? -1 : link, chances]);
      return;
    }
    const first = link & 0xffff;
    const count = link >>> 16;
    if (!count || first <= index || first + count > nodes.length) {
      throw new Error(`决策树子节点超出范围 ${index} (${first}, ${count}, ${weight})`);
    }
    for (let child = first; child < first + count; child += 1) visit(child, keys, chances);
  }
  visit(0, [], []);
  if (explored.size !== nodes.length) throw new Error('决策树含未引用的节点');
  return leaves;
}

function musicSwitch(reader) {
  musicParameters(reader);
  const transitions = transitionRules(reader);
  const continuePlayback = reader.u8();
  const depth = reader.u32();
  const groups = reader.list(depth, 5, () => reader.id());
  const groupTypes = reader.list(depth, 1, () => reader.u8());
  const size = reader.u32();
  const mode = reader.u8();
  const leaves = decisionTree(reader, depth, size);
  return {kind: 'switch', groups, groupTypes, mode, leaves, continuePlayback, transitions};
}

function musicPlaylist(reader) {
  musicParameters(reader);
  const transitions = transitionRules(reader);
  const count = reader.u32();
  const itemWidth = 30;
  if (!count || count * itemWidth !== reader.remaining()) {
    throw new Error(`曲单条数与字节数不符 ${count}`);
  }
  let visited = 0;
  function readItem() {
    if (visited >= count) throw new Error('曲单子项超出曲单长度');
    visited += 1;
    const SegmentID = reader.id();
    reader.u32(); // Playlist item ID.
    const childCount = reader.u32();
    const item = {SegmentID, eRSType: reader.i32(), Loop: reader.i16(),
      LoopMin: reader.i16(), LoopMax: reader.i16(), Weight: reader.u32(),
      wAvoidRepeatCount: reader.u16(), bIsUsingWeight: reader.u8(), bIsShuffle: reader.u8()};
    if (childCount) item.children = reader.list(childCount, itemWidth, readItem);
    return item;
  }
  const items = [readItem()];
  if (visited !== count) throw new Error('曲单含未引用的条目');
  return {kind: 'playlist', items, transitions};
}

function musicSegment(reader) {
  const trackIds = musicParameters(reader);
  const duration = reader.f64();
  const markers = reader.list(reader.u32(), 16, () => {
    const id = reader.id();
    const position = reader.f64();
    const length = reader.u32();
    const start = reader.skip(length);
    return {id, position, name: reader.bytes.toString('utf8', start, start + length)};
  });
  return {kind: 'segment', trackIds, duration, markers};
}

function musicTrack(reader) {
  reader.u8(); // Music MIDI flags.
  const media = reader.list(reader.u32(), 14, () => {
    const plugin = reader.u32();
    const streamType = reader.u8();
    const id = reader.id();
    const memoryBytes = reader.u32();
    const sourceFlags = reader.u8();
    if ((plugin & 15) === 2) reader.skip(reader.u32());
    return {plugin, streamType, id, memoryBytes, sourceFlags};
  });
  const clips = reader.list(reader.u32(), 44, () => ({
    trackID: reader.u32(), sourceID: reader.id(), eventID: reader.id(), fPlayAt: reader.f64(),
    fBeginTrimOffset: reader.f64(), fEndTrimOffset: reader.f64(), fSrcDuration: reader.f64(),
  }));
  const subTrackCount = clips.length ? reader.u32() : 0;
  const clipAutomation = reader.list(reader.u32(), 12, () => {
    const uClipIndex = reader.u32();
    const eAutoType = reader.u32();
    const uNumPoints = reader.u32();
    const points = graphPoints(reader, uNumPoints);
    return {uClipIndex, eAutoType, uNumPoints,
      pArrayGraphPoints: points.length ? {AkRTPCGraphPoint: collapse(points)} : {}};
  });
  const parameters = nodeParameters(reader);
  if (clipAutomation.length) parameters.clipAutomation = clipAutomation;
  const type = reader.u8();
  if (type === 3) {
    const eGroupType = reader.u8();
    const uGroupID = reader.id();
    const uDefaultSwitch = reader.id();
    const numSwitchAssoc = reader.u32();
    const associations = reader.list(numSwitchAssoc, 4, () => ({ulSwitchAssoc: reader.id()}));
    parameters.switchParams = [{eGroupType, uGroupID, uDefaultSwitch, numSwitchAssoc,
      arSwitchAssoc: associations.length ? {TrackSwitchAssoc: collapse(associations)} : {}}];
    parameters.switchTransitions = [{srcFadeParams: fade(reader), eSyncType: reader.u32(),
      uCueFilterHash: reader.u32(), destFadeParams: fade(reader)}];
  }
  const lookAhead = reader.i32();
  return {kind: 'track', type, clips, parameters, media, subTrackCount, lookAhead};
}

const parsers = new Map([
  [musicTypes.segment, musicSegment], [musicTypes.track, musicTrack],
  [musicTypes.switch, musicSwitch], [musicTypes.playlist, musicPlaylist],
]);

// Bank 134 record layouts were checked against wwiser's wparser, then the local client banks.
export function readMusicRecord({id, type, payload}, bankVersion) {
  const decode = parsers.get(type);
  if (!decode) return null;
  if (bankVersion !== supportedBankVersion) throw new Error(`未支持 Wwise Bank ${bankVersion}`);
  const reader = new Reader(payload);
  reader.u32(); // HIRC object ID.
  try {
    const result = decode(reader);
    if (reader.remaining()) throw new Error(`记录还有 ${reader.remaining()} 字节`);
    return result;
  } catch (error) {
    throw new Error(`HIRC 音乐记录 ${id} (类型 ${type}): ${error.message}`, {cause: error});
  }
}
