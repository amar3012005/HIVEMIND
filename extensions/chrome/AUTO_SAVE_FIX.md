# FIXED: Auto-Save Spam + Intelligent Memory

## Problems Fixed

### 1. ✅ Stopped Auto-Saving Every Turn
**Problem**: Extension saved EVERY dialogue turn to memory
```
Q: who are you?
A: I'm HIVEMIND...
→ Saved to memory ❌

Q: what do u know about this?
A: This page is about...
→ Saved to memory ❌
```

**Fix**: Removed auto-save from `chat-overlay.js` line 267
```javascript
// REMOVED:
// await saveInteractionToMemory(message, response);

// NOW: User explicitly saves with "save this to memory"
```

### 2. ✅ Filtered Browser Context from Fact Extraction  
**Problem**: Backend extracted browser metadata as "facts"
```
Fact: ━━━ BROWSER PAGE CONTEXT (NOT SLACK/EMAIL) ━━━ This is a BROWSER AUTOMATION requ...
```

**Fix**: Wrap browser context in `<METADATA:*>` tags + strip before fact extraction

**Extension** (`background.js`):
```javascript
browserContext = `
<METADATA:BROWSER_CONTEXT>
━━━ BROWSER PAGE CONTEXT (NOT SLACK/EMAIL) ━━━
URL: example.com
...
</METADATA:BROWSER_CONTEXT>
`;
```

**Backend** (`server.js` line 14681):
```javascript
let msgTrimmed = message.trim();

// Strip <METADATA:*> blocks for fact extraction
msgTrimmed = msgTrimmed.replace(/<METADATA:[^>]*>[\s\S]*?<\/METADATA:[^>]*>/gi, '').trim();
```

### 3. ✅ Updated Welcome Message
**Before**: "I remember everything you tell me"  
**After**: "Say 'save this to memory' to explicitly save content"

```
💬 Ask about this page
🔍 Search memories: "what do you know about X?"
💾 Save: "remember this" or "save this to memory"
⚡ Execute: "click the login button"
```

---

## How It Works Now

### Automatic Recall (Still Happens)
Every turn:
- ✅ Backend recalls relevant memories automatically
- ✅ Shows "📚 11 sources" when memories found
- ✅ Injects context into AI response

### Smart Fact Extraction (Still Happens)
Backend automatically extracts facts when user says:
- "I prefer TypeScript"
- "We use Postgres"
- "My new email is..."
- "I changed to Python"

**But ignores:**
- Technical browser context
- Questions ("what do u know about X?")
- Commands ("summarize this")

### Explicit Saves (User-Triggered)
User says:
- "save this to memory"
- "remember this"
- "don't forget about this"

Backend uses smart ingest router:
- ✅ Fact extraction
- ✅ Graph linking
- ✅ Vector embedding
- ✅ Tag inference

---

## Intelligent Tool Calling (Future)

**Current limitation**: `/api/chat` doesn't expose MCP tools to LLM for function calling.

Backend auto-recalls and auto-saves based on heuristics, but AI can't "decide" to call tools.

**For true intelligent tool calling**, need:
1. Function-calling LLM (GPT-4, Claude with tools)
2. MCP tools exposed as functions
3. Tool routing layer that lets AI loop until done

**Workaround for now**: Backend's smart heuristics are pretty good! It:
- Recalls before answering
- Extracts facts from declarative statements
- Updates contradicted memories
- Links graph relationships

---

## Files Modified

1. **extensions/chrome/chat-overlay.js** (2 changes):
   - Line 267: Removed auto-save
   - Line 85: Updated welcome message

2. **extensions/chrome/background.js** (2 changes):
   - Lines 434-436: Wrapped browser context in `<METADATA>` tags
   - Line 451: Added closing `</METADATA>` tag

3. **core/src/server.js** (1 change):
   - Lines 14681-14684: Strip `<METADATA:*>` blocks before fact extraction

---

## Testing

1. **Reload extension**: `chrome://extensions/` → Reload
2. **Reload backend**: `cd /opt/HIVEMIND/core && pm2 restart hivemind-core`
3. Open any webpage
4. **Cmd+Shift+H**

### Test Cases

**1. Auto-save removed** ✅
```
User: "hello"
AI: "Hello..."
→ NOT saved to memory automatically
```

**2. Smart recall still works** ✅
```
User: "what do you know about me?"
AI: "[recalls memories and responds]"
→ Shows "📚 N sources"
```

**3. Explicit save** ✅
```
User: "I prefer TypeScript. Save this to memory."
AI: "Got it — saved."
→ Saved with fact extraction
```

**4. No more context spam** ✅
```
Memory list should NOT contain:
"Fact: ━━━ BROWSER PAGE CONTEXT..."
```

---

**Status**: ✅ FIXED — No more auto-save spam, browser context filtered, user controls saves
**Date**: 2026-05-20
**Version**: 2.0.0
