/**
 * AI Chat Platform Schemas
 *
 * Defines platform-specific selectors and prompts for auto-capturing
 * AI chat sessions from Claude, ChatGPT, Gemini, etc.
 *
 * STRUCTURED INGESTION PROMPT
 *   Same template across all 4 platforms — asks the host LLM to emit a
 *   markdown document HIVEMIND can parse deterministically. No JSON (some
 *   platforms refuse; markdown survives ChatGPT's safety formatting).
 *
 *   parseStructuredSummary(text) → { title, summary, memories[], open_questions[] }
 */

function buildStructuredIngestPrompt(platformName) {
  const today = new Date().toISOString().slice(0, 10);
  const platformTag = (platformName || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `You are helping HIVEMIND (a persistent memory engine) ingest this conversation.

Today: ${today}. Source platform: ${platformName}.

Output ONLY a markdown document with this EXACT structure — no preamble,
no explanation, no apology, no acknowledgement. Start directly with "## TITLE".

## TITLE
<3-8 words, searchable, captures the gist of the conversation>

## SUMMARY
<2-3 sentence narrative of what was discussed>

## MEMORIES
For each durable claim the user revealed (fact, decision, preference,
goal, deadline, person, project, opinion, identity), output one block.
Skip chitchat, greetings, transient state, generic public facts.

### {memory_type}: {short title (3-8 words)}
- content: <one atomic claim in present tense; ONE fact per memory — split compound claims>
- tags: <comma-separated, MINIMUM 2 tags from: topic (ai/design/marketing/…), type (preference/decision/fact/…), person:<name>, project:<name>, time (q4-2026/this-week), source:from-${platformTag}>
- memory_type: fact | preference | decision | goal | event | lesson | relationship | note

## OPEN_QUESTIONS
<bullet list — anything the user wanted to follow up on, or unresolved>

## END

NEVER include:
- Passwords, API keys, .env contents, full credit card numbers
- Chitchat ("hi", "thanks", "ok")
- Information already covered by a previous memory in this list
- Speculation — only what was actually said

Tag every memory with at least one topic + one type. Always include
source:from-${platformTag}. Output the document now:`;
}

/**
 * Parse the structured ingest markdown emitted by the host LLM.
 * Returns { title, summary, memories[], open_questions[] }.
 */
function parseStructuredSummary(rawMarkdown) {
  const result = { title: '', summary: '', memories: [], open_questions: [] };
  if (!rawMarkdown || typeof rawMarkdown !== 'string') return result;

  // Host LLMs (esp. Claude) often strip the `##` markdown prefix and emit
  // bare section labels like "TITLE" / "SUMMARY" / "MEMORIES". Accept both
  // forms by building a regex that treats `##` as optional and the section
  // boundary as either "##|###" OR an UPPERCASE bare-label-on-its-own-line.
  const SECTION_BOUNDARY = String.raw`(?=\n(?:#{1,3}\s*)?(?:TITLE|SUMMARY|MEMORIES|OPEN[_ ]?QUESTIONS|END)\b|$)`;

  const grab = (label) => {
    const re = new RegExp(
      String.raw`(?:^|\n)(?:#{1,3}\s*)?${label}\s*\n+([\s\S]*?)${SECTION_BOUNDARY}`,
      'i'
    );
    const m = rawMarkdown.match(re);
    return m ? m[1].trim() : '';
  };

  result.title = grab('TITLE').split('\n')[0].trim();
  result.summary = grab('SUMMARY');

  const memText = grab('MEMORIES');
  if (memText) {
    // Memories begin with "### type: title" OR bare "type: title" line.
    const chunks = memText.split(/(?=^(?:#{2,3}\s*)?(?:fact|preference|decision|goal|event|lesson|relationship|note)\s*:)/im)
      .filter((c) => /\b(content|tags|memory_type)\s*:/i.test(c));
    for (const raw of chunks) {
      const headerMatch = raw.match(/^(?:#{2,3}\s*)?([a-z]+)\s*:\s*([^\n]+)/i);
      if (!headerMatch) continue;
      const memory_type = headerMatch[1].trim().toLowerCase();
      const title = headerMatch[2].trim().replace(/[*_`]+/g, '');
      const contentMatch = raw.match(/^[-*]?\s*content:\s*([\s\S]*?)(?=\n[-*]?\s*(?:tags|memory_type)\s*:|\n#{2,3}|$)/im);
      const tagsMatch = raw.match(/^[-*]?\s*tags:\s*([^\n]+)/im);
      const typeOverride = raw.match(/^[-*]?\s*memory_type:\s*([^\n]+)/im);
      const content = (contentMatch?.[1] || '').trim().replace(/[*_`]+/g, '');
      const tags = (tagsMatch?.[1] || '')
        .split(/[,;]/)
        .map((t) => t.trim().replace(/^["'`]|["'`]$/g, ''))
        .filter((t) => t.length > 0 && t.length < 60);
      if (!content || content.length < 5) continue;
      result.memories.push({
        title: title.slice(0, 80) || `${memory_type} memory`,
        content,
        tags,
        memory_type: (typeOverride?.[1]?.trim().toLowerCase()) || memory_type || 'fact',
      });
    }
  }

  const oqText = grab('OPEN_QUESTIONS') || grab('OPEN QUESTIONS');
  if (oqText) {
    result.open_questions = oqText
      .split(/\n/)
      .map((l) => l.replace(/^[-*•]\s*/, '').trim())
      .filter((l) => l.length > 3);
  }

  return result;
}

// Expose to background service-worker scope (importScripts).
try {
  if (typeof self !== 'undefined') {
    self.buildStructuredIngestPrompt = buildStructuredIngestPrompt;
    self.parseStructuredSummary = parseStructuredSummary;
  }
} catch {}

const AI_CHAT_SCHEMAS = {
  claude: {
    urlPattern: /claude\.ai/,
    name: 'Claude',
    color: '#CC785C',
    selectors: {
      // Claude's input is a contenteditable div inside the prompt area
      input: 'div[contenteditable="true"]',
      inputFallback: 'div.ProseMirror',
      submit: 'button[aria-label="Send Message"]',
      submitFallback: 'button[aria-label="Send"]',
      messages: '[class*="font-claude-message"], [class*="font-user-message"]',
      lastMessage: '[class*="font-claude-message"]:last-of-type',
      userMessages: '[class*="font-user-message"]',
      assistantMessages: '[class*="font-claude-message"]',
      thinkingIndicator: '[data-streaming="true"], [class*="thinking"]',
    },
    summaryPrompt: 'summarize this chat briefly',
    waitForResponse: {
      timeout: 30000,
      checkInterval: 1000,
      thinkingIndicator: null,
    },
    extraction: {
      chatHistoryScript: `
        (function() {
          const messages = [];
          const isHive = (el) => !!(el && el.closest && el.closest('[id*="hivemind"],[class*="hivemind"],#__hivemind-section-overlay'));
          // Claude wraps user/assistant turns in article-like containers.
          // Primary: find all text blocks inside the chat scroll container.
          const chatContainer = document.querySelector('[class*="mx-auto"][class*="max-w"], [class*="chat"], main');
          if (!chatContainer) return [];

          // Claude uses font-user-message / font-claude-message class patterns
          const userBlocks = Array.from(chatContainer.querySelectorAll('[class*="font-user-message"]')).filter((el) => !isHive(el));
          const assistantBlocks = Array.from(chatContainer.querySelectorAll('[class*="font-claude-message"]')).filter((el) => !isHive(el));
          
          // If class-based detection fails, fallback to structure-based
          const allTextBlocks = chatContainer.querySelectorAll('.prose, [class*="message"], p');
          
          // Class-based extraction (modern Claude)
          userBlocks.forEach(el => {
            const content = (el.innerText || el.textContent || '').trim();
            if (content.length > 5) messages.push({ role: 'user', content });
          });
          assistantBlocks.forEach(el => {
            const content = (el.innerText || el.textContent || '').trim();
            if (content.length > 5) messages.push({ role: 'assistant', content });
          });
          
          // If class-based got nothing, try structure-based
          if (messages.length === 0) {
            // Claude chat structure: alternating user/assistant blocks
            let lastRole = null;
            allTextBlocks.forEach(el => {
              const content = (el.innerText || el.textContent || '').trim();
              if (content.length < 10) return;
              const parent = el.closest('[class*="user"], [class*="human"]');
              const role = parent ? 'user' : 'assistant';
              // Dedupe consecutive same-role
              if (role !== lastRole || content.length > 200) {
                messages.push({ role, content });
                lastRole = role;
              }
            });
          }
          
          return messages;
        })()
      `,
      lastMessageScript: `
        (function() {
          // Filter out anything inside HIVEMIND's own overlay so we never
          // bleed our extension UI into the captured summary.
          const isHive = (el) => !!(el && el.closest && el.closest('[id*="hivemind"],[class*="hivemind"],#__hivemind-section-overlay'));
          const blocks = Array.from(document.querySelectorAll('[class*="font-claude-message"]'))
            .filter((el) => !isHive(el));
          const last = blocks[blocks.length - 1];
          return last ? (last.innerText || last.textContent || '').trim() : null;
        })()
      `,
    },
  },

  chatgpt: {
    urlPattern: /chatgpt\.com|chat\.openai\.com/,
    name: 'ChatGPT',
    color: '#10A37F',
    selectors: {
      input: '#prompt-textarea',
      inputFallback: 'textarea[data-id="root"]',
      submit: 'button[data-testid="send-button"]',
      submitFallback: 'button[aria-label="Send prompt"]',
      messages: 'div[data-message-author-role]',
      lastMessage: 'div[data-message-author-role="assistant"]:last-of-type',
      userMessages: 'div[data-message-author-role="user"]',
      assistantMessages: 'div[data-message-author-role="assistant"]',
      thinkingIndicator: 'div.result-streaming',
    },
    summaryPrompt: `Summarize our conversation with:

- Key topics covered
- Important decisions made
- Code snippets or solutions discussed
- Open questions or next steps

Use bullet points and be comprehensive.`,
    waitForResponse: {
      timeout: 45000,
      checkInterval: 800,
      thinkingIndicator: 'div.result-streaming',
    },
    extraction: {
      chatHistoryScript: `
        const messages = [];
        document.querySelectorAll('div[data-message-author-role]').forEach(el => {
          const role = el.dataset.messageAuthorRole;
          const content = el.innerText.trim();
          if (content && role) messages.push({ role, content });
        });
        return messages;
      `,
      lastMessageScript: `
        const lastMsg = document.querySelector('div[data-message-author-role="assistant"]:last-of-type');
        return lastMsg ? lastMsg.innerText.trim() : null;
      `,
    },
  },

  gemini: {
    urlPattern: /gemini\.google\.com/,
    name: 'Gemini',
    color: '#4285F4',
    selectors: {
      input: 'rich-textarea[aria-label*="prompt"]',
      inputFallback: 'div[contenteditable="true"][aria-label*="prompt"]',
      submit: 'button[aria-label*="Send message"]',
      submitFallback: 'button mat-icon[aria-label="Send"]',
      messages: 'message-content',
      lastMessage: 'message-content[data-is-model-turn="true"]:last-of-type',
      userMessages: 'message-content[data-is-model-turn="false"]',
      assistantMessages: 'message-content[data-is-model-turn="true"]',
      thinkingIndicator: 'mat-spinner',
    },
    summaryPrompt: `Please summarize our conversation covering:

1. Main topics discussed
2. Key insights or conclusions
3. Code examples (if applicable)
4. Recommended next steps

Format clearly with bullet points.`,
    waitForResponse: {
      timeout: 45000,
      checkInterval: 800,
      thinkingIndicator: 'mat-spinner',
    },
    extraction: {
      chatHistoryScript: `
        const messages = [];
        document.querySelectorAll('message-content').forEach(el => {
          const role = el.dataset.isModelTurn === 'true' ? 'assistant' : 'user';
          const content = el.innerText.trim();
          if (content) messages.push({ role, content });
        });
        return messages;
      `,
      lastMessageScript: `
        const lastMsg = document.querySelector('message-content[data-is-model-turn="true"]:last-of-type');
        return lastMsg ? lastMsg.innerText.trim() : null;
      `,
    },
  },

  perplexity: {
    urlPattern: /perplexity\.ai/,
    name: 'Perplexity',
    color: '#1C1C1C',
    selectors: {
      input: 'textarea[placeholder*="Ask"]',
      inputFallback: 'textarea',
      submit: 'button[aria-label="Submit"]',
      submitFallback: 'button svg[data-icon="arrow-up"]',
      messages: 'div[class*="MessageContainer"]',
      lastMessage: 'div[class*="MessageContainer"]:last-of-type',
      userMessages: 'div[class*="UserMessage"]',
      assistantMessages: 'div[class*="AssistantMessage"]',
      thinkingIndicator: 'div[class*="LoadingDots"]',
    },
    summaryPrompt: `Summarize our conversation:

- Topics explored
- Key findings
- Sources cited
- Follow-up questions

Be concise and use bullet points.`,
    waitForResponse: {
      timeout: 45000,
      checkInterval: 800,
      thinkingIndicator: 'div[class*="LoadingDots"]',
    },
    extraction: {
      chatHistoryScript: `
        const messages = [];
        document.querySelectorAll('div[class*="MessageContainer"]').forEach(el => {
          const isUser = el.querySelector('div[class*="UserMessage"]');
          const role = isUser ? 'user' : 'assistant';
          const content = el.innerText.trim();
          if (content) messages.push({ role, content });
        });
        return messages;
      `,
      lastMessageScript: `
        const lastMsg = document.querySelector('div[class*="MessageContainer"]:last-of-type');
        return lastMsg ? lastMsg.innerText.trim() : null;
      `,
    },
  },
};

/**
 * Detect AI chat platform from URL
 */
function detectAIChatPlatform(url) {
  if (!url) return null;
  
  for (const [key, schema] of Object.entries(AI_CHAT_SCHEMAS)) {
    if (schema.urlPattern.test(url)) {
      return { id: key, ...schema };
    }
  }
  
  return null;
}

/**
 * Get summary prompt for platform
 */
function getSummaryPrompt(platformId) {
  return AI_CHAT_SCHEMAS[platformId]?.summaryPrompt || null;
}

/**
 * Check if URL is an AI chat platform
 */
function isAIChatPlatform(url) {
  return detectAIChatPlatform(url) !== null;
}
