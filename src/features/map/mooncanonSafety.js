const stencilUrl = new URL('./globe/atlas/MoonCanonStencil.png', import.meta.url).href;

export const moonCanonChart = {width: 4352, height: 2304};
// The editor's full-size MoonCanon_1024.jpg uses the same 1:4 chart coordinate system.
export const moonCanonPatch = {
  map: 'MoonCanon', left: 3056, top: 1032, width: 288, height: 272,
  url: new URL('./mooncanon-editor-patch.webp', import.meta.url).href,
};

let loading;
let patchLoading;

export function loadMoonCanonPatch() {
  patchLoading ??= (async () => {
    const image = new Image();
    image.src = moonCanonPatch.url;
    await image.decode();
    return image;
  })().catch((error) => {
    patchLoading = undefined;
    throw error;
  });
  return patchLoading;
}

export function loadMoonCanonSafety() {
  loading ??= (async () => {
    const image = new Image();
    image.src = stencilUrl;
    await image.decode();
    const {naturalWidth: width, naturalHeight: height} = image;
    if (!width || !height || width * moonCanonChart.height !== height * moonCanonChart.width) {
      throw new Error('霜月遮罩与地图尺寸不一致');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    context.drawImage(image, 0, 0);
    return {width, height, pixels: context.getImageData(0, 0, width, height).data};
  })().catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

export function moonCanonReachable(safety, u, v) {
  if (!safety || u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  const {width, height, pixels} = safety;
  const x = Math.floor(u * width);
  const y = Math.floor(v * height);
  return pixels[(y * width + x) * 4 + 1] >= 128;
}

export function containsMapRings(rings, u, v) {
  let inside = false;
  for (const ring of rings) {
    let [px, py] = ring.at(-1);
    for (const [x, y] of ring) {
      if ((y > v) !== (py > v) && u < (px - x) * (v - y) / (py - y) + x) inside = !inside;
      px = x;
      py = y;
    }
  }
  return inside;
}

export function moonCanonZoneAnchor(safety, {pixelRings}) {
  const {width, height} = moonCanonChart;
  const rings = pixelRings.map((ring) => ring.map(([x, y]) => [x / width, y / height]));
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [u, v] of ring) {
      bounds[0] = Math.min(bounds[0], u);
      bounds[1] = Math.min(bounds[1], v);
      bounds[2] = Math.max(bounds[2], u);
      bounds[3] = Math.max(bounds[3], v);
    }
  }
  const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  return reachableAnchor(safety, center, bounds, (u, v) => containsMapRings(rings, u, v));
}

function reachableAnchor(safety, center, bounds, contains) {
  const [u, v] = center;
  if (moonCanonReachable(safety, u, v) && contains(u, v)) return center;
  const {width, height, pixels} = safety;
  const x0 = Math.max(0, Math.floor(bounds[0] * width));
  const y0 = Math.max(0, Math.floor(bounds[1] * height));
  const x1 = Math.min(width, Math.ceil(bounds[2] * width));
  const y1 = Math.min(height, Math.ceil(bounds[3] * height));
  const centerX = u * width;
  const centerY = v * height;
  for (const step of [4, 1]) {
    let best;
    let distance = Infinity;
    for (let y = y0; y < y1; y += step) {
      const dy = (y + .5 - centerY) ** 2;
      if (dy >= distance) continue;
      for (let x = x0; x < x1; x += step) {
        if (pixels[(y * width + x) * 4 + 1] < 128) continue;
        const d = dy + (x + .5 - centerX) ** 2;
        const uv = [(x + .5) / width, (y + .5) / height];
        if (d < distance && contains(...uv)) {
          best = uv;
          distance = d;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

export function drawMoonCanonOverlay(canvas, {width, height, pixels}) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  const dotPeriod = width / 190;
  for (let y = 0; y < height; y += 1) {
    const dy = ((y + .5) / dotPeriod) % 1 - .5;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const hazard = pixels[index] / 255;
      const outline = pixels[index + 2] / 255;
      if (!hazard && !outline) continue;
      const dx = ((x + .5) / dotPeriod) % 1 - .5;
      const dot = Math.max(0, Math.min(1, (.26 - Math.hypot(dx, dy)) / .09));
      const blue = hazard * (.14 + dot * .67);
      const border = outline * .64;
      const alpha = blue + border * (1 - blue);
      if (!alpha) continue;
      const mix = border / alpha;
      image.data[index] = 33 + mix * 65 + dot * 29 * (1 - mix);
      image.data[index + 1] = 113 + mix * 90 + dot * 53 * (1 - mix);
      image.data[index + 2] = 237 - mix * 43;
      image.data[index + 3] = alpha * 255;
    }
  }
  context.putImageData(image, 0, 0);
}
