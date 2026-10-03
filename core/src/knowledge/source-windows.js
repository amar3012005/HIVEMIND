/** Contiguous source slices: offsets remain exact despite repeated text/whitespace. */
export function sourceWindows(text, { targetSize = 700, maxSize = 1050, minSize = 200, overlapSize = 120 } = {}) {
  const source = String(text || '');
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const target = Math.max(1, Math.floor(finite(targetSize, 700)));
  const max = Math.max(target, Math.floor(finite(maxSize, 1050)));
  const overlap = Math.min(target - 1, Math.max(0, Math.floor(finite(overlapSize, 120))));
  const out = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + target);
    if (end < source.length) {
      const minimum = start + Math.min(Math.max(1, finite(minSize, 200)), target);
      const region = source.slice(minimum, end);
      const boundaries = [...region.matchAll(/\n\s*\n|\n|[.!?]["')\]]*\s+/g)];
      if (boundaries.length) {
        const last = boundaries[boundaries.length - 1];
        end = minimum + last.index + last[0].length;
      } else {
        while (end < source.length && end < start + max && !/\s/.test(source[end])) end += 1;
        // An unbroken token must remain intact even if it exceeds the requested size.
        while (end < source.length && !/\s/.test(source[end])) end += 1;
      }
    }
    const raw = source.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    if (raw.trim()) out.push({ text: raw.trim(), index: out.length, startOffset: start + leading, endOffset: end - trailing });
    if (end >= source.length) break;
    let next = Math.max(start + 1, end - overlap);
    while (next < end && next > 0 && !/\s/.test(source[next - 1])) next += 1;
    start = next;
  }
  return out;
}

export function joinSourceSegments(segments) {
  let text = '';
  const ranges = [];
  for (const segment of segments || []) {
    const content = String(segment?.content || '').trim();
    if (!content) continue;
    if (text) text += '\n\n';
    const start = text.length;
    text += content;
    ranges.push({ start, end: text.length, segment });
  }
  return { text, ranges };
}

export function windowSegments(window, ranges) {
  return ranges.filter(({ start, end }) => start < window.endOffset && end > window.startOffset).map(x => x.segment);
}
