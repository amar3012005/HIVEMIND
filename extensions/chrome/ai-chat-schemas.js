/**
 * AI Chat Platform Schemas
 * 
 * Defines platform-specific selectors and prompts for auto-capturing
 * AI chat sessions from Claude, ChatGPT, Gemini, etc.
 */

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
      messages: '[data-test-render-count], [class*="font-claude-message"], article',
      lastMessage: '[class*="assistant"] [class*="content"], .prose:last-of-type',
      userMessages: '[class*="user-message"], [class*="human"]',
      assistantMessages: '[class*="assistant-message"], [class*="claude"]',
      thinkingIndicator: '[class*="thinking"]',
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
          // Claude wraps user/assistant turns in article-like containers.
          // Primary: find all text blocks inside the chat scroll container.
          const chatContainer = document.querySelector('[class*="mx-auto"][class*="max-w"], [class*="chat"], main');
          if (!chatContainer) return [];
          
          // Claude uses font-user-message / font-claude-message class patterns
          const userBlocks = chatContainer.querySelectorAll('[class*="font-user-message"], [class*="user"]');
          const assistantBlocks = chatContainer.querySelectorAll('[class*="font-claude-message"], [class*="assistant"]');
          
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
          const blocks = document.querySelectorAll('[class*="font-claude-message"]');
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
