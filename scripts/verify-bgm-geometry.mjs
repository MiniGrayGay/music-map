import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {
  filledRings, geometryMark, lineFromPoints, releaseGeometries,
  sameGeometry, symmetricDifference, union,
} from './bgm-geometry.mjs';

const {values: args} = parseArgs({options: {
  baseline: {type: 'string'}, candidate: {type: 'string'}, view: {type: 'string', default: 'both'},
}});
assert.ok(args.baseline && args.candidate && ['both', 'floor', 'surface'].includes(args.view),
  '需要 --baseline、--candidate 和可选的 --view floor|surface|both');
const [before, after] = await Promise.all(
  [args.baseline, args.candidate].map(async (file) => JSON.parse(await readFile(file, 'utf8'))),
);
assert.equal(before.source.clientExecutableSha256, after.source.clientExecutableSha256);

function sortedAnchors(rows) {
  return Object.fromEntries(Object.entries(rows).map(([floor, anchors]) => [
    floor, anchors.toSorted((a, b) => a.pointId - b.pointId || a.layerId - b.layerId),
  ]));
}

function compareAreas(a, b, {lines = false} = {}) {
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  let patches = 0;
  let largestDifference = 0;
  for (const [view, zones] of Object.entries(a)) {
    assert.equal(zones.length, b[view].length, view);
    const byId = new Map(b[view].map((zone) => [zone.id, zone]));
    for (const zone of zones) {
      const actual = byId.get(zone.id);
      assert.ok(actual, `${view}/${zone.id}`);
      assert.equal(actual.name, zone.name);
      assert.equal(actual.state, zone.state);
      assert.deepEqual(actual.areaIds, zone.areaIds);
      const mark = geometryMark();
      try {
        const area = symmetricDifference(filledRings(zone.rings), filledRings(actual.rings)).getArea();
        assert.ok(area < 0.02, `${view}/${zone.id} 面积差 ${area}`);
        largestDifference = Math.max(largestDifference, area);
        if (lines) {
          const boundary = (item) => union((item.lines ?? []).map(lineFromPoints));
          assert.ok(sameGeometry(boundary(zone), boundary(actual)), `${view}/${zone.id} 音区边线`);
        }
      } finally {
        releaseGeometries(mark);
      }
      patches += 1;
    }
  }
  console.log(`${Object.keys(a).length} 个视图，${patches} 块音区，最大面积差 ${largestDifference.toFixed(8)}`);
}

if (args.view !== 'floor') {
  assert.deepEqual(before.surfaceLayerExclusions, after.surfaceLayerExclusions);
  assert.deepEqual(sortedAnchors(before.floorAnchors), sortedAnchors(after.floorAnchors));
  compareAreas({3: before.zones, ...before.scenes}, {3: after.zones, ...after.scenes});
}
if (args.view !== 'surface') {
  assert.deepEqual(before.floorViewConflicts, after.floorViewConflicts);
  compareAreas(before.floorViews, after.floorViews, {lines: true});
}
