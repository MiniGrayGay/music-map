// Pure fit math shared by the main thread (fallback) and the fit worker.
// No DOM/GL access: input is a Float32Array of xyz triples plus footprint rings.
export function fitPoints(source, rings) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.length; i++) {
    const axis = i % 3;
    if (!Number.isFinite(source[i])) throw new Error('分区点阵含有无效坐标');
    low[axis] = Math.min(low[axis], source[i]);
    high[axis] = Math.max(high[axis], source[i]);
  }
  for (const ring of rings) for (const [x, z] of ring) {
    low[0] = Math.min(low[0], x);
    high[0] = Math.max(high[0], x);
    low[2] = Math.min(low[2], z);
    high[2] = Math.max(high[2], z);
  }
  const spans = high.map((value, axis) => value - low[axis]);
  const span = Math.max(1, ...spans);
  const center = low.map((value, axis) => (value + high[axis]) / 2);
  const positions = Float32Array.from(source, (value, i) => (value - center[i % 3]) / span);
  const outline = footprintData(rings, center, span, low[1]);
  let radius = 0;
  let halfHeight = 0;
  for (const vertices of [positions, outline]) {
    for (let i = 0; i < vertices.length; i += 3) {
      const extent = Math.hypot(vertices[i], vertices[i + 2]);
      radius = Math.max(radius, extent);
      halfHeight = Math.max(halfHeight, Math.abs(vertices[i + 1] * .88) + extent * .47);
    }
  }
  // Across the full turn, each point stays within these vertical bounds.
  // Use quantiles so a few extreme peaks or deep outliers cannot displace the subject.
  const lower = new Float32Array(positions.length / 3);
  const upper = new Float32Array(lower.length);
  const elevations = new Float32Array(lower.length);
  let xx = 0, xz = 0, zz = 0;
  for (let i = 0; i < lower.length; i++) {
    const j = i * 3;
    const x = positions[j], z = positions[j + 2];
    const sway = .47 * Math.hypot(x, z);
    const elevation = .88 * positions[j + 1];
    xx += x * x;
    xz += x * z;
    zz += z * z;
    lower[i] = elevation - sway;
    upper[i] = elevation + sway;
    elevations[i] = positions[j + 1];
  }
  lower.sort();
  upper.sort();
  elevations.sort();
  const trim = Math.floor(lower.length * .025);
  const bottom = lower[trim];
  const top = upper[upper.length - 1 - trim];
  // Color ramp domain from robust quantiles: a few extreme peaks or shaft
  // outliers must not flatten the gradient of the ordinary terrain mass.
  const colorTrim = Math.floor(elevations.length * .02);
  const colorLow = elevations[colorTrim];
  const colorHigh = elevations[elevations.length - 1 - colorTrim];
  const anisotropy = Math.hypot(xx - zz, 2 * xz);
  const angle = anisotropy > .35 * (xx + zz) ? .18 - .5 * Math.atan2(2 * xz, xx - zz) : .48;
  return {positions, outline, span, fit: {radius, halfHeight, height: spans[1] / span,
    angle, verticalCenter: (bottom + top) / 2, verticalSpan: top - bottom,
    colorLow, colorHigh: Math.max(colorHigh, colorLow + 1e-6)}};
}

function footprintData(rings, center, span, floor) {
  const lines = [];
  const y = (floor - center[1]) / span;
  const vertex = ([x, z]) => [(x - center[0]) / span, y, (z - center[2]) / span];
  for (const ring of rings) {
    if (!ring.length) continue;
    let from = vertex(ring.at(-1));
    for (const corner of ring) {
      const to = vertex(corner);
      lines.push(...from, ...to);
      from = to;
    }
  }
  return new Float32Array(lines);
}
