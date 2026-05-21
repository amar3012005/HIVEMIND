# HOTFIX: API Integration Fix

## Issue
Extension chat was calling non-existent `/v1/proxy/chat` endpoint, resulting in "Not found" errors.

## Fix Applied
✅ **Updated `background.js`** to route to correct `/api/chat` endpoint

## What This Enables
The extension now has **full HIVEMIND memory integration** matching "Talk to HIVE":

### Automatic Behaviors (No User Prompt Needed)
1. **RECALL FIRST** — Before answering, HIVEMIND automatically recalls relevant memories
2. **SAVE AS YOU GO** — New facts, decisions, preferences automatically saved to memory
3. **UPDATE ON CONTRADICTION** — When you correct something, it updates the memory graph
4. **SMART FACT EXTRACTION** — Pulls key facts from declarative statements
5. **BI-TEMPORAL TIME TRAVEL** — Understands "as of last week" / "back in March"
6. **GRAPH EXPANSION** — Surfaces related memories via Updates/Extends/Derives edges

### Memory Types Handled
- ✅ Facts (extracted automatically)
- ✅ Preferences ("I prefer dark mode")
- ✅ Decisions ("We're using Postgres")
- ✅ Goals ("Launch by Q3")
- ✅ Events (dated milestones)
- ✅ Relationships (person/company mentions)
- ✅ Lessons ("X didn't work because Y")

### Integration Details
**Endpoint**: `${config.apiBase}/api/chat`
- Method: POST
- Headers: `X-API-Key` (from extension config)
- Body: `{message, model, history}`
- Response: `{response, sources, slack_used, google_used, ...}`

**Model**: `llama-3.3-70b-versatile` (Groq)

**System Prompt**: Comprehensive HIVEMIND prompt with:
- Identity line ("You are HIVEMIND — this user's second brain")
- Voice profile (org-voice + user-voice)
- Recall context injection (top 15 memories)
- Intent detection (meta/recency/aggregate/declarative/update queries)
- Action execution instructions (for browser automation)

## Testing
1. **Reload extension** in `chrome://extensions/`
2. Open any webpage
3. Press **Cmd+Shift+H** (Mac) or **Ctrl+Shift+H** (Windows)
4. Try: "What do you know about me?"
   - Should recall memories and respond naturally
5. Try: "I prefer TypeScript over JavaScript"
   - Should acknowledge and auto-save to memory
6. Try: "Actually, I changed to Python"
   - Should update the previous memory

## Removed Code
- ❌ Manual `recallFromHivemind()` call in `handleChatMessage` (now handled by `/api/chat`)
- ❌ Manual context merging (now done server-side)
- ❌ `/v1/proxy/chat` routing (endpoint didn't exist)

## Files Modified
- `extensions/chrome/background.js` (lines 390-430)

## API Response Format
```json
{
  "response": "Got it — you prefer TypeScript. Noted.",
  "sources": [
    {
      "id": "mem_xyz",
      "title": "Programming preferences",
      "content": "User prefers TypeScript...",
      "score": 0.92,
      "tags": ["preference", "programming"]
    }
  ],
  "slack_used": false,
  "google_used": false,
  "assistant_name": "HIVEMIND"
}
```

## Browser Automation Actions
The AI can now execute actions on the page:
- `ACTION: click @e5` — Click element with @e5 reference
- `ACTION: fill @e3 with hello@example.com` — Fill form field
- `ACTION: navigate https://example.com` — Navigate to URL

These are parsed from the AI's response and executed via CDP.

---

**Status**: ✅ FIXED — Extension now fully integrated with HIVEMIND memory pipeline
**Date**: 2026-05-20
**Version**: 2.0.0
