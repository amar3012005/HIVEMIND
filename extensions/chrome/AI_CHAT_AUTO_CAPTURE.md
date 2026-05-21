# AI Chat Auto-Capture Feature

## Overview

The HIVEMIND Chrome extension now automatically detects AI chat platforms (Claude, ChatGPT, Gemini, Perplexity) and intelligently captures chat sessions with AI-generated summaries using CDP-based automation.

## Features

### 🎯 Auto-Detection
- Detects Claude (claude.ai)
- Detects ChatGPT (chatgpt.com, chat.openai.com)
- Detects Gemini (gemini.google.com)
- Detects Perplexity (perplexity.ai)

### 🤖 CDP-Based Automation
- Injects platform-specific summary prompts
- Auto-submits (presses Enter)
- Waits for AI response (up to 45 seconds)
- Extracts AI-generated summary + full chat history
- Saves to HIVEMIND with rich metadata

### 🔄 Intelligent Fallback
- If CDP automation fails → falls back to existing `smartExtract()`
- Ensures no data loss
- Seamless user experience

### 📍 Two Trigger Points

#### 1. Context Menu (Right-Click)
```
User on claude.ai → Right-click → "Save this page to HIVEMIND"
  ↓
Extension detects AI chat platform
  ↓
Triggers captureAIChatSession()
  ↓
Injects summary prompt → submits → waits → extracts → saves
  ↓
Badge shows: 🤖 (working) → ⏳ (waiting) → ✅ (success) / ❌ (failure)
```

#### 2. Side Panel "Save Session" Button
```
User on chatgpt.com → Opens side panel → Clicks "💾 Save Session"
  ↓
Extension detects AI chat platform
  ↓
Triggers captureAISession message → background.js
  ↓
Runs captureAIChatSession()
  ↓
Badge shows progress, side panel shows confirmation
```

## Architecture

### Files

#### `ai-chat-schemas.js` (NEW - 187 lines)
Defines platform-specific schemas:
- URL patterns (regex)
- Selectors (input, submit, messages, lastMessage, thinkingIndicator)
- Summary prompts (customized per platform)
- Wait timers (timeout: 45000ms, checkInterval: 800ms)
- Extraction scripts (chatHistoryScript, lastMessageScript)

**Utility Functions:**
- `detectAIChatPlatform(url)` - Returns platform object or null
- `getSummaryPrompt(platformId)` - Returns platform-specific prompt
- `isAIChatPlatform(url)` - Boolean check

#### `background.js` (UPDATED)
**New CDP Functions:**
- `executeFill(tabId, selector, value)` - Fills contenteditable/textarea via CDP
- `executeSendKeys(tabId, key)` - Presses Enter via CDP Input.dispatchKeyEvent
- `executeEvaluate(tabId, script)` - Runs JavaScript via CDP Runtime.evaluate
- `waitForNewMessage(tabId, selector, previousCount)` - Polls for new messages

**New Orchestration:**
- `captureAIChatSession(tabId, url, config)` - Main orchestration function
  1. Detects platform
  2. Shows badge progress (🤖 → ⏳ → ✅/❌)
  3. Fills input with summary prompt
  4. Submits (Enter key)
  5. Waits for AI response
  6. Extracts summary + chat history
  7. Saves to HIVEMIND via `/api/memories`
  8. Returns success/error

**Integration Points:**
- Context menu handler: `if (isAIChatPlatform(tab.url))` → run `captureAIChatSession()` → fallback to `smartExtract()` on error
- Message handler: `captureAISession` action → runs `captureAIChatSession()` with fallback

#### `side-panel.html` (UPDATED)
Added "💾 Save Session" button next to "Capture Context"

#### `side-panel.js` (UPDATED)
**New Handler:**
- `handleSaveSession()` - Sends `captureAISession` message to background
- Shows progress in button text: "💾 Saving..." → "✓ Saved" / "💾 Retry"
- Displays confirmation message in chat: "Session saved: Claude with 12 messages"

## Platform Schemas

