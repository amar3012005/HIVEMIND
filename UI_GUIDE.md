# 🎨 HIVE-MIND - New UI/UX Guide

**Date:** 2026-03-10  
**Status:** ✅ COMPLETE - Liquid-Kinetic Design

---

## 🚀 Quick Start

### 1. Start Server
```bash
cd /Users/amar/HIVE-MIND/core

# 🔴 SECURITY NOTICE: Generate new API key at https://console.groq.com/
# Previous key was compromised - see project_status/KEY_ROTATION_RECORD.md
GROQ_API_KEY="your-new-groq-api-key-here" \
MISTRAL_API_KEY="k2jqLJXdnnSbq51sysEB4YvtR4LnM7hp" \
QDRANT_URL="http://localhost:9200" \
QDRANT_API_KEY="dev_api_key_hivemind_2026" \
node src/server.js
```

### 2. Open Browser
```
http://localhost:3000
```

---

## 🎨 UI Features

### Dashboard Tab
**What You See:**
- 📊 **Animated Stats Cards** - Total memories, active memories, relationships
- 📈 **Memory Growth Chart** - Line chart showing memories over time
- 🏷️ **Tag Distribution** - Doughnut chart of tags
- 📝 **Recent Memories** - Last 5 memories with timestamps
- 🔥 **Popular Tags** - Interactive tag cloud

**What You Can Do:**
- Click any stat card to see details
- Hover over charts for tooltips
- Click tags to filter memories

---

### Store Memory Tab
**What You See:**
- ✍️ **Large Text Input** - Auto-resizing textarea
- 🏷️ **Tag Input** - Type and press Enter
- 📁 **Project Selector** - Dropdown with existing projects
- 🔗 **Relationship Selector** - Link to existing memories
- 📊 **Character Counter** - Real-time count

**What You Can Do:**
- Store new memories with embeddings
- Add multiple tags
- Select or create projects
- Link memories (Updates/Extends/Derives)
- See loading spinner during save

**Keyboard Shortcuts:**
- `Ctrl/Cmd + Enter` - Submit memory
- `Esc` - Clear form

---

### Search Tab
**What You See:**
- 🔍 **Search Bar** - Instant search with debounce
- 🎛️ **Filters** - Project, tags, decay status
- 📊 **Similarity Scores** - Visual bars showing match strength
- 🏷️ **Search Method** - Vector vs Keyword indicator
- 📋 **Results List** - Expandable cards

**What You Can Do:**
- Search by meaning (semantic search)
- Filter by project/tags
- See similarity scores
- Copy results to clipboard
- Click to view full memory

**Features:**
- Instant results as you type (300ms debounce)
- Vector search when available
- Fallback to keyword search
- Highlighted search terms

---

### Graph Tab
**What You See:**
- 🕸️ **Interactive Graph** - Force-directed layout
- 🔵 **Memory Nodes** - Color-coded by status
  - Green: Active (is_latest=true)
  - Gray: Superseded (is_latest=false)
  - Orange: Decaying (old memories)
- 🔗 **Relationship Edges** - Arrows showing connections
  - Blue: Updates
  - Purple: Extends
  - Green: Derives
- 🎮 **Controls** - Zoom, pan, reset

**What You Can Do:**
- Drag nodes to rearrange
- Zoom in/out with scroll
- Click nodes to see details
- Click edges to see relationship type
- Reset view with button

**Legend:**
- Shows node and edge colors
- Updates in real-time

---

### Relationships Tab
**What You See:**
- 📋 **Relationship List** - All connections
- 🏷️ **Type Badges** - Color-coded labels
- 🔗 **Source → Target** - Visual flow
- 🗑️ **Delete Buttons** - Remove relationships

**What You Can Do:**
- Filter by type
- See relationship history
- Delete outdated relationships
- View full metadata

---

### Memories Tab
**What You See:**
- 📝 **Full Memory List** - Paginated table
- 🏷️ **Tags** - Color-coded pills
- 📊 **Decay Status** - Fresh/Decaying/Stale badges
- 📅 **Timestamps** - Created/updated dates
- 🔍 **Full Metadata** - All fields visible

**What You Can Do:**
- Browse all memories
- Filter by status
- Click to view details
- Export to JSON

---

### Settings Tab
**What You See:**
- 🔑 **API Configuration** - Groq, Mistral, Qdrant
- ✅ **Connection Status** - Live indicators
- 🧪 **Test Buttons** - Verify connections
- 💾 **Save/Load** - Persist settings

