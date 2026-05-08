const MEMORY_TYPE_MAP = {
  pdf: 'fact',
  email: 'event',
  html: 'fact',
  json: 'fact',
  yaml: 'fact',
  csv: 'fact',
  markdown: 'fact',
  code: 'decision',
  conversation: 'lesson',
  url: 'fact',
  text: 'fact',
};

export const CHUNK_STRATEGY_MAP = {
  pdf: 'page_sections',
  email: 'thread_grouped',
  html: 'article_structure',
  json: 'key_sections',
  yaml: 'key_sections',
  csv: 'row_batches',
  markdown: 'heading_hierarchy',
  code: 'ast_boundaries',
  conversation: 'turn_pairs',
  url: 'single',
  text: 'paragraph_split',
};

const ROUTER_MAP = {
  pdf: 'knowledge_base',
  email: 'gmail',
  html: 'knowledge_base',
  json: 'knowledge_base',
  yaml: 'knowledge_base',
  csv: 'knowledge_base',
  markdown: 'knowledge_base',
  code: 'github',
  conversation: 'claude',
  url: 'knowledge_base',
  text: 'manual',
};

function detectPdf(content) {
  if (content.startsWith('%PDF') || content.startsWith('JVBERi0')) {
    return { confidence: 0.99, signals: ['magic_bytes'] };
  }
  return null;
}

function detectEmail(content) {
  const first500 = content.slice(0, 500);
  const signals = [];
  if (/^From:\s*.+/m.test(first500)) signals.push('from_header');
  if (/^Subject:\s*.+/m.test(first500)) signals.push('subject_header');
  if (/^Date:\s*.+/m.test(first500)) signals.push('date_header');
  if (/^To:\s*.+/m.test(first500)) signals.push('to_header');
  if (/^Content-Type:\s*.+/m.test(first500)) signals.push('content_type_header');

  if (signals.length >= 2 && signals.includes('from_header')) {
    return { confidence: 0.90 + signals.length * 0.02, signals };
  }
  return null;
}

function detectHtml(content) {
  const trimmed = content.trimStart().slice(0, 200).toLowerCase();
  const signals = [];
  if (trimmed.startsWith('<!doctype html')) signals.push('doctype');
  if (/<html[\s>]/i.test(trimmed)) signals.push('html_tag');
  if (/<head[\s>]/i.test(trimmed)) signals.push('head_tag');
  if (/<body[\s>]/i.test(trimmed)) signals.push('body_tag');

  const tagCount = (content.match(/<\/?[a-z][a-z0-9]*[\s>]/gi) || []).length;
  if (tagCount > 10) signals.push('high_tag_density');

  if (signals.length >= 2) {
    return { confidence: 0.90 + signals.length * 0.02, signals };
  }
  return null;
}

function detectJson(content) {
  const trimmed = content.trimStart();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  try {
    JSON.parse(trimmed);
    return { confidence: 0.95, signals: ['valid_json_parse'] };
  } catch {
    return null;
  }
}

function detectYaml(content) {
  const lines = content.split('\n').slice(0, 20);
  const signals = [];
  if (lines[0]?.trim() === '---') signals.push('frontmatter_delimiter');

  let kvCount = 0;
  for (const line of lines) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*:\s+/.test(line)) kvCount++;
  }
  if (kvCount >= 3) signals.push('key_value_pairs');
  if (/^\s+-\s+/m.test(content.slice(0, 500))) signals.push('yaml_list');

  if (signals.length >= 2 || (signals.includes('frontmatter_delimiter') && kvCount >= 2)) {
    return { confidence: 0.85, signals };
  }
  return null;
}

function detectCsv(content) {
  const lines = content.split('\n').filter(l => l.trim()).slice(0, 10);
  if (lines.length < 3) return null;

  const signals = [];

  for (const delimiter of [',', '\t', ';', '|']) {
    const counts = lines.map(l => (l.match(new RegExp(delimiter === '|' ? '\\|' : delimiter, 'g')) || []).length);
    const nonZero = counts.filter(c => c > 0);
    if (nonZero.length >= 3) {
      const first = nonZero[0];
      const consistent = nonZero.every(c => c === first);
      if (consistent && first >= 1) {
        signals.push(`consistent_${delimiter === '\t' ? 'tab' : delimiter}_delimiter`);
        signals.push(`${first + 1}_columns`);
        break;
      }
    }
  }

  if (signals.length >= 2) {
    return { confidence: 0.80, signals };
  }
  return null;
}

