# HIVEMIND Chat Extension v2.0.0

**AI chat with perfect memory + browser automation**

A professional Chrome extension that combines:
- 🧠 **HIVEMIND Memory Engine** — recall anything you've saved
- 👁️ **Page Context Awareness** — sees everything on the page via CDP
- ⚡ **Action Execution** — click, fill, navigate automatically
- 🎨 **Glass Morphism UI** — transparent, beautiful overlay

---

## Features

### 🔍 **Context-Aware Chat**
- Captures full page context including:
  - URL and title
  - Interactive elements (buttons, links, forms)
  - Accessibility tree with @e references
- Caches context for 30 seconds to avoid redundant captures
- Auto-updates on URL changes

### 🧠 **Memory Integration**
- **Auto-recall**: Relevant memories injected into every query
- **Auto-save**: All conversations saved to HIVEMIND
- **Sources display**: Shows which memories informed the answer

### ⚡ **Action Execution**
- **Click**: `ACTION: click @e5` — clicks interactive elements
- **Fill**: `ACTION: fill @e3 hello world` — types into text fields
- **Navigate**: `ACTION: navigate https://example.com` — opens URLs
- Actions parsed from AI responses and executed automatically

### 🎨 **Professional UI**
- **Glass morphism** design with blur effects
- **Slide-out panel** (420px wide)
- **Dark mode** support
- **Smooth animations** and transitions
- **Keyboard shortcuts**: `Cmd+Shift+H` to toggle

---

## Architecture

### Content Script (`chat-overlay.js`)
- Injects glass overlay into all pages
- Captures keyboard shortcuts
- Routes messages to background
- Displays chat UI and executes actions
- Auto-saves interactions to memory

### Background Service Worker (`background.js`)
- **CDP Integration**: Chrome Debugger Protocol for page introspection
- **Context Capture**: Accessibility tree extraction
- **Chat Routing**: Routes to `/v1/proxy/chat` endpoint
- **Action Execution**: Resolves @e refs and executes CDP commands
- **Memory Operations**: Save and recall via HIVEMIND API

### CDP Tools (Kimi-inspired)
- `attachDebugger(tabId)` — attach Chrome Debugger Protocol
- `sendCommand(tabId, method, params)` — send CDP commands
- `extractInteractiveElements(nodes)` — parse accessibility tree
- `executeClick(tabId, target)` — click via CDP or DOM
- `executeFill(tabId, target, value)` — fill inputs via CDP
- `executeNavigate(tabId, url)` — navigate to URL

---

## Installation

### 1. **Load Extension**
```bash
cd extensions/chrome
```

In Chrome:
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extensions/chrome` folder

### 2. **Configure API Key**
1. Click the extension icon
2. Enter your HIVEMIND API key
3. Set API base URL (default: `https://core.hivemind.davinciai.eu:8050`)
4. Save configuration

### 3. **Test It**
1. Press `Cmd+Shift+H` on any page
2. Chat overlay slides in from the right
3. Ask questions about the page
4. Watch it execute actions automatically

---

## Usage

### **Open Chat**
- **Keyboard**: `Cmd+Shift+H` (Mac) or `Ctrl+Shift+H` (Windows/Linux)
- **Extension icon**: Click to toggle

### **Ask Questions**
```
"What are the main headings on this page?"
"Summarize this article"
"Find the login button"
"What did I save about this topic last week?"
```

### **Execute Actions**
The AI can respond with actions that execute automatically:

```
User: "Click the 'Get Started' button"
AI: "I'll click it for you. ACTION: click @e7"
→ Button is clicked automatically
```

```
User: "Fill in 'John Smith' in the name field"
AI: "Filling it now. ACTION: fill @e12 John Smith"
→ Input is filled automatically
```

### **Save to Memory**
All conversations are automatically saved with:
- User query and AI response
- Page URL and title
- Timestamp
- Platform tags
- Action tags (if actions were executed)

---

## API Integration

### **Chat Endpoint**
`POST /api/chat`

**Full HIVEMIND memory integration** — automatic recall, save, and update.

