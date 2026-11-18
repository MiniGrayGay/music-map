export const playIconPath = 'M6.45 10.3 C6.45 8.548 6.45 6.358 7.904 5.519 C9.358 4.679 11.255 5.774 12.772 6.65 L15.716 8.35 C17.234 9.226 19.13 10.321 19.13 12 C19.13 13.679 17.234 14.774 15.716 15.65 L12.772 17.35 C11.255 18.226 9.358 19.321 7.904 18.482 C6.45 17.642 6.45 15.452 6.45 13.7Z';

const point = (x, y) => [x, y];
const mix = (a, b, t) => a + (b - a) * t;
const blend = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
const clamp = (value) => Math.min(1, Math.max(0, value));
const ease = (t) => t * t * (3 - 2 * t);
const xy = ([x, y]) => x.toFixed(3) + ' ' + y.toFixed(3);
const flatCorner = (x, y) => Array.from({length: 7}, () => point(x, y));

// Each corner contains the start, then the control points and ends of two cubics.
function continuousCorner(before, vertex, after, trim) {
  const start = blend(vertex, before, trim / Math.hypot(before[0] - vertex[0], before[1] - vertex[1]));
  const end = blend(vertex, after, trim / Math.hypot(after[0] - vertex[0], after[1] - vertex[1]));
  const nearStart = blend(start, vertex, .56);
  const nearEnd = blend(end, vertex, .56);
  return [
    start, blend(start, vertex, .24), nearStart, blend(nearStart, nearEnd, .5),
    nearEnd, blend(end, vertex, .24), end,
  ];
}

function roundBar(left, right) {
  const corners = [point(left, 4.65), point(right, 4.65), point(right, 19.35), point(left, 19.35)];
  const trim = (right - left) * .49;
  return corners.map((vertex, index) =>
    continuousCorner(corners[(index + 3) % 4], vertex, corners[(index + 1) % 4], trim));
}

function splitCubic(start, a, b, end) {
  const ab = blend(a, b, .5);
  const left = blend(start, a, .5);
  const right = blend(b, end, .5);
  const nearLeft = blend(left, ab, .5);
  const nearRight = blend(ab, right, .5);
  return [start, left, nearLeft, blend(nearLeft, nearRight, .5), nearRight, right, end];
}

// Only the outside of the triangle is animated until the body has rounded out.
const playShell = [
  [point(6.45, 10.3), point(6.45, 8.548), point(6.45, 6.358), point(7.904, 5.519),
    point(9.358, 4.679), point(11.255, 5.774), point(12.772, 6.65)],
  splitCubic(point(15.716, 8.35), point(17.234, 9.226), point(19.13, 10.321), point(19.13, 12)),
  splitCubic(point(19.13, 12), point(19.13, 13.679), point(17.234, 14.774), point(15.716, 15.65)),
  [point(12.772, 17.35), point(11.255, 18.226), point(9.358, 19.321), point(7.904, 18.482),
    point(6.45, 17.642), point(6.45, 15.452), point(6.45, 13.7)],
];

function ellipseArc(from, to, x = 12, rx = 6.45, ry = 6.18) {
  const tangent = 4 / 3 * Math.tan((to - from) / 4);
  const at = (angle) => point(x + rx * Math.cos(angle), 12 + ry * Math.sin(angle));
  const start = at(from);
  const end = at(to);
  return [
    start,
    point(start[0] - tangent * rx * Math.sin(from), start[1] + tangent * ry * Math.cos(from)),
    point(end[0] + tangent * rx * Math.sin(to), end[1] - tangent * ry * Math.cos(to)),
    end,
  ];
}

const quarterAngles = [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI];
function ellipse(x, rx, ry) {
  return quarterAngles.slice(0, -1).map((angle, i) =>
    splitCubic(...ellipseArc(angle, quarterAngles[i + 1], x, rx, ry)));
}

const roundedShell = ellipse(12, 6.45, 6.18);
const topSeam = flatCorner(...roundedShell[0][6]);
const bottomSeam = flatCorner(...roundedShell[2][6]);
const roundedLeft = [roundedShell[0], topSeam, bottomSeam, roundedShell[3]];
const roundedRight = [topSeam, roundedShell[1], roundedShell[2], bottomSeam];
const liquidLeft = ellipse(8.15, 3, 6.45);
const liquidRight = ellipse(15.85, 3, 6.45);
const pauseLeft = roundBar(5.775, 10.475);
const pauseRight = roundBar(13.525, 18.225);

