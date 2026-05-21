# HIVEMIND Chat Extension — Quick Start

## Installation (2 minutes)

### 1. Load Extension
```bash
cd /Users/amar/HIVE-MIND/extensions/chrome
```

In Chrome:
1. Open `chrome://extensions/`
2. Toggle "Developer mode" (top right)
3. Click "Load unpacked"
4. Select `/Users/amar/HIVE-MIND/extensions/chrome/`

✓ Extension should appear with 🧠 icon

### 2. Configure API (1 minute)
1. Click 🧠 icon in toolbar
2. Enter API key: `your-hivemind-api-key`
3. API base: `https://core.hivemind.davinciai.eu:8050` (default)
4. Click "Save"

### 3. Test It (30 seconds)
1. Open any webpage (e.g., https://github.com)
2. Press `Cmd+Shift+H`
3. Glass overlay slides in from right
4. Type "What's on this page?"
5. Watch context capture + memory recall

---

## Testing Checklist

### ✅ **Basic Functionality**

- [ ] Extension loads without errors
- [ ] Icon appears in toolbar
- [ ] Popup opens when clicking icon
- [ ] API key saves to storage

### ✅ **Overlay UI**

- [ ] `Cmd+Shift+H` toggles overlay
- [ ] Overlay slides in from right with animation
- [ ] Glass morphism effect visible (blur + transparency)
- [ ] Dark mode adapts to system preference
- [ ] Close button works
- [ ] Input field focuses automatically

### ✅ **Context Capture**

- [ ] Status bar shows "⏳ Capturing page context..."
- [ ] Status changes to "✓ Context ready · N interactive elements"
- [ ] Context includes URL, title, element count
- [ ] @e references are assigned (e.g., @e1, @e2, @e3)
- [ ] Context refreshes on URL change

### ✅ **Chat Functionality**

- [ ] Typing message and pressing Enter sends it
- [ ] User message appears in chat (blue bubble)
- [ ] Thinking indicator appears (3 dots animation)
- [ ] AI response appears (gray bubble)
- [ ] Sources section displays (if memories found)
- [ ] Message history maintained

### ✅ **Memory Integration**

- [ ] Relevant memories recalled automatically
- [ ] Sources displayed below AI response
- [ ] Conversations auto-saved to HIVEMIND
- [ ] Tags include: browser-chat, platform, url

### ✅ **Action Execution**

Test on a page with forms (e.g., https://www.google.com):

**Click Action:**
- [ ] Ask: "Click the search button"
- [ ] AI responds with: `ACTION: click @e5`
- [ ] Element is clicked automatically
- [ ] Toast notification appears: "✓ click executed"

**Fill Action:**
- [ ] Ask: "Fill in 'test query' in the search box"
- [ ] AI responds with: `ACTION: fill @e1 test query`
- [ ] Input is filled automatically
- [ ] Toast notification appears: "✓ fill executed"

**Navigate Action:**
- [ ] Ask: "Go to example.com"
- [ ] AI responds with: `ACTION: navigate https://example.com`
- [ ] Page navigates to URL
- [ ] Toast notification appears: "✓ navigate executed"

### ✅ **Error Handling**

- [ ] No API key configured → shows error message
- [ ] API unreachable → shows connection error
- [ ] Invalid @e reference → shows error toast
- [ ] CDP fails on chrome:// pages → graceful fallback

### ✅ **Performance**

- [ ] Overlay opens in <300ms
- [ ] Context capture completes in <2s
- [ ] Chat response arrives in <5s
- [ ] No page performance degradation
- [ ] Memory usage stays under 50MB

### ✅ **Compatibility**

Test on various sites:
- [ ] GitHub (code pages)
- [ ] Google (search pages)
- [ ] Twitter (social media)
- [ ] News sites (long articles)
- [ ] YouTube (video pages)
- [ ] Gmail (web apps)

---

## Debug Checklist

### If overlay doesn't appear:

```javascript
// 1. Check extension loaded
chrome://extensions/ → HIVEMIND Chat should be enabled

// 2. Check console for errors
Right-click page → Inspect → Console
Look for: [HIVEMIND Chat] Initialized

// 3. Check keyboard shortcut
chrome://extensions/shortcuts
Verify: Cmd+Shift+H is assigned to "Toggle HIVEMIND chat overlay"

// 4. Test manual toggle
chrome.runtime.sendMessage({ action: 'toggleChat' })
```

### If context capture fails:

```javascript
// 1. Check CDP permission
manifest.json should include: "permissions": ["debugger"]

// 2. Check tab is debuggable
Not chrome://, chrome-extension://, or other internal pages

// 3. Test CDP manually
chrome.debugger.attach({ tabId: YOUR_TAB_ID }, '1.3')
chrome.debugger.sendCommand({ tabId: YOUR_TAB_ID }, 'Accessibility.enable')

// 4. Check cache
console.log(contextCache) // In background.js
```

### If actions fail:

```javascript
// 1. Check @e references exist
Context must be captured first → check status bar

// 2. Check element is interactive
Only buttons, links, inputs have @e refs

// 3. Test CDP click manually
chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {...})

// 4. Check action parsing
Regex should match: /ACTION:\s*(\w+)\s+(@e\d+|\S+)(?:\s+(.+))?/gim
```

### If memory operations fail:

```javascript
// 1. Check API key
chrome.storage.local.get(['apiKey']) → should return your key

// 2. Test API manually
fetch('https://core.hivemind.davinciai.eu:8050/api/recall', {
  method: 'POST',
  headers: { 'X-API-Key': 'your-key', 'Content-Type': 'application/json' },
  body: JSON.stringify({ query_context: 'test', max_memories: 5 })
})

// 3. Check network tab
Inspect → Network → filter by 'recall' → verify request/response

// 4. Check backend logs
SSH to server → check core service logs
```

---

## Known Issues

### 1. **CDP Limitations**
- Cannot debug chrome://, chrome-extension://, edge:// pages
- CDP may interfere with DevTools if both open
- Some SPA frameworks may not reflect DOM changes immediately

**Workaround**: Refresh page or close DevTools

### 2. **Context Cache**
- @e references expire after 30 seconds
- URL changes invalidate cache
- Multiple tabs share same cache (race condition possible)

**Workaround**: Recapture context before executing actions

### 3. **Action Parsing**
- AI may respond without ACTION: prefix
- Complex actions may not parse correctly
- Multiple actions in one response execute serially

**Workaround**: Prompt AI explicitly: "Execute the action"

### 4. **Memory Auto-Save**
- All conversations saved (no filtering yet)
- May create duplicate memories if refreshed
- Tags are basic (no custom tagging yet)

**Workaround**: Manual cleanup via HIVEMIND UI

---

## Development Tips

### Hot Reload
```bash
# Make changes to JS/CSS
# In chrome://extensions/
# Click reload icon on HIVEMIND Chat extension
# Refresh test page
# Test changes
```

### Console Logging
```javascript
// chat-overlay.js
console.log('[HIVEMIND Chat] Debug:', data);

// background.js
console.log('[CDP] Command:', method, params);
console.log('[Chat] Response:', response);
```

### Inspect Extension
```bash
# Background service worker
chrome://extensions/ → HIVEMIND Chat → "Inspect views: service worker"

# Content script
Right-click page → Inspect → Console
# Content script logs appear here
```

### Test CDP Commands
```javascript
// In background service worker console
const tabId = (await chrome.tabs.query({ active: true }))[0].id;
await attachDebugger(tabId);
const result = await sendCommand(tabId, 'Accessibility.getFullAXTree');
console.log(result);
```

---

## Support

### Report Issues
1. Check Known Issues above
2. Check browser console for errors
3. Check background service worker console
4. Create issue with:
   - Error message
   - Browser version
   - Page URL (if relevant)
   - Steps to reproduce

### Request Features
- Voice input/output
- Screenshot tool
- Multi-tab coordination
- Workflow recorder
- Template library
- Custom system prompts

---

## Next Steps

After successful testing:

1. **Test in Production**
   - Use on real workflows
   - Save actual work to memory
   - Execute real actions

2. **Customize**
   - Modify system prompt in backend
   - Add custom action types
   - Extend CDP tools

3. **Deploy**
   - Package extension for Chrome Web Store
   - Add usage analytics
   - Create onboarding flow

4. **Iterate**
   - Collect user feedback
   - Fix bugs
   - Add requested features

---

**Ready to test? Press `Cmd+Shift+H` on any page!** 🚀
