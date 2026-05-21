# HIVEMIND Extension v1.1.0 → v2.0.0 Migration Guide

## What's New in v2.0.0

### 🆕 **New Features**

**1. Chat Overlay**
- Glass morphism side panel activated with `Cmd+Shift+H`
- Real-time conversation with AI about the current page
- Memory recall integrated into every response

**2. CDP Integration**
- Chrome Debugger Protocol for deep page introspection
- Accessibility tree extraction with @e element references
- 100+ interactive elements captured per page

**3. Action Execution**
- AI can click buttons: `ACTION: click @e5`
- AI can fill forms: `ACTION: fill @e3 John Smith`
- AI can navigate: `ACTION: navigate https://example.com`

**4. Context Awareness**
- Captures full page context automatically
- Includes URL, title, interactive elements
- Refreshes on URL changes

### 🔄 **What's Changed**

**Permissions**
```diff
+ "debugger"     // New: Required for CDP
+ "tabs"         // New: Required for tab management
  "activeTab"    // Existing
  "storage"      // Existing
  "contextMenus" // Existing
  "scripting"    // Existing
```

**Content Scripts**
```diff
+ chat-overlay.js    // New: Chat overlay on all pages
+ chat-overlay.css   // New: Glass morphism styles
  extractors.js      // Existing: Platform-specific extraction
  content-ai-inject.js // Existing: Auto-capture AI conversations
```

**Background Service Worker**
```diff
+ CDP integration    // New: Chrome Debugger Protocol
+ Context capture    // New: Accessibility tree extraction
+ Chat routing       // New: Routes to /v1/proxy/chat
+ Action execution   // New: Click, fill, navigate
  Context menu       // Existing
  Memory operations  // Existing
```

### ✅ **What's Preserved**

**All v1.1.0 features still work:**
- ✅ Right-click "Save to HIVEMIND" (context menu)
- ✅ Auto-capture AI conversations (ChatGPT, Claude, Gemini)
- ✅ Platform-specific extraction (smartExtract)
- ✅ Memory save/recall API integration
- ✅ Extension popup with API key config

**No breaking changes to existing workflows!**

---

## Migration Steps

### Step 1: Update Extension Files

**Option A: Git Pull (if cloned)**
```bash
cd /Users/amar/HIVE-MIND
git pull origin main
```

**Option B: Download & Replace**
```bash
# Backup current version
cp -r extensions/chrome extensions/chrome-v1.1.0-backup

# Replace with new files
# (Already done if reading this!)
```

### Step 2: Reload Extension

```bash
1. Open chrome://extensions/
2. Find "HIVEMIND — AI Memory Engine"
3. Click "Reload" button (circular arrow)
4. Check version shows "2.0.0"
```

### Step 3: Grant New Permissions

Chrome will prompt:
```
HIVEMIND Chat — AI Memory + Browser Automation
wants permission to:
• Start debugger
```

Click **"Allow"** — this enables CDP integration.

### Step 4: Test New Features

1. **Test Chat Overlay**
   - Open any webpage
   - Press `Cmd+Shift+H`
   - Glass panel should slide in
   - Type a message and send

2. **Test Context Capture**
   - Wait for status bar: "✓ Context ready · N interactive elements"
   - Ask: "What buttons are on this page?"
   - AI should list interactive elements

3. **Test Action Execution**
   - On a page with a search box
   - Ask: "Click the search button"
   - Button should be clicked automatically

4. **Test Memory Integration**
   - Ask: "What did I save about [topic]?"
   - Relevant memories should be recalled
   - Conversation should auto-save

### Step 5: Verify Existing Features

**Context Menu (right-click)**
- [ ] "Save to HIVEMIND" still appears
- [ ] Selection saving still works
- [ ] Page saving still works

**Auto-Capture**
- [ ] ChatGPT conversations still auto-save
- [ ] Claude conversations still auto-save
- [ ] Gemini conversations still auto-save

**Popup Config**
- [ ] API key still saved
- [ ] API base URL still works
- [ ] User ID still persists

---

## Troubleshooting

### Extension won't load

```bash
# Check manifest.json is valid
cd extensions/chrome
cat manifest.json | jq .  # Should output formatted JSON

# If error, restore backup
cp -r extensions/chrome-v1.1.0-backup/* extensions/chrome/
```

### Chat overlay doesn't appear

```bash
# 1. Check debugger permission granted
chrome://extensions/ → HIVEMIND Chat → Details → Permissions
Should show: "Start debugger"

# 2. Check keyboard shortcut registered
chrome://extensions/shortcuts
Should show: "Toggle HIVEMIND chat overlay" → Cmd+Shift+H

# 3. Reload extension + refresh page
chrome://extensions/ → Reload
Then refresh test page
```

### Actions fail to execute

