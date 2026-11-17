// Work in map pixels, so a bend keeps its shape while zooming.
const maxTrim = 44;
const cornerTrimFraction = 0.48;
const cellSize = 64;
const vertexTolerance = 0.0125;
const pointKey = ([x, y]) => `${x} ${y}`;

function displayVertices() {
  const cells = new Map();
  return ([x, y]) => {
    const column = Math.floor(x / vertexTolerance);
    const row = Math.floor(y / vertexTolerance);
    // Search adjacent cells as well. Two coordinates on opposite sides of a
    // grid line can still be observations of the same clipped vertex.
    for (let j = row - 1; j <= row + 1; j += 1) {
      for (let i = column - 1; i <= column + 1; i += 1) {
        const match = cells.get(`${i},${j}`)?.find(([ax, ay]) =>
          Math.hypot(x - ax, y - ay) <= vertexTolerance);
        if (match) return match;
      }
    }
    const key = `${column},${row}`;
    if (!cells.has(key)) cells.set(key, []);
    const point = [x, y];
    cells.get(key).push(point);
    return point;
  };
}

function displayContour(points, closed, snap) {
  const clean = [];
  for (const point of points) {
    const vertex = snap(point);
    if (vertex === clean.at(-1)) continue;
    if (vertex === clean.at(-2)) clean.pop();
    else clean.push(vertex);
  }
  if (closed) {
    if (clean[0] === clean.at(-1)) clean.pop();
    while (clean.length >= 3 && clean[1] === clean.at(-1)) {
      clean.shift();
      clean.pop();
    }
    if (clean.length < 3) return [];
  }
  return clean;
}

function eachCell(minX, minY, maxX, maxY, visit) {
  for (let y = Math.floor(minY / cellSize); y <= Math.floor(maxY / cellSize); y += 1) {
    for (let x = Math.floor(minX / cellSize); x <= Math.floor(maxX / cellSize); x += 1) {
      visit(`${x},${y}`);
    }
  }
}

function prepareDisplayRegions(regions) {
  const snap = displayVertices();
  const contours = regions.map(({id1, rings, lines}) => ({id1,
    rings: rings.map((ring) => displayContour(ring, true, snap)),
    lines: lines?.map((line) => displayContour(line, false, snap))}));
  const cells = new Map();
  const points = new Set();
  for (const {rings, lines} of contours) {
    for (const contour of [...rings, ...(lines ?? [])]) {
      for (const point of contour) points.add(point);
    }
  }
  for (const point of points) {
    const [x, y] = point;
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(point);
  }
  // Neighboring polygons can split the same straight edge at different
  // vertices. Insert those vertices into both outlines before drawing a curve.
  function split(points, closed) {
    const result = [];
    for (const [index, start] of points.entries()) {
      result.push(start);
      const end = points[index + 1] ?? (closed ? points[0] : null);
      if (!end || start === end) continue;
      const [ax, ay] = start;
      const [bx, by] = end;
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      const tolerance = vertexTolerance;
      const internal = [];
      eachCell(Math.min(ax, bx) - tolerance, Math.min(ay, by) - tolerance,
        Math.max(ax, bx) + tolerance, Math.max(ay, by) + tolerance, (key) => {
          for (const point of cells.get(key) ?? []) {
            if (point === start || point === end) continue;
            const x = point[0] - ax;
            const y = point[1] - ay;
            const along = (dx * x + dy * y) / length;
            if (along <= tolerance || along >= length - tolerance) continue;
            if (Math.abs(dx * y - dy * x) <= length * tolerance) internal.push({point, along});
          }
        });
      internal.sort((a, b) => a.along - b.along);
      for (const {point} of internal) result.push(point);
    }
    return result;
  }
  return contours.map(({id1, rings, lines}) => ({id1,
    rings: rings.map((ring) => split(ring, true)), lines: lines?.map((line) => split(line, false))}));
}

function distanceToEdge([x, y], {start: {point: [ax, ay]}, end: {point: [bx, by]}}) {
  const dx = bx - ax;
  const dy = by - ay;
  const ratio = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - ratio * dx, y - ay - ratio * dy);
}

function roundCorners(vertices, edges) {
  const cells = new Map();
  for (const edge of edges) {
    const [ax, ay] = edge.start.point;
    const [bx, by] = edge.end.point;
    eachCell(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (key) => {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(edge);
    });
  }

  const corners = new Map();
  for (const vertex of vertices) {
    const spokes = vertex.edges.map((edge) => {
      const to = edge.start === vertex ? edge.end : edge.start;
      const dx = to.point[0] - vertex.point[0];
      const dy = to.point[1] - vertex.point[1];
      const length = Math.hypot(dx, dy);
      return {edge, to, length, direction: [dx / length, dy / length]};
    });
    const pair = throughPair(spokes);
    if (!pair) continue;
    const [a, b] = pair;
    if (Math.abs(Math.sin(turn(a.direction, b.direction))) < 1e-6) continue;
    const [x, y] = vertex.point;
    let trim = Math.min(maxTrim, a.length * cornerTrimFraction, b.length * cornerTrimFraction);
    eachCell(x - trim, y - trim, x + trim, y + trim, (key) => {
      for (const edge of cells.get(key) ?? []) {
        if (edge.start === vertex || edge.end === vertex) continue;
        // The entire Bézier lies inside this radius. Leave room for a nearby
        // corner on a different edge to round without crossing the boundary.
        trim = Math.min(trim, distanceToEdge(vertex.point, edge) * 0.45);
      }
    });
    if (trim < 0.001) continue;
    const offset = ([dx, dy], distance) => pointKey([x + dx * distance, y + dy * distance]);
    const cuts = new Map(pair.map(({to, direction}) => [to.key, offset(direction, trim)]));
    if (spokes.length === 2) {
      corners.set(vertex.key, {cuts, strokes: [{owners: a.edge.owners,
        path: `M${cuts.get(a.to.key)}Q${vertex.key} ${cuts.get(b.to.key)}`}]});
      continue;
    }

    // The two cubics share a tangent through the junction. The other spokes
    // still meet the original junction, so shared outlines never pull apart.
    const controls = new Map(pair.map((spoke, index) => {
      const tangent = junctionTangent(spoke.direction, pair[1 - index].direction);
      return [spoke.to.key, [offset(tangent, trim / 3), offset(spoke.direction, trim * 2 / 3)]];
    }));
    const strokes = pair.map(({to, edge}) => ({owners: edge.owners,
      path: `M${vertex.key}C${controls.get(to.key).join(' ')} ${cuts.get(to.key)}`}));
    corners.set(vertex.key, {cuts, controls, strokes});
  }
  return corners;
}