Request:
```json
{
  "message": "User query + [Browser Context with @e references]",
  "model": "llama-3.3-70b-versatile",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

Response:
```json
{
  "response": "AI reply (may contain ACTION: commands)",
  "sources": [
    {
      "id": "mem_xyz",
      "title": "Memory title",
      "content": "Memory content...",
      "score": 0.92,
      "tags": ["tag1", "tag2"]
    }
  ],
  "slack_used": false,
  "google_used": false,
  "assistant_name": "HIVEMIND"
}
```

**Automatic Behaviors:**
- ✅ Recalls relevant memories before answering
- ✅ Saves new facts/preferences automatically
- ✅ Updates contradicted memories
- ✅ Expands top memory via graph edges
- ✅ Supports bi-temporal queries ("as of last week")

### **Memory Endpoint**
`POST /api/memories`

Request:
```json
{
  "content": "Q: ... A: ...",
  "title": "Chat on example.com",
  "tags": ["browser-chat", "platform:github", "url:github.com"],
  "memory_type": "fact",
  "source_metadata": {
    "source_type": "browser-extension",
    "source_platform": "browser-chat"
  }
}
```

### **Recall Endpoint**
`POST /api/recall`

Request:
```json
{
  "query_context": "User query",
  "max_memories": 5
}
```

Response:
```json
{
  "memories": [...],
  "injectionText": "Here are 3 relevant memories..."
}
```

---

## CDP (Chrome Debugger Protocol)

### **Why CDP?**
- **Semantic element targeting**: @e references from accessibility tree
- **Reliable clicking**: Pixel-perfect mouse events
- **Native input**: Real keyboard events, not DOM manipulation
- **Full page introspection**: See what the user sees

### **Permissions Required**
```json
{
  "permissions": ["debugger", "tabs", "activeTab", "storage"]
}
```

### **CDP Commands Used**
- `Accessibility.enable` — enable accessibility domain
- `Accessibility.getFullAXTree` — get semantic tree
- `DOM.resolveNode` — resolve backendDOMNodeId to objectId
- `DOM.getBoxModel` — get element position
- `Input.dispatchMouseEvent` — click elements
- `Input.insertText` — type text
- `Runtime.evaluate` — execute JavaScript
- `Runtime.callFunctionOn` — execute functions on elements

---

## Action Reference

### **Click Action**
```
ACTION: click @e5
ACTION: click button.submit
```

- Resolves @e references to DOM nodes via CDP
- Scrolls element into view
- Gets pixel-perfect position
- Dispatches mouse events

### **Fill Action**
```
ACTION: fill @e12 John Smith
ACTION: fill input[name="email"] user@example.com
```

- Focuses element
- Clears existing value
- Inserts text via CDP
- Triggers input events

### **Navigate Action**
```
ACTION: navigate https://example.com
ACTION: navigate /login
```

- Updates tab URL
- Works with absolute and relative URLs

---

## Troubleshooting

### **Overlay not appearing**
- Check extension is loaded in `chrome://extensions/`
- Try reloading the page
- Check browser console for errors

### **Context capture fails**
- CDP requires debugger permission
- Some pages (chrome://, chrome-extension://) cannot be debugged
- Refresh page and try again

### **Actions not executing**
- Context must be captured first (wait for "✓ Context ready")
- @e references expire after 30 seconds (recapture context)
- Some elements may not be interactive

### **API errors**
- Check API key is configured correctly
- Verify API base URL is reachable
- Check backend logs for errors

---

## Development

### **File Structure**
```
extensions/chrome/
├── manifest.json           # Extension manifest (v3)
├── background.js           # Service worker + CDP integration
├── chat-overlay.js         # Content script + UI
├── chat-overlay.css        # Glass morphism styles
├── extractors.js           # Platform-specific extractors
├── content-ai-inject.js    # Auto-capture for AI platforms
└── popup.html              # Config popup
```

### **Build & Test**
```bash
# No build step needed — pure vanilla JS

# Load extension
cd extensions/chrome
# Load unpacked in chrome://extensions/

# Test locally
# 1. Open any webpage
# 2. Press Cmd+Shift+H
# 3. Type a message
# 4. Watch context capture and actions
```

### **Debug Mode**
```javascript
// In chat-overlay.js
console.log('[HIVEMIND Chat] Message:', data);

// In background.js
console.log('[CDP] Context captured:', context);
```

---

## Roadmap

### **v2.1.0**
- [ ] Voice input (VAD + WebSocket streaming)
- [ ] Screenshot tool (`ACTION: screenshot @e5`)
- [ ] Multi-tab coordination
- [ ] Custom system prompts

### **v2.2.0**
- [ ] Workflow recorder (record actions, replay later)
- [ ] Template library (common automation patterns)
- [ ] Export conversations as markdown

### **v3.0.0**
- [ ] Autonomous browsing mode
- [ ] Vision integration (analyze screenshots)
- [ ] Cross-platform sync (share automations)

---

## Credits

**Inspired by:**
- [Kimi WebBridge](https://github.com/moonshot-labs/kimi-webbridge) — CDP architecture and tool patterns
- [TARA Visual Co-Pilot](../frontend/Da-vinci/public/dom_widget.html) — Glass morphism overlay design
- [Talk to HIVE](../frontend/Da-vinci/src/components/hivemind/app/pages/Chat.jsx) — Chat UI patterns

**Built with:**
- Chrome Manifest v3
- Chrome Debugger Protocol (CDP)
- Vanilla JavaScript (no frameworks)
- Glass morphism CSS

---

## License

Part of the HIVEMIND project.  
See main LICENSE for details.
