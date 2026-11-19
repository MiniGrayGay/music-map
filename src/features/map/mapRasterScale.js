const mobilePixelBudget = 1_800_000;
const mobileScaleLimit = 2.5;

export function mapRasterScale(width, height, baseline, mobile) {
  const deviceScale = window.devicePixelRatio || 1;
  if (!mobile) return Math.min(deviceScale, baseline);

  // Give high-DPI phones more detail while bounding the extra work per frame.
  const availableScale = Math.sqrt(mobilePixelBudget / (width * height));
  const limit = Math.max(baseline, Math.min(mobileScaleLimit, availableScale));
  return Math.min(deviceScale, limit);
}
