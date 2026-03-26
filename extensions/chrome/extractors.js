/**
 * HIVEMIND Chrome Extension — Platform-Specific Content Extractors
 *
 * Auto-detects the current platform by URL and extracts structured content
 * using platform-specific DOM selectors. Falls back to generic extraction.
 *
 * Supported platforms:
 * - ChatGPT (chatgpt.com, chat.openai.com)
 * - Claude (claude.ai)
 * - Gemini (gemini.google.com)
 * - Perplexity (perplexity.ai)
 * - Generic webpage (fallback)
 */

// ── Platform Detection ──────────────────────────────────

function detectPlatform() {
  const host = window.location.hostname;
  const path = window.location.pathname;

  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('gemini.google.com')) return 'gemini';
  if (host.includes('perplexity.ai')) return 'perplexity';
  if (host.includes('github.com')) return 'github';
  if (host.includes('stackoverflow.com') || host.includes('stackexchange.com')) return 'stackoverflow';
  if (host.includes('notion.so') || host.includes('notion.site')) return 'notion';
  if (host.includes('docs.google.com')) return 'gdocs';
  if (host.includes('medium.com') || document.querySelector('article[data-post-id]')) return 'article';

  return 'generic';
}

// ── ChatGPT Extractor ───────────────────────────────────

function extractChatGPT() {
  const title = document.querySelector('nav [class*="active"]')?.textContent?.trim()
    || document.querySelector('h1')?.textContent?.trim()
    || document.title.replace(' | ChatGPT', '').trim()
    || 'ChatGPT Conversation';

  const messages = [];
  document.querySelectorAll('[data-message-author-role]').forEach(el => {
    const role = el.getAttribute('data-message-author-role');
    const content = el.innerText?.trim();
    if (content && content.length > 2) {
      messages.push({ role: role === 'user' ? 'User' : 'Assistant', content });
    }
  });

  if (messages.length === 0) return null;

  const formatted = messages.map(m => `**${m.role}:** ${m.content}`).join('\n\n---\n\n');

  return {
    platform: 'chatgpt',
    type: 'conversation',
    title: `ChatGPT: ${title}`,
    content: `# ${title}\n\nPlatform: ChatGPT\nMessages: ${messages.length}\nURL: ${window.location.href}\n\n${formatted}`.slice(0, 8000),
    messageCount: messages.length,
    tags: ['chatgpt', 'ai-conversation', `chat:${title.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}`],
  };
}

// ── Claude Extractor ────────────────────────────────────

function extractClaude() {
  const title = document.querySelector('[class*="ConversationTitle"], h1, [data-testid="conversation-title"]')?.textContent?.trim()
    || document.title.replace(' - Claude', '').trim()
    || 'Claude Conversation';

  const messages = [];
  // Claude uses different class patterns — try multiple selectors
  const containers = document.querySelectorAll('[class*="Message"], [class*="message-"], [data-testid*="message"]');
  containers.forEach(el => {
    const isHuman = el.classList.toString().includes('human') || el.classList.toString().includes('user')
      || el.closest('[data-testid*="human"]') || el.getAttribute('data-is-human') === 'true';
    const content = el.innerText?.trim();
    if (content && content.length > 2) {
      messages.push({ role: isHuman ? 'User' : 'Claude', content });
    }
  });

  if (messages.length === 0) {
    // Fallback: try getting all prose blocks
    document.querySelectorAll('.prose, .font-claude-message').forEach(el => {
      const content = el.innerText?.trim();
      if (content && content.length > 5) messages.push({ role: 'Claude', content });
    });
  }

  if (messages.length === 0) return null;

  const formatted = messages.map(m => `**${m.role}:** ${m.content}`).join('\n\n---\n\n');

  return {
    platform: 'claude',
    type: 'conversation',
    title: `Claude: ${title}`,
    content: `# ${title}\n\nPlatform: Claude\nMessages: ${messages.length}\nURL: ${window.location.href}\n\n${formatted}`.slice(0, 8000),
    messageCount: messages.length,
    tags: ['claude', 'ai-conversation', `chat:${title.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}`],
  };
}

// ── Gemini Extractor ────────────────────────────────────

function extractGemini() {
  const title = document.querySelector('[class*="conversation-title"], h1')?.textContent?.trim()
    || document.title.replace(' - Google Gemini', '').replace(' - Gemini', '').trim()
    || 'Gemini Conversation';

  const messages = [];
  document.querySelectorAll('[class*="query-text"], [class*="response-text"], [class*="message-content"]').forEach(el => {
    const isUser = el.classList.toString().includes('query') || el.closest('[class*="query"]');
    const content = el.innerText?.trim();
    if (content && content.length > 2) {
      messages.push({ role: isUser ? 'User' : 'Gemini', content });
    }
  });

  // Fallback: try model-response / user-query pattern
  if (messages.length === 0) {
    document.querySelectorAll('model-response, user-query, [class*="turn"]').forEach(el => {
      const isUser = el.tagName === 'USER-QUERY' || el.classList.toString().includes('user');
      const content = el.innerText?.trim();
      if (content && content.length > 5) {
        messages.push({ role: isUser ? 'User' : 'Gemini', content });
      }
    });
  }

  if (messages.length === 0) return null;

  const formatted = messages.map(m => `**${m.role}:** ${m.content}`).join('\n\n---\n\n');

  return {
    platform: 'gemini',
    type: 'conversation',
    title: `Gemini: ${title}`,
    content: `# ${title}\n\nPlatform: Google Gemini\nMessages: ${messages.length}\nURL: ${window.location.href}\n\n${formatted}`.slice(0, 8000),
    messageCount: messages.length,
    tags: ['gemini', 'ai-conversation', `chat:${title.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}`],
  };
}

