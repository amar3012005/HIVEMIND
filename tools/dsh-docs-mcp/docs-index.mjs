import { execFile } from 'node:child_process';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STOP_WORDS = new Set(['about', 'after', 'also', 'and', 'are', 'does', 'for', 'from', 'have', 'how', 'into', 'its', 'the', 'their', 'this', 'what', 'when', 'where', 'which', 'with']);

function tokens(value) {
  return [...new Set(String(value).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])]
    .filter((word) => !STOP_WORDS.has(word));
}

async function markdownPaths(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await markdownPaths(root, absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return found.sort();
}

function sections(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s+\S/.test(lines[i])) starts.push(i);
  }
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  return starts.map((start, index) => ({
    heading: lines[start].replace(/^#{1,4}\s+/, '').trim(),
    start,
    end: index + 1 < starts.length ? starts[index + 1] : lines.length,
  }));
}

/** Load the current local Markdown checkout for one MCP request. */
export async function loadDocs(root) {
  const docsRoot = await realpath(root);
  const paths = await markdownPaths(docsRoot);
  const pages = await Promise.all(paths.map(async (relativePath) => {
    const content = await readFile(path.join(docsRoot, relativePath), 'utf8');
    const lines = content.split(/\r?\n/);
    const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim()
      || relativePath.replace(/\.md$/, '');
    return { path: relativePath, title, lines, sections: sections(lines) };
  }));
  return { root: docsRoot, pages };
}

/** Search headings and exact source lines; return bounded snippets with line numbers. */
export function searchDocs(pages, query, limit = 8) {
  const words = tokens(query);
  if (!words.length) return [];
  const ranked = [];
  for (const page of pages) {
    let best = null;
    for (const section of page.sections) {
      const headingText = `${page.path} ${page.title} ${section.heading}`.toLowerCase();
      let score = words.reduce((sum, word) => sum + (headingText.includes(word) ? 8 : 0), 0);
      let firstHit = -1;
      for (let i = section.start; i < section.end; i++) {
        const line = page.lines[i].toLowerCase();
        for (const word of words) {
          if (!line.includes(word)) continue;
          score += 1;
          if (firstHit < 0) firstHit = i;
        }
      }
      if (!score || (best && best.score >= score)) continue;
      const hit = firstHit < 0 ? section.start : firstHit;
      const snippetStart = Math.max(section.start, hit - 1);
      const snippetEnd = Math.min(section.end, snippetStart + 5);
      best = {
        path: page.path,
        title: page.title,
        heading: section.heading,
        start_line: snippetStart + 1,
        end_line: snippetEnd,
        excerpt: page.lines.slice(snippetStart, snippetEnd).join('\n').slice(0, 1400),
        score,
      };
    }
    if (best) ranked.push(best);
  }
  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.min(Math.max(limit, 1), 20)).map(({ score, ...result }) => result);
}

/** Read only Markdown within the configured documentation root. */
export function readDocs(pages, requestedPath, startLine = 1, lineCount = 80) {
  if (typeof requestedPath !== 'string' || !requestedPath.endsWith('.md') || requestedPath.startsWith('/')
      || requestedPath.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error('Invalid documentation path. Use a path returned by docs_search or docs_catalog.');
  }
  const page = pages.find((item) => item.path === requestedPath);
  if (!page) throw new Error('Documentation page not found. Use docs_search or docs_catalog.');
  const first = Math.max(1, Math.floor(startLine));
  const count = Math.min(160, Math.max(1, Math.floor(lineCount)));
  const last = Math.min(page.lines.length, first + count - 1);
  return {
    path: page.path,
    title: page.title,
    total_lines: page.lines.length,
    start_line: first,
    end_line: last,
    text: page.lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join('\n'),
  };
}

export function catalogDocs(pages, prefix = '', limit = 80, cursor = '') {
  if (prefix.includes('..') || prefix.startsWith('/')) throw new Error('Invalid prefix.');
  const selected = pages.filter((page) => page.path.startsWith(prefix) && page.path > cursor);
  const max = Math.min(Math.max(limit, 1), 100);
  const entries = selected.slice(0, max).map(({ path: filePath, title }) => ({ path: filePath, title }));
  return { entries, next_cursor: selected.length > max ? entries.at(-1).path : null, total: pages.length };
}

export async function docsRevision(root) {
  const repository = path.dirname(root);
  try {
    const [{ stdout: revision }, { stdout: branch }, { stdout: changes }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository }),
      execFileAsync('git', ['branch', '--show-current'], { cwd: repository }),
      execFileAsync('git', ['status', '--porcelain', '--', 'docs'], { cwd: repository }),
    ]);
    return { revision: revision.trim(), branch: branch.trim(), docs_modified: Boolean(changes.trim()) };
  } catch {
    return { revision: null, branch: null, docs_modified: null };
  }
}