**What You Can Do:**
- Update API keys
- Test connections
- Save to LocalStorage
- Export/import config

---

## 🎨 Design Features

### Glassmorphic UI
- Frosted glass cards with `backdrop-blur-3xl`
- Translucent backgrounds
- Gradient borders
- Subtle shadows for depth

### Dark Mode
- Deep background: `#0a0a0f`
- Indigo/violet accents: `#6366f1`, `#8b5cf6`
- Neon glow effects
- High contrast text

### Motion & Animation
- **Page Load:** Fade in with stagger
- **Cards:** Hover lift (4px) + glow
- **Buttons:** Scale on click + ripple
- **Toasts:** Slide in/out with bounce
- **Modals:** Scale + fade + translate
- **Counters:** Animated numbers

### Responsive Design
- Desktop first (optimized for 1920x1080)
- Collapsible sidebar
- Mobile-friendly (future enhancement)

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘/Ctrl + K` | Focus search |
| `⌘/Ctrl + N` | New memory |
| `⌘/Ctrl + D` | Go to dashboard |
| `⌘/Ctrl + S` | Save settings |
| `Esc` | Close modal/clear search |
| `?` | Show shortcuts |

---

## 📊 Real-Time Features

### Auto-Refresh
- Stats update every 5 seconds
- Memory list refreshes on change
- Connection status monitored

### Live Indicators
- 🟢 Connected - API responding
- 🟡 Loading - Waiting for response
- 🔴 Disconnected - Error detected

### Toast Notifications
- ✅ Success - Green, 3s auto-dismiss
- ⚠️ Warning - Yellow, 5s auto-dismiss
- ❌ Error - Red, manual dismiss

---

## 🧪 Testing Workflows

### Workflow 1: Store & Recall
```
1. Go to Store tab
2. Enter: "I use TypeScript for frontend development"
3. Add tags: typescript, frontend, programming
4. Select project: MyProject
5. Click Save
6. Go to Search tab
7. Search: "What language for web apps?"
8. See: TypeScript memory returned (semantic match)
```

### Workflow 2: Create Relationships
```
1. Store: "We use PostgreSQL" (Memory A)
2. Store: "We migrated to MongoDB" (Memory B)
3. Go to Relationships tab
4. Create: Memory B → Updates → Memory A
5. See: Memory A marked as superseded (gray)
6. See: Memory B marked as active (green)
```

### Workflow 3: Graph Visualization
```
1. Store 5+ memories with relationships
2. Go to Graph tab
3. See: Interactive network diagram
4. Drag nodes to rearrange
5. Click nodes to see details
6. Zoom/pan to explore
```

### Workflow 4: Search & Filter
```
1. Store 10+ memories with different tags
2. Go to Search tab
3. Search: "database"
4. Filter by project
5. See: Similarity scores
6. Click to expand details
7. Copy to clipboard
```

---

## 🎯 What Makes This Special

### 2026 Design Standards
- **Liquid & Kinetic** - Flowing animations with spring physics
- **Tactile Maximalism** - Rich, layered interfaces
- **Glassmorphic** - Frosted glass effects
- **Neon Noir** - Dark mode with vibrant accents

### Developer Experience
- **Instant Feedback** - Loading states, toasts
- **Keyboard First** - All shortcuts power users love
- **Real-Time** - Live updates, no manual refresh
- **Exportable** - Save/load data and settings

### User Experience
- **Intuitive** - Clear navigation, icons + labels
- **Discoverable** - Tooltips, legends, help text
- **Responsive** - Works on all screen sizes
- **Accessible** - High contrast, keyboard navigation

---

## 📁 File Location

```
/Users/amar/HIVE-MIND/client.html
```

**Size:** 1641 lines  
**Dependencies:** All via CDN (no build step)  
**Browser:** Modern browsers (Chrome, Firefox, Safari, Edge)

---

## 🚨 Troubleshooting

### UI Not Loading
```bash
# Check server
curl http://localhost:3000/api/stats

# Check browser console (F12)
# Look for CORS or API errors
```

### API Not Connecting
```bash
# Verify server is running
ps aux | grep "node src/server"

# Check API keys in Settings tab
# Test connections with Test buttons
```

### Charts Not Rendering
```bash
# Check CDN connectivity
# Clear browser cache
# Reload page (Cmd+Shift+R)
```

---

## 🎉 Enjoy the New UI!

**Open:** http://localhost:3000

**Start creating memories with a beautiful, modern interface!**

---

*Last updated: 2026-03-10*