### Claude (claude.ai)
```javascript
{
  urlPattern: /https:\/\/claude\.ai\/chat\/.*/,
  name: 'Claude',
  color: '#CD9C6D',
  selectors: {
    input: '[contenteditable="true"]',
    inputFallback: 'textarea',
    submit: 'button[aria-label="Send Message"]',
    messages: 'div[data-testid^="user-message"], div[data-testid^="assistant-message"]',
    lastMessage: 'div[data-testid^="assistant-message"]:last-of-type',
  },
  summaryPrompt: `Please provide a concise summary of this conversation in 2-3 sentences, capturing the key topics, decisions, and outcomes.`,
  waitForResponse: { timeout: 45000, checkInterval: 800 },
  extraction: {
    chatHistoryScript: `...`,
    lastMessageScript: `...`,
  }
}
```

### ChatGPT (chatgpt.com)
Custom selectors for OpenAI's UI structure, similar schema.

### Gemini (gemini.google.com)
Custom selectors for Google's UI structure, similar schema.

### Perplexity (perplexity.ai)
Custom selectors for Perplexity's UI structure, similar schema.

## CDP Execution Flow

```
1. attachDebugger(tabId)
   ↓
2. executeFill(tabId, selector, summaryPrompt)
   - Runtime.evaluate → querySelector
   - Handle contenteditable vs textarea
   - Trigger input/change events
   ↓
3. executeSendKeys(tabId, 'Enter')
   - Input.dispatchKeyEvent (keyDown + keyUp)
   ↓
4. waitForNewMessage(tabId, messagesSelector, previousCount)
   - Poll every 800ms
   - Check if message count increased
   - Timeout after 45000ms
   ↓
5. executeEvaluate(tabId, extraction.lastMessageScript)
   - Extract AI summary text
   ↓
6. executeEvaluate(tabId, extraction.chatHistoryScript)
   - Extract full chat history (role + content)
   ↓
7. Format + Save to HIVEMIND
   - POST /api/memories
   - Tags: ['ai-chat', platform.toLowerCase(), 'auto-summary', 'url:...']
   - Metadata: { platform, captured_at, auto_summary: true, message_count }
```

## Error Handling

### CDP Failures
- **Input not found**: Try `inputFallback` selector
- **Fill failed**: Throw error → trigger fallback
- **Submit failed**: Throw error → trigger fallback
- **Timeout waiting**: Throw error → trigger fallback

### Fallback Chain
```
captureAIChatSession() fails
  ↓
Catch error
  ↓
Log warning: "AI chat capture failed, falling back to standard extraction"
  ↓
Run smartExtract() (existing extractor)
  ↓
Save via saveToHivemind()
  ↓
Tag with 'ai-chat-fallback'
```

## Badge System

Visual feedback on extension icon:

| Stage | Badge | Color | Duration |
|-------|-------|-------|----------|
| Starting | 🤖 | Platform color | Instant |
| Waiting | ⏳ | Platform color | Until response |
| Success | ✅ | #22c55e (green) | 3 seconds |
| Failure | ❌ | #ef4444 (red) | 3 seconds |

## Saved Memory Structure

```json
{
  "content": "## AI-Generated Summary\n\n[AI's summary of conversation]\n\n## Full Chat History\n\n### 👤 User\n\n[User message 1]\n\n---\n\n### 🤖 AI\n\n[AI response 1]\n\n---\n\n...",
  "title": "Claude Session — 5/9/2026, 3:14:22 PM",
  "tags": ["ai-chat", "claude", "auto-summary", "url:https://claude.ai/chat/..."],
  "source": "claude",
  "source_metadata": {
    "platform": "Claude",
    "captured_at": "2026-05-09T15:14:22.123Z",
    "auto_summary": true,
    "message_count": 12
  }
}
```

## Usage Examples

### Scenario 1: Claude Conversation
```
1. User chats with Claude about database design
2. User right-clicks → "Save this page to HIVEMIND"
3. Extension detects claude.ai
4. Injects: "Please provide a concise summary of this conversation..."
5. Claude responds with summary
6. Extension captures summary + full 12-message history
7. Saves to HIVEMIND with tags: ['ai-chat', 'claude', 'auto-summary']
8. Badge shows ✅
```

### Scenario 2: ChatGPT with Fallback
```
1. User on chatgpt.com
2. Opens side panel → clicks "💾 Save Session"
3. Extension tries CDP automation
4. CDP fails (input selector changed)
5. Falls back to smartExtract()
6. Extracts via DOM traversal
7. Saves to HIVEMIND with tag 'ai-chat-fallback'
8. Side panel shows: "Session saved (fallback mode)"
```

