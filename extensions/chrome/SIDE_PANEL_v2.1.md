# HIVEMIND v2.1.0 — Persistent Side Panel + Glass Morphism

## ✨ New Features

### 1. **Persistent Side Panel** (Like Chrome DevTools)
- **Always accessible** via extension icon or `Cmd+Shift+H`
- **Survives page reloads** — chat history persists across navigation
- **Better than overlay** — doesn't cover page content, slides in from right
- **Badge notifications** — unread count on extension icon

### 2. **Glass Morphism Design**
- **Semi-transparent backgrounds** — see through to content behind
- **Backdrop blur** — 20-30px blur with color saturation
- **Smooth animations** — slide-in from right (0.4s cubic-bezier)
- **Dark mode support** — auto-adapts to system theme
- **Depth & shadows** — layered glass effect with subtle borders

### 3. **Chat Persistence**
- **History saved** in `chrome.storage.local`
- **Restores on reload** — chat continues where you left off
- **Tab-aware** — tracks current page context
- **Auto-scroll** — always shows latest message

---

## 🎨 Visual Design

### Glass Layers

**Header** (Top bar)
```css
background: rgba(255, 255, 255, 0.8)
backdrop-filter: blur(20px) saturate(180%)
box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1)
```

**Messages Container** (Main area)
```css
background: rgba(255, 255, 255, 0.4)
backdrop-filter: blur(30px) saturate(150%)
```

**Message Bubbles**
- **User**: `rgba(102, 126, 234, 0.9)` with blue glow
- **Assistant**: `rgba(243, 244, 246, 0.9)` with subtle shadow
- **System**: `rgba(254, 243, 199, 0.9)` for notifications

**Input Area** (Bottom)
```css
background: rgba(255, 255, 255, 0.8)
backdrop-filter: blur(20px) saturate(180%)
box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.1)
```

### Dark Mode
- **Header**: `rgba(30, 30, 30, 0.85)`
- **Messages**: `rgba(17, 24, 39, 0.6)`
- **Bubbles**: Adjusted opacity for visibility
- Auto-detects via `@media (prefers-color-scheme: dark)`

---

## 📐 Layout

```
┌─────────────────────────────────────┐
│ [H] HIVEMIND          🟢 Connected  │ ← Header (glass)
├─────────────────────────────────────┤
│ example.com/page   [Capture Context]│ ← Context bar
├─────────────────────────────────────┤
│                                     │
│  💬 User message bubble             │
│                                     │
│         Assistant response 💬       │
│         📚 5 sources                │
│                                     │
│  🟡 System: Action completed        │
│                                     │
│             ↓ scroll ↓              │ ← Messages (blur 30px)
├─────────────────────────────────────┤
│ [Text input area.............]  [→] │ ← Input (glass)
└─────────────────────────────────────┘
         ↑ Slide-in animation
```

---

## 🔧 Implementation

### Files Modified

1. **manifest.json**
   - Added `"sidePanel"` permission
   - Added `"side_panel": { "default_path": "side-panel.html" }`
   - Version bump: `2.0.0` → `2.1.0`

2. **side-panel.html** (NEW - 580 lines)
   - Full chat UI with glass morphism styling
   - Dark mode support via CSS variables
   - Responsive message bubbles
   - Thinking indicator (animated dots)
   - Context bar with capture button

3. **side-panel.js** (NEW - 380 lines)
   - Chat history persistence via `chrome.storage.local`
   - Tab tracking and auto-context update
   - Message routing to background worker
   - Action execution (click, fill, navigate)
   - Connection status monitoring

4. **background.js**
   - Added side panel behavior: `openPanelOnActionClick: true`
   - Badge notification system (unread count)
   - Clear badge on panel open via `chrome.runtime.onConnect`

---

## 🚀 Usage

### Opening the Panel

**Method 1: Extension Icon**
- Click HIVEMIND icon in Chrome toolbar
- Panel slides in from right

**Method 2: Keyboard Shortcut**
- `Cmd+Shift+H` (Mac) or `Ctrl+Shift+H` (Windows/Linux)

**Method 3: Overlay Toggle** (Still works)
- Original overlay still functional if needed

### Features

**Capture Context**
- Click "Capture Context" in context bar
- Extracts page text + interactive elements
- Shows `✓ Captured` when done
- Context sent with every message

**Chat Persistence**
- All messages saved automatically
- Reloads with full history on extension restart
- Survives page navigation
- Cleared only by user action

**Badge Notifications**
- Unread count on extension icon
- Clears when panel opened
- Subtle blue background: `#667eea`

**Action Execution**
- AI responds with `ACTION: click [el:5]`
- Side panel executes via background CDP
- Shows system message: `✓ Action completed: click`

---

## 🎯 Comparison: Side Panel vs Overlay

| Feature | Side Panel (v2.1) | Overlay (v2.0) |
|---------|------------------|----------------|
| **Persistence** | ✅ Survives reloads | ❌ Closes on reload |
| **Page coverage** | ✅ Doesn't block content | ⚠️ Covers page |
| **Chat history** | ✅ Persisted | ❌ Lost on close |
| **Accessibility** | ✅ Always one click away | ⚠️ Must re-toggle |
| **Badge count** | ✅ Unread indicator | ❌ None |
| **Glass effect** | ✅ See-through blur | ✅ See-through blur |
| **Animation** | ✅ Slide from right | ✅ Slide from right |

**Recommendation**: Use **side panel** for primary chat, keep **overlay** for quick in-page queries.

---

## 🐛 Known Limitations

1. **Side panel width**: Fixed by Chrome (typically ~400px), cannot be resized
2. **Cross-origin**: CDP not available on `chrome://` or extension pages
3. **Badge clear timing**: May briefly persist if panel opened while message arriving

---

## 🧪 Testing

1. **Install/Reload Extension**
   ```
   chrome://extensions/ → Reload
   ```

2. **Open Side Panel**
   - Click extension icon
   - Should slide in from right with glass effect

3. **Test Persistence**
   - Send a message
   - Navigate to new page
   - Re-open panel → message still there ✅

4. **Test Dark Mode**
   - System Preferences → Dark Mode
   - Panel should adapt to dark theme ✅

5. **Test Context Capture**
   - Click "Capture Context" → shows "✓ Captured"
   - Send message → AI has page context ✅

6. **Test Badge**
   - Send message while panel closed
   - Badge shows count on icon ✅
   - Open panel → badge clears ✅

---

## 📊 Performance

- **Memory**: ~5-10 MB for side panel iframe
- **CPU**: Minimal (only when typing/scrolling)
- **Storage**: ~1 KB per 20 messages in `chrome.storage.local`
- **Blur cost**: Hardware-accelerated, negligible on modern GPUs

---

## 🎨 Design Philosophy

**Inspired by:** macOS Big Sur glass morphism, iOS 15 frosted glass, Windows 11 Acrylic

**Principles:**
- **Depth through transparency** — layers visible through blur
- **Content-aware** — background shows through, maintains context
- **Smooth motion** — cubic-bezier easing for natural feel
- **Adaptive darkness** — respects user's theme preference
- **Subtle elevation** — shadows and borders define hierarchy

---

**Version**: 2.1.0  
**Date**: 2026-05-20  
**Status**: ✅ Ready for testing