```bash
# 1. Check context was captured
Open overlay → status bar should say "✓ Context ready"

# 2. Check @e references exist
Ask AI: "List all interactive elements"
Response should include: @e1, @e2, @e3, ...

# 3. Check CDP attached
Open background service worker console
chrome://extensions/ → HIVEMIND Chat → Inspect views: service worker
Run: attachedTabs
Should show current tab ID
```

### Memory operations broken

```bash
# 1. Check API key still configured
Click extension icon → should show saved API key

# 2. Test recall manually
chrome.runtime.sendMessage(
  { action: 'recall', query: 'test' },
  response => console.log(response)
)

# 3. Check API endpoint reachable
fetch('https://core.hivemind.davinciai.eu:8050/health')
Should return 200 OK
```

---

## Rollback Plan

If v2.0.0 has critical issues, you can rollback:

### Option 1: Restore Backup
```bash
rm -rf extensions/chrome/*
cp -r extensions/chrome-v1.1.0-backup/* extensions/chrome/
# Reload extension in chrome://extensions/
```

### Option 2: Git Revert
```bash
cd /Users/amar/HIVE-MIND
git log --oneline  # Find v1.1.0 commit hash
git checkout <commit-hash> -- extensions/chrome/
# Reload extension
```

### Option 3: Disable New Features
In `manifest.json`:
```json
// Comment out chat-overlay content script
{
  "content_scripts": [
    // {
    //   "matches": ["<all_urls>"],
    //   "js": ["chat-overlay.js"],
    //   "css": ["chat-overlay.css"]
    // },
    {
      "matches": ["https://chatgpt.com/*", ...],
      "js": ["extractors.js", "content-ai-inject.js"]
    }
  ]
}
```

Then reload extension — v1.1.0 features will work.

---

## FAQ

### Q: Do I need to reconfigure the extension?
**A:** No! API key, API base URL, and user ID are preserved in `chrome.storage.local`.

### Q: Will my saved memories be affected?
**A:** No! The extension just adds new features. All existing memories remain unchanged.

### Q: Can I use both v1.1.0 and v2.0.0 features?
**A:** Yes! The chat overlay is additive. All original features (context menu, auto-capture) still work.

### Q: Does CDP slow down browsing?
**A:** No. CDP only activates when you open the chat overlay. Inactive = zero overhead.

### Q: Can I customize the keyboard shortcut?
**A:** Yes! Go to `chrome://extensions/shortcuts` and change "Toggle HIVEMIND chat overlay" to any key combo.

### Q: Does it work on all websites?
**A:** Almost all. CDP cannot debug:
- `chrome://` internal pages
- `chrome-extension://` pages
- Some sites with strict CSP policies

Regular features (context menu, auto-capture) work everywhere.

### Q: What about privacy?
**A:** v2.0.0 follows the same privacy model as v1.1.0:
- All data sent to your HIVEMIND instance only
- No third-party tracking
- CDP access is local (not sent anywhere)
- Context is cached locally for 30 seconds only

### Q: Can I turn off the chat overlay?
**A:** Yes, just don't press `Cmd+Shift+H`. Or remove the content script from `manifest.json`.

### Q: How do I uninstall?
**A:** Same as any extension:
```
chrome://extensions/ → HIVEMIND Chat → Remove
```

---

## Support

### Report Migration Issues

If you encounter problems during migration:

1. **Check browser console**
   - Right-click page → Inspect → Console
   - Look for `[HIVEMIND]` errors

2. **Check background console**
   - chrome://extensions/ → HIVEMIND Chat → Inspect views
   - Look for `[CDP]` or `[Chat]` errors

3. **Create issue** with:
   - Error message
   - Migration step where it failed
   - Browser version (chrome://version/)
   - OS version

### Get Help

- **Docs**: Read `CHAT_README.md` for full documentation
- **Quick Start**: Read `QUICKSTART.md` for testing guide
- **Architecture**: Read `docs/TRANSPARENT_OVERLAY_ARCHITECTURE.md` for technical details

---

## What's Next?

After successful migration:

### **Week 1: Test New Features**
- [ ] Try chat overlay on 10+ different sites
- [ ] Execute 20+ actions (click, fill, navigate)
- [ ] Save 50+ conversations to memory
- [ ] Report any bugs or issues

### **Week 2: Provide Feedback**
- [ ] What actions would you like to add?
- [ ] What UI improvements would help?
- [ ] What integrations would be useful?
- [ ] What documentation is missing?

### **Week 3: Request Custom Features**
- Voice input/output
- Screenshot and analyze
- Multi-tab coordination
- Workflow recorder
- Template library
- Custom system prompts

---

**Welcome to HIVEMIND v2.0.0!** 🚀

Press `Cmd+Shift+H` and start chatting with your AI that sees everything and remembers everything.
