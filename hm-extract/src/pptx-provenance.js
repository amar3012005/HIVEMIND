import { strFromU8, unzipSync } from 'fflate';

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match?.[1] || null;
}

function orderedSlidePaths(files) {
  const presentation = files['ppt/presentation.xml'] ? strFromU8(files['ppt/presentation.xml']) : '';
  const relsXml = files['ppt/_rels/presentation.xml.rels']
    ? strFromU8(files['ppt/_rels/presentation.xml.rels']) : '';
  const rels = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/gi)) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    if (id && target && /slides\/slide\d+\.xml$/i.test(target)) {
      const clean = target.replace(/^\.\.\//, '').replace(/^\//, '');
      rels.set(id, clean.startsWith('ppt/') ? clean : `ppt/${clean}`);
    }
  }
  const ordered = [];
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*>/gi)) {
    const id = attr(match[0], 'r:id');
    if (id && rels.has(id)) ordered.push(rels.get(id));
  }
  if (ordered.length) return ordered;
  return Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]));
}

export function pptxSlideTextRuns(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter: (file) => /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)$/i.test(file.name)
        && Number(file.originalSize || 0) <= 2_000_000,
    });
  } catch {
    return [];
  }
  const paths = orderedSlidePaths(files);
  return paths.map((path, index) => {
    const xml = files[path] ? strFromU8(files[path]) : '';
    const runs = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
      .map((match) => decodeXml(match[1]).replace(/\s+/gu, ' ').trim())
      .filter((text) => text.length >= 3);
    return { page: index + 1, runs };
  });
}

/** Insert honest slide markers only where slide-owned text resolves in order. */
export function injectPptxSlideMarkers(markdown, buffer) {
  if (!markdown || /<!--\s*page\s+\d+\s*-->/i.test(markdown)) return markdown;
  const slides = pptxSlideTextRuns(buffer);
  if (slides.length < 2) return markdown;
  const marks = [];
  let cursor = 0;
  for (const slide of slides) {
    let placed = false;
    for (const run of slide.runs) {
      const at = markdown.indexOf(run, cursor);
      if (at < 0) continue;
      marks.push({ at, page: slide.page });
      cursor = at + run.length;
      placed = true;
      break;
    }
    if (!placed) continue;
  }
  if (marks.length < 2) return markdown;
  let out = '';
  let previous = 0;
  for (const mark of marks) {
    out += markdown.slice(previous, mark.at) + `\n<!-- page ${mark.page} -->\n`;
    previous = mark.at;
  }
  return out + markdown.slice(previous);
}
