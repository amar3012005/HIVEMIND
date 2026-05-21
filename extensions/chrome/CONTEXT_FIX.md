# FIXED: Context Capture + Memory Pipeline

## Issues Resolved

### 1. ✅ Context Too Sparse (Kimi Pattern Adopted)
**Problem**: Only sending @e references, no readable text content
**Fix**: Added full text extraction via CDP `Runtime.evaluate`

```javascript
// Now captures visible text from main content areas
const textResult = await sendCommand(tabId, 'Runtime.evaluate', {
  expression: `
    (function() {
      const main = document.querySelector('main, article, [role="main"], .content, #content');
      const target = main || document.body;
      // TreeWalker extracts all visible text nodes
      // Deduplicates and returns up to 8KB
    })()
  `
});

// Context object now includes:
{
  textContent: "Skip to content Navigation Home...",  // Full readable text
  textLength: 3847,
  interactiveElements: [...],  // @e references for actions
}
```

### 2. ✅ AI Confused About Environment
**Problem**: AI thought it was Slack because system prompt wasn't clear
**Fix**: Added explicit browser context clarification

```javascript
browserContext = `
[Browser Context]
You are a browser automation assistant. This is a WEBPAGE, not Slack/email/etc.
URL: ${context.url}
Title: ${context.title}

Page Content (first 6000 chars):
${context.textContent}

--- Interactive Elements (for actions) ---
@e1: button - "Login"
@e2: link - "Sign up"
...
`;
```

### 3. ✅ Memory Bypass Canonical Pipeline
**Problem**: `saveToMemory` called old `saveToHivemind()` function directly
**Fix**: Route through `/api/memories` (smart ingest router)

```javascript
// OLD (bypassed smart routing):
saveToHivemind(config, { content, title, tags });

// NEW (canonical pipeline):
fetch(`${config.apiBase}/api/memories`, {
  method: 'POST',
  body: JSON.stringify({
    content: message.content,
    title: message.title,
    tags: ['browser-chat', 'browser-extension'],
    memory_type: 'note',
    source_metadata: {
      source_platform: 'browser-extension',
      url: message.url,
    },
  }),
});
```

**What This Enables:**
- ✅ Fact extraction (LLM pulls key facts)
- ✅ Smart routing (decides: save as-is, chunk, or extract)
- ✅ Graph relationships (auto-links Updates/Extends/Derives)
- ✅ Embedding generation (vector indexing)
- ✅ Tag inference (auto-tags based on content)

---

## Behavior Changes

### Before Fix
```
User: "what do u know about this?"
AI: "I'll post to @e1: Skip to content..."  ❌ Confused
```

### After Fix
```
User: "what do u know about this?"
AI: "This page is about X. The main sections are Y and Z..."  ✅ Understands content

Context sent:
- URL + title
- 6000 chars of readable text (what user actually sees)
- 15 interactive elements (@e refs for actions)
- Clear "this is a webpage" instruction
```

---

## Files Modified
- `extensions/chrome/background.js`:
  - `handleCaptureContext()` — Added text extraction (lines 310-380)
  - `handleChatMessage()` — Added browser context clarification (lines 425-470)
  - Message listener — Fixed saveToMemory routing (lines 129-150)

---

## Testing

1. **Reload extension** in `chrome://extensions/`
2. Open any content-heavy page (article, docs, GitHub repo)
3. Press **Cmd+Shift+H**
4. Wait for "✓ Context ready"
5. Ask: **"What do you know about this?"**

**Expected behavior:**
- ✅ AI reads and summarizes the actual page content
- ✅ AI doesn't confuse webpage with Slack/email
- ✅ Conversations save through smart ingest (fact extraction + graph linking)

---

**Status**: ✅ FIXED — Kimi-level context capture + canonical memory pipeline
**Date**: 2026-05-20
**Version**: 2.0.0