const playCurves = playShell.flatMap((corner, i) => {
  const end = corner[6];
  const next = playShell[(i + 1) % playShell.length][0];
  const curves = [corner.slice(0, 4), corner.slice(3)];
  if (Math.hypot(end[0] - next[0], end[1] - next[1]) > .001) {
    curves.push([end, blend(end, next, 1 / 3), blend(end, next, 2 / 3), next]);
  }
  return curves;
});

// Give the three former straight edges finite arcs in the rounded silhouette.
// Collapsing those edges to points would concentrate curvature at their joins.
const roundAngles = [-164, -132, -100, -63, -29, 0, 29, 63, 100, 132, 164, 196]
  .map((degrees) => degrees * Math.PI / 180);
const roundCurves = roundAngles.slice(0, -1).map((angle, i) => ellipseArc(angle, roundAngles[i + 1]));
const offset = (from, to) => point(to[0] - from[0], to[1] - from[1]);
const unit = (vector) => {
  const length = Math.hypot(...vector);
  return point(vector[0] / length, vector[1] / length);
};

function contourTangents(segments) {
  return segments.map(([start, control], i) => {
    const previous = segments[(i + segments.length - 1) % segments.length];
    return unit(blend(unit(offset(previous[2], previous[3])), unit(offset(start, control)), .5));
  });
}

const playTangents = contourTangents(playCurves);
const roundTangents = contourTangents(roundCurves);

function roundingOutline(progress, ripple) {
  const tangents = playTangents.map((direction, i) => unit(blend(direction, roundTangents[i], progress)));
  let path = 'M' + xy(ripple.move(blend(playCurves[0][0], roundCurves[0][0], progress)));
  playCurves.forEach(([a, b, c, d], i) => {
    const rounded = roundCurves[i];
    const start = blend(a, rounded[0], progress);
    const end = blend(d, rounded[3], progress);
    const startLength = mix(Math.hypot(...offset(a, b)), Math.hypot(...offset(rounded[0], rounded[1])), progress);
    const endLength = mix(Math.hypot(...offset(c, d)), Math.hypot(...offset(rounded[2], rounded[3])), progress);
    const first = start.map((coordinate, axis) => coordinate + tangents[i][axis] * startLength);
    const lastTangent = tangents[(i + 1) % tangents.length];
    const second = end.map((coordinate, axis) => coordinate - lastTangent[axis] * endLength);
    const [p0, l1, l2, middle, r1, r2, p3] = splitCubic(start, first, second, end);
    path += ripple.cubic(p0, l1, l2, middle) + ripple.cubic(middle, r1, r2, p3);
  });
  return path + 'Z';
}

function surfaceRipple(progress, amount) {
  const center = mix(5.1, 18.9, progress);
  const spread = 2.85;
  const strength = amount * .60 * Math.exp(.5) * Math.sin(Math.PI * progress) ** 2;

  function wave(y) {
    const relative = (y - center) / spread;
    const falloff = strength * Math.exp(-.5 * relative * relative);
    return [relative * falloff, (1 - relative * relative) * falloff / spread];
  }

  function move([x, y]) {
    return point(x + wave(y)[0], y);
  }

  function cubic(start, first, second, end) {
    // Transform the endpoint tangents as well as their positions to keep the rim smooth.
    const tangent = (anchor, control) => {
      const [offset, slope] = wave(anchor[1]);
      return point(control[0] + offset + slope * (control[1] - anchor[1]), control[1]);
    };
    return 'C' + [tangent(start, first), tangent(end, second), move(end)].map(xy).join(' ');
  }

  return {move, cubic};
}

function roundedJoin(previous, next, curve) {
  const start = previous[6];
  const end = next[0];
  const chord = point(end[0] - start[0], end[1] - start[1]);
  const length = Math.hypot(...chord);
  if (length < .0001) return '';

  function extend(anchor, handle, fallback, distance) {
    const offset = point(anchor[0] - handle[0], anchor[1] - handle[1]);
    const tangent = Math.hypot(...offset) > .0001 ? offset : fallback;
    const scale = distance / Math.hypot(...tangent);
    return point(anchor[0] + tangent[0] * scale, anchor[1] + tangent[1] * scale);
  }

  // Keep both end handles on the adjacent corner tangents. The short join
  // grows with the cap so it cannot introduce a straight ledge as the cap unfolds.
  const backwards = point(-chord[0], -chord[1]);
  const first = extend(start, previous[5], chord, length * .17);
  const nearStart = extend(start, previous[5], chord, length * .34);
  const nearEnd = extend(end, next[1], backwards, length * .34);
  const last = extend(end, next[1], backwards, length * .17);
  const middle = blend(nearStart, nearEnd, .5);
  return curve(start, first, nearStart, middle) + curve(middle, nearEnd, last, end);
}