function detectMarkdown(content) {
  const first2k = content.slice(0, 2000);
  const signals = [];

  if (/^#{1,6}\s+.+/m.test(first2k)) signals.push('heading');
  if (/\*\*.+?\*\*/m.test(first2k)) signals.push('bold');
  if (/\[.+?\]\(.+?\)/m.test(first2k)) signals.push('link');
  if (/^[-*+]\s+/m.test(first2k)) signals.push('unordered_list');
  if (/^\d+\.\s+/m.test(first2k)) signals.push('ordered_list');
  if (/^```/m.test(first2k)) signals.push('code_fence');
  if (/^>\s+/m.test(first2k)) signals.push('blockquote');
  if (/^\|.+\|/m.test(first2k)) signals.push('table');

  if (signals.length >= 2) {
    return { confidence: 0.70 + signals.length * 0.03, signals };
  }
  return null;
}

function detectCode(content) {
  const first2k = content.slice(0, 2000);
  const signals = [];

  if (/^import\s+.+from\s+['"]/m.test(first2k)) signals.push('es_import');
  if (/^const\s+\{?\s*\w+.*=\s*require\(/m.test(first2k)) signals.push('commonjs_require');
  if (/^from\s+\w+\s+import\s+/m.test(first2k)) signals.push('python_import');
  if (/^import\s+"[^"]+"/m.test(first2k)) signals.push('go_import');
  if (/^(export\s+)?(function|class|const|let|var)\s+\w+/m.test(first2k)) signals.push('js_declaration');
  if (/^def\s+\w+\s*\(/m.test(first2k)) signals.push('python_def');
  if (/^class\s+\w+[:(]/m.test(first2k)) signals.push('class_declaration');
  if (/^(pub\s+)?fn\s+\w+/m.test(first2k)) signals.push('rust_fn');
  if (/^func\s+\w+/m.test(first2k)) signals.push('go_func');
  if (/^package\s+\w+/m.test(first2k)) signals.push('package_declaration');

  const syntaxMarkers = (first2k.match(/[{};()=>]/g) || []).length;
  if (syntaxMarkers > 20) signals.push('high_syntax_density');

  if (signals.length >= 2) {
    return { confidence: 0.75 + signals.length * 0.03, signals };
  }
  return null;
}

function detectConversation(content) {
  const first2k = content.slice(0, 2000);
  const signals = [];

  const userTurns = (first2k.match(/^(User|Human|You|Me):\s*/gim) || []).length;
  const assistantTurns = (first2k.match(/^(Assistant|AI|Claude|Bot|GPT|System):\s*/gim) || []).length;

  if (userTurns >= 2) signals.push('user_turns');
  if (assistantTurns >= 1) signals.push('assistant_turns');
  if (userTurns >= 1 && assistantTurns >= 1) signals.push('turn_pattern');

  if (signals.includes('turn_pattern')) {
    return { confidence: 0.85, signals };
  }
  return null;
}

function detectUrl(content) {
  const trimmed = content.trim();
  if (trimmed.length > 2000) return null;
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { confidence: 0.90, signals: ['url_pattern'] };
  }
  return null;
}

const DETECTORS = [
  { type: 'pdf', detect: detectPdf },
  { type: 'email', detect: detectEmail },
  { type: 'html', detect: detectHtml },
  { type: 'json', detect: detectJson },
  { type: 'yaml', detect: detectYaml },
  { type: 'csv', detect: detectCsv },
  { type: 'markdown', detect: detectMarkdown },
  { type: 'code', detect: detectCode },
  { type: 'conversation', detect: detectConversation },
  { type: 'url', detect: detectUrl },
];

export function detectContentType(content) {
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return {
      detectedType: 'text',
      confidence: 0,
      signals: ['empty_content'],
      suggestedMemoryType: 'fact',
      suggestedChunkStrategy: 'paragraph_split',
      suggestedRoute: 'manual',
    };
  }

  let best = null;

  for (const { type, detect } of DETECTORS) {
    const result = detect(content);
    if (result && (!best || result.confidence > best.confidence)) {
      best = { type, ...result };
    }
  }

  const detectedType = best?.type || 'text';

  return {
    detectedType,
    confidence: best?.confidence || 0.50,
    signals: best?.signals || ['no_match_fallback'],
    suggestedMemoryType: MEMORY_TYPE_MAP[detectedType],
    suggestedChunkStrategy: CHUNK_STRATEGY_MAP[detectedType],
    suggestedRoute: ROUTER_MAP[detectedType],
  };
}