function turn([ax, ay], [bx, by]) {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

function junctionTangent([ax, ay], [bx, by]) {
  const length = Math.hypot(ax - bx, ay - by);
  return [(ax - bx) / length, (ay - by) / length];
}

function throughPair(spokes) {
  if (spokes.length < 2) return null;
  if (spokes.length === 2) {
    const [a, b] = spokes;
    const owners = a.edge.owners;
    return owners.size === b.edge.owners.size && [...owners].every((owner) => b.edge.owners.has(owner))
      ? spokes : null;
  }
  let best = null;
  let span = Math.PI / 2;
  for (const [index, a] of spokes.entries()) {
    for (const b of spokes.slice(index + 1)) {
      const angle = Math.abs(turn(a.direction, b.direction));
      if (angle <= span || !a.edge.owners.size || !b.edge.owners.size) continue;
      const safe = [[a, b], [b, a]].every(([from, to]) => {
        const bend = turn(from.direction, junctionTangent(from.direction, to.direction));
        return spokes.every((other) => {
          if (other === from || other === to) return true;
          const direction = turn(from.direction, other.direction);
          return direction < Math.min(0, bend) || direction > Math.max(0, bend);
        });
      });
      if (safe) {
        best = [a, b];
        span = angle;
      }
    }
  }
  return best;
}

export function buildRegionLinework(regions, smooth) {
  const vertices = new Map();
  const edges = new Map();
  function vertexFor(point) {
    const key = pointKey(point);
    if (!vertices.has(key)) vertices.set(key, {key, point, edges: []});
    return vertices.get(key);
  }
  function connect(points, closed, owner) {
    for (let i = 0; i < points.length - (closed ? 0 : 1); i += 1) {
      const a = vertexFor(points[i]);
      const b = vertexFor(points[(i + 1) % points.length]);
      if (a === b) continue;
      const [start, end] = a.key < b.key ? [a, b] : [b, a];
      const key = `${start.key}/${end.key}`;
      if (!edges.has(key)) {
        const edge = {start, end, owners: new Set()};
        edges.set(key, edge);
        start.edges.push(edge);
        end.edges.push(edge);
      }
      if (owner !== null) edges.get(key).owners.add(owner);
    }
  }
  const ringsByRegion = new Map();
  for (const {id1, rings, lines} of smooth ? prepareDisplayRegions(regions) : regions) {
    ringsByRegion.set(id1, rings);
    for (const ring of rings) connect(ring, true, lines == null ? id1 : null);
    for (const line of lines ?? []) connect(line, false, id1);
  }

  const corners = smooth ? roundCorners(vertices.values(), edges.values()) : new Map();
  const segments = [];
  for (const {start, end, owners} of edges.values()) {
    if (!owners.size) continue;
    const a = corners.get(start.key)?.cuts.get(end.key) ?? start.key;
    const b = corners.get(end.key)?.cuts.get(start.key) ?? end.key;
    segments.push({path: `M${a}L${b}`, owners});
  }
  for (const {strokes} of corners.values()) {
    segments.push(...strokes.filter(({owners}) => owners.size));
  }

  function outline(region) {
    if (!smooth) return region.path;
    return (ringsByRegion.get(region.id1) ?? []).map((ring) => {
      const points = ring.map(pointKey);
      if (!points.length) return '';
      const path = points.map((key, i) => {
        const start = i === 0 ? 'M' : 'L';
        const corner = corners.get(key);
        const before = points.at(i - 1);
        const after = points[(i + 1) % points.length];
        const enter = corner?.cuts.get(before);
        const exit = corner?.cuts.get(after);
        if (corner?.controls) {
          const inbound = corner.controls.get(before);
          const outbound = corner.controls.get(after);
          const toJunction = inbound ? `C${inbound[1]} ${inbound[0]} ${key}` : '';
          const fromJunction = outbound ? `C${outbound.join(' ')} ${exit}` : '';
          return `${start}${enter ?? key}${toJunction}${fromJunction}`;
        }
        return enter && exit ? `${start}${enter}Q${key} ${exit}` : `${start}${key}`;
      });
      return `${path.join('')}Z`;
    }).join('');
  }
  return {segments, outline};
}