function contourPen(ripple) {
  const vertex = (p) => xy(ripple ? ripple.move(p) : p);
  function curve(start, a, b, end) {
    if (!ripple) return 'C' + [a, b, end].map(xy).join(' ');
    const [first, l1, l2, middle, r1, r2, last] = splitCubic(start, a, b, end);
    return ripple.cubic(first, l1, l2, middle) + ripple.cubic(middle, r1, r2, last);
  }
  function corner([start, a, b, middle, c, d, end]) {
    return curve(start, a, b, middle) + curve(middle, c, d, end);
  }
  return {vertex, curve, corner};
}

function outline(corners, ripple = null) {
  const pen = contourPen(ripple);
  const first = corners[0][0];
  let contour = 'M' + pen.vertex(first);
  corners.forEach((corner, index) => {
    if (index) contour += ripple
      ? roundedJoin(corners[index - 1], corner, pen.curve)
      : 'L' + pen.vertex(corner[0]);
    contour += pen.corner(corner);
  });
  if (ripple) contour += roundedJoin(corners[3], corners[0], pen.curve);
  return contour + 'Z';
}
export const pauseIconPath = outline(pauseLeft) + outline(pauseRight);

function morph(from, to, progress) {
  return from.map((corner, i) => corner.map((source, j) => blend(source, to[i][j], progress)));
}

function roundNotch(left, right, depth, direction, ripple) {
  if (depth < .001) return '';
  const surface = left[0][1];
  const halfWidth = (right[6][0] - left[6][0]) / 2;
  const capHeight = Math.abs(left[6][1] - surface);
  // The notch starts shallow and wide. Even while the two openings meet,
  // each one ends in a half ellipse rather than the intersection of two rims.
  const radius = Math.min(depth * .52, halfWidth * .88);
  const travel = Math.min(1, (depth - radius) / Math.max(.001, capHeight));
  const stretch = (corner) => corner.map(([x, y]) => point(x, mix(surface, y, travel)));
  const a = stretch(left);
  const b = stretch(right);
  const base = surface + direction * (depth - radius);
  const tip = surface + direction * depth;
  const start = point(a[6][0], base);
  const end = point(b[6][0], base);
  const middle = point((start[0] + end[0]) / 2, tip);
  const k = 4 / 3 * Math.tan(Math.PI / 8);
  const {vertex, corner, curve} = contourPen(ripple);
  const outside = surface - direction * 3;
  return 'M' + vertex(point(a[0][0], outside)) + 'L' + vertex(a[0]) + corner(a)
    + 'L' + vertex(start)
    + curve(start, point(start[0], base + direction * radius * k),
      point(middle[0] - halfWidth * k, tip), middle)
    + curve(middle, point(middle[0] + halfWidth * k, tip),
      point(end[0], base + direction * radius * k), end)
    + 'L' + vertex(b[6]) + corner(b.slice().reverse())
    + 'L' + vertex(point(b[0][0], outside)) + 'Z';
}

export function playbackIconFrame(position) {
  const roundedAt = .32;
  const ripple = surfaceRipple(ease(position), ease(clamp((position - .22) / .33)));
  if (position <= roundedAt) {
    return {path: roundingOutline(ease(clamp(position / roundedAt)), ripple)};
  }

  const progress = ease(clamp((position - roundedAt) / (1 - roundedAt)));
  const maxDepth = .72;
  // Keep a broad liquid bridge through the middle of the turn. The two
  // rounded notches only reach one another near the end.
  const opening = ease(progress) ** 2.05;
  const separation = .5 / maxDepth;
  const shoulders = ease(clamp((opening - separation) / (1 - separation)));
  const left = morph(morph(roundedLeft, liquidLeft, progress), pauseLeft, shoulders);
  const right = morph(morph(roundedRight, liquidRight, progress), pauseRight, shoulders);
  const height = left[2][6][1] - left[1][0][1];
  const depth = maxDepth * height * opening;
  return {
    path: outline([left[0], right[1], right[2], left[3]], ripple),
    upperNotch: roundNotch(left[1], right[0].slice().reverse(), depth, 1, ripple),
    lowerNotch: roundNotch(left[2].slice().reverse(), right[3], depth, -1, ripple),
    softness: .25 * Math.max(0, 1 - Math.abs(depth / height - .5) / .12),
  };
}
