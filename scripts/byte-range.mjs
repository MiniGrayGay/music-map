export function parseByteRange(header, size) {
  const match = typeof header === 'string' && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (size === 0) return {unsatisfiable: true};
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return {unsatisfiable: true};
    return {start: Math.max(0, size - suffix), end: size - 1};
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end) return {unsatisfiable: true};
  return {start, end};
}