// ── Perplexity Extractor ────────────────────────────────

function extractPerplexity() {
  const title = document.querySelector('h1, [class*="ThreadTitle"]')?.textContent?.trim()
    || document.title.replace(' - Perplexity', '').trim()
    || 'Perplexity Search';

  const messages = [];
  document.querySelectorAll('[class*="AnswerText"], [class*="QueryText"], [class*="prose"]').forEach(el => {
    const isQuery = el.classList.toString().includes('Query');
    const content = el.innerText?.trim();
    if (content && content.length > 5) {
      messages.push({ role: isQuery ? 'User' : 'Perplexity', content });
    }
  });

  // Extract sources/citations if present
  const sources = [];
  document.querySelectorAll('[class*="Citation"], [class*="source"] a').forEach(el => {
    const href = el.href || el.closest('a')?.href;
    const text = el.textContent?.trim();
    if (href && text) sources.push(`[${text}](${href})`);
  });

  const formatted = messages.map(m => `**${m.role}:** ${m.content}`).join('\n\n---\n\n');
  const sourcesBlock = sources.length > 0 ? `\n\n## Sources\n${sources.join('\n')}` : '';

  return {
    platform: 'perplexity',
    type: 'search',
    title: `Perplexity: ${title}`,
    content: `# ${title}\n\nPlatform: Perplexity\nURL: ${window.location.href}\n\n${formatted}${sourcesBlock}`.slice(0, 8000),
    messageCount: messages.length,
    tags: ['perplexity', 'ai-search', `search:${title.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}`],
  };
}

// ── GitHub Extractor ────────────────────────────────────

function extractGitHub() {
  const path = window.location.pathname;
  const isIssue = path.includes('/issues/');
  const isPR = path.includes('/pull/');
  const isRepo = !isIssue && !isPR;

  const title = document.querySelector('.js-issue-title, .gh-header-title, h1')?.textContent?.trim()
    || document.title.replace(' · GitHub', '').trim();

  let content = '';
  if (isIssue || isPR) {
    const body = document.querySelector('.comment-body, .markdown-body')?.innerText?.trim() || '';
    const labels = [...document.querySelectorAll('.IssueLabel, .label')].map(l => l.textContent.trim());
    const type = isIssue ? 'Issue' : 'Pull Request';
    content = `# ${type}: ${title}\n\nURL: ${window.location.href}\nLabels: ${labels.join(', ') || 'none'}\n\n${body}`;
  } else {
    const readme = document.querySelector('#readme .markdown-body')?.innerText?.trim() || '';
    const desc = document.querySelector('[itemprop="about"]')?.textContent?.trim() || '';
    content = `# Repository: ${title}\n\nURL: ${window.location.href}\nDescription: ${desc}\n\n${readme}`;
  }

  return {
    platform: 'github',
    type: isIssue ? 'issue' : isPR ? 'pull-request' : 'repository',
    title: `GitHub: ${title}`,
    content: content.slice(0, 8000),
    tags: ['github', isIssue ? 'issue' : isPR ? 'pull-request' : 'repo'],
  };
}

// ── Article Extractor (Medium, blogs) ───────────────────

function extractArticle() {
  const title = document.querySelector('h1, article h1, .post-title')?.textContent?.trim()
    || document.title;
  const author = document.querySelector('[rel="author"], .author-name, [class*="author"]')?.textContent?.trim() || '';
  const article = document.querySelector('article, main, .post-content, .entry-content');
  const body = article ? article.innerText.replace(/\n{3,}/g, '\n\n').trim() : document.body.innerText.slice(0, 5000);

  return {
    platform: 'article',
    type: 'article',
    title: title,
    content: `# ${title}\n\n${author ? `Author: ${author}\n` : ''}URL: ${window.location.href}\n\n${body}`.slice(0, 8000),
    tags: ['article', 'reading', `source:${window.location.hostname}`],
  };
}

// ── Generic Webpage Extractor (fallback) ────────────────

function extractGeneric() {
  const article = document.querySelector('article, main, [role="main"], .content, .post-content');
  const target = article || document.body;

  const clone = target.cloneNode(true);
  clone.querySelectorAll('script, style, nav, header, footer, aside, .sidebar, .ad, .advertisement, iframe, noscript, [aria-hidden="true"]').forEach(el => el.remove());

  const text = clone.innerText
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t+/g, ' ')
    .trim();

  const meta = document.querySelector('meta[name="description"]')?.content || '';

  return {
    platform: 'web',
    type: 'webpage',
    title: document.title,
    content: `# ${document.title}\n\nURL: ${window.location.href}\n${meta ? `Description: ${meta}\n` : ''}\n${text}`.slice(0, 8000),
    tags: ['webpage', `domain:${window.location.hostname}`],
  };
}

// ── Main: Smart Extract ─────────────────────────────────

function smartExtract() {
  const platform = detectPlatform();

  const extractors = {
    chatgpt: extractChatGPT,
    claude: extractClaude,
    gemini: extractGemini,
    perplexity: extractPerplexity,
    github: extractGitHub,
    article: extractArticle,
    stackoverflow: extractArticle, // similar structure
    notion: extractGeneric, // complex DOM, fallback to generic
    gdocs: extractGeneric,
    generic: extractGeneric,
  };

  const extractor = extractors[platform] || extractGeneric;

  try {
    const result = extractor();
    if (result && result.content && result.content.length > 20) {
      return result;
    }
  } catch (e) {
    console.warn('[HIVEMIND] Platform extractor failed, using generic:', e.message);
  }

  // Fallback to generic
  return extractGeneric();
}