### Scenario 3: Non-AI Page
```
1. User on github.com
2. Right-click → "Save this page to HIVEMIND"
3. Extension checks: isAIChatPlatform('https://github.com/...') → false
4. Skips CDP automation
5. Runs smartExtract() directly
6. Saves normally
```

## Testing Checklist

After reloading extension at `chrome://extensions/`:

### ✅ Context Menu Test
1. Navigate to claude.ai
2. Start a conversation (3-4 exchanges)
3. Right-click → "Save this page to HIVEMIND"
4. Verify:
   - Badge shows 🤖 → ⏳ → ✅
   - New message appears in chat (the summary prompt)
   - AI responds with summary
   - Memory saved to HIVEMIND
   - Memory contains summary + full chat

### ✅ Side Panel Test
1. Navigate to chatgpt.com
2. Start a conversation
3. Open side panel (click extension icon)
4. Click "💾 Save Session"
5. Verify:
   - Button shows "💾 Saving..." → "✓ Saved"
   - Side panel shows confirmation: "Session saved: ChatGPT with X messages"
   - Memory saved to HIVEMIND

### ✅ Fallback Test
1. Navigate to perplexity.ai (less tested platform)
2. Right-click → "Save this page to HIVEMIND"
3. If CDP fails:
   - Verify fallback extraction runs
   - Memory saved with 'ai-chat-fallback' tag

### ✅ Non-AI Page Test
1. Navigate to github.com
2. Right-click → "Save this page to HIVEMIND"
3. Verify:
   - No CDP automation attempted
   - Standard extraction runs
   - No AI chat tags

## Future Enhancements

### Potential Improvements
- [ ] Add Poe.com support
- [ ] Add HuggingChat support
- [ ] Add custom prompt templates per platform
- [ ] Add "smart summary" vs "full transcript" toggle
- [ ] Add retry logic for transient CDP failures
- [ ] Add progress percentage during wait
- [ ] Add audio notifications on success/failure
- [ ] Add keyboard shortcut for quick save (Ctrl+Shift+S)

### Advanced Features
- [ ] Incremental saves (save as conversation progresses)
- [ ] Diff detection (only save new messages since last save)
- [ ] Multi-tab batch save (save all AI chat tabs)
- [ ] Export to markdown/PDF
- [ ] Search across saved AI chats in HIVEMIND

## Troubleshooting

### Issue: Badge shows ❌
**Cause**: CDP automation failed  
**Solution**: Check console for error message. Fallback should have run automatically.

### Issue: Summary prompt visible in chat
**Behavior**: Expected — the prompt is injected and submitted like a real user message  
**Note**: This is by design for transparency

### Issue: Timeout waiting for response
**Cause**: AI taking >45 seconds to respond  
**Solution**: Increase `waitForResponse.timeout` in schema, or trigger save after AI finishes

### Issue: Wrong selector on platform update
**Cause**: Platform changed their HTML structure  
**Solution**: Update selectors in `ai-chat-schemas.js` for that platform

### Issue: Permission denied
**Cause**: Missing `host_permissions` in manifest.json  
**Solution**: Verify `host_permissions` includes the AI chat domain

## Security Considerations

### CDP Access
- CDP requires `debugger` permission (already granted)
- CDP only attaches to user-initiated saves (right-click or button click)
- No background CDP snooping

### API Keys
- Summary prompts sent to AI platforms directly (no HIVEMIND involvement)
- Captured content sent to HIVEMIND via existing `/api/memories` endpoint
- User's HIVEMIND API key required (stored in extension storage)

### Data Privacy
- No telemetry on capture attempts
- All data stays between browser → AI platform → HIVEMIND
- No third-party analytics

## Version History

### v2.1.0 (Current)
- ✅ Added `ai-chat-schemas.js` with 4 platform schemas
- ✅ Added CDP automation layer (executeFill, executeSendKeys, executeEvaluate, waitForNewMessage)
- ✅ Added `captureAIChatSession()` orchestration
- ✅ Integrated with context menu handler
- ✅ Added `captureAISession` message handler
- ✅ Added "💾 Save Session" button to side panel
- ✅ Added fallback to `smartExtract()` on CDP failure
- ✅ Added badge progress indicators

### v2.0.0
- ✅ Glass morphism overlay
- ✅ CDP integration for browser automation
- ✅ Fixed auto-save bug
- ✅ Added persistent side panel

---

**Last Updated**: 2026-05-09  
**Author**: APEX (First Principles Agent)  
**Status**: ✅ Complete — Ready for Testing
