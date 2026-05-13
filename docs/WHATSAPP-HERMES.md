# WhatsApp Connector Integration for HIVEMIND

Status: this document is partially outdated for the current HIVEMIND implementation.

The live implementation does not use the Hermes bridge flow described below as its primary path. The current production path is:

- Frontend: [frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx](/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx)
- QR modal: [frontend/Da-vinci/src/components/hivemind/app/pages/WhatsAppQRModal.jsx](/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/pages/WhatsAppQRModal.jsx)
- API client: [frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js](/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js)
- Control plane routes: [core/src/control-plane-server.js](/opt/HIVEMIND/core/src/control-plane-server.js)
- Runtime bridge: [core/src/connectors/providers/whatsapp/bridge.js](/opt/HIVEMIND/core/src/connectors/providers/whatsapp/bridge.js)
- Lifecycle manager: [core/src/connectors/providers/whatsapp/manager.js](/opt/HIVEMIND/core/src/connectors/providers/whatsapp/manager.js)

Current architecture summary:

- The frontend already has a WhatsApp connector tile and a dedicated `WhatsAppQRModal`.
- The frontend calls cookie-authenticated control-plane endpoints through `apiClient.whatsappQr()`, `apiClient.whatsappStatus()`, and `apiClient.whatsappDisconnect()`.
- The backend is Node.js, not Flask, and pairing is handled in the control plane.
- The runtime uses `whatsapp-web.js` with Puppeteer/Chromium and `LocalAuth`, not Hermes `--pair-only` subprocess execution.
- Session state is stored under the configured WhatsApp sessions directory, not `~/.hermes/whatsapp/creds.json`.

Do not use this doc as the source of truth for these areas:

- Flask endpoint examples
- Hermes bridge subprocess examples
- `Authorization: Bearer ${localStorage.getItem(...)}` frontend examples
- `~/.hermes/whatsapp/...` session storage assumptions

Use the code paths above as the source of truth instead.

---

## Current Production Notes

What is already implemented:

- WhatsApp exists in the Connectors page under the `workspace` category.
- QR pairing is opened via `isQrSetup` and rendered by `WhatsAppQRModal`.
- The modal renders the QR value as an SVG QR code with `qrcode.react`.
- The modal polls `/api/connectors/whatsapp/status` every 2 seconds.
- The control plane exposes:
  - `POST /api/connectors/whatsapp/qr`
  - `GET /api/connectors/whatsapp/status`
  - `POST /api/connectors/whatsapp/disconnect`
- The bridge now clears stale Chromium singleton locks and reuses an existing active bridge for the same user to avoid repeated `userDataDir` collisions.

What was wrong in the older plan:

- It assumes WhatsApp still needs to be added to `Connectors.jsx`. It is already there.
- It assumes `WhatsAppQRModal.jsx` still needs to be created. It already exists.
- It assumes API client methods still need to be added. They already exist.
- It assumes the backend should be Flask/Hermes-based. The running backend is Node control-plane plus `whatsapp-web.js`.
- It assumes frontend auth should use a bearer token from local storage. The live frontend uses `axios` with `withCredentials: true` against the control plane session.

If this document is kept, treat the remaining Hermes examples below as historical reference only.

---

## 📋 Architecture Overview

```
User clicks WhatsApp Connector
         ↓
[ConnectorCard "Connect" button]
         ↓
[WhatsAppQRModal opens]
         ↓
Backend calls Hermes WhatsApp bridge in --pair-only mode
         ↓
Bridge generates QR code via qrcode-terminal
         ↓
Backend returns QR as ASCII/SVG to frontend
         ↓
Modal displays QR in real-time
         ↓
User scans with phone
         ↓
Bridge saves session token to ~/.hermes/whatsapp/creds.json
         ↓
Frontend polls for completion
         ↓
Connection confirmed, modal closes
         ↓
Agent "@talktohive" ready in WhatsApp
```

---

## 🔧 Part 1: Frontend Changes

### 1.1 Add WhatsApp to CONNECTORS array

**File: `Connectors.jsx` (add to CONNECTORS array)**

```jsx
// Add this after Slack connector (around line 245):
{
  id: 'whatsapp',
  name: 'WhatsApp',
  description: 'Chat with @talktohive via WhatsApp messages',
  icon: MessageSquare,
  category: 'workspace',  // Messaging Platforms
  status: 'available',
  color: '#25d366',  // WhatsApp green
  priority: 2,
  // WhatsApp uses custom QR-based pairing (not OAuth)
  isQrCodeSetup: true,  // Flag for custom QR modal
  setupTitle: 'Pair WhatsApp with QR Code',
  setupSteps: [
    'Click the QR code below',
    'Open WhatsApp on your phone',
    'Go to Settings → Linked devices → Link a device',
    'Scan the QR code with your phone camera',
    'Wait for pairing confirmation',
  ],
  estimatedTime: '30 seconds',
},
```

### 1.2 Add WhatsApp to category (if not already there)

The connector goes into the existing **'workspace'** category. No new category needed since it's with Slack, Gmail, etc.

---

## 🎨 Part 2: WhatsApp QR Modal Component

**File: `Connectors.jsx` - Add this new modal component before the main export**

```jsx
// ─── WhatsApp QR Code Modal ────────────────────────────────────────────────

function WhatsAppQRModal({ onClose, onSuccess, baseUrl = 'http://localhost:8040' }) {
  const [qrCode, setQrCode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const [paired, setPaired] = useState(false);

  // Fetch QR code on mount
  useEffect(() => {
    const fetchQR = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${baseUrl}/api/connectors/whatsapp/qr`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('hivemind_token')}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to generate QR code');
        }

        const data = await response.json();
        // QR can come as:
        // - ASCII art string (data.qr or data.ascii)
        // - SVG string (data.svg)
        // - Data URL (data.dataUrl)
        setQrCode(data);
        setLoading(false);

        // Start polling for pairing completion
        startPolling();
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    };

    fetchQR();
  }, [baseUrl]);

  // Poll for pairing status every 2 seconds
  const startPolling = () => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`${baseUrl}/api/connectors/whatsapp/status`, {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('hivemind_token')}`,
          },
        });

        const data = await response.json();

        if (data.paired === true || data.status === 'connected') {
          setPaired(true);
          clearInterval(interval);
          // Call success callback after 1 second
          setTimeout(() => {
            onSuccess?.();
            onClose();
          }, 1000);
        }

        setPollCount(prev => prev + 1);

        // Stop polling after 2 minutes (120 seconds)
        if (pollCount > 60) {
          clearInterval(interval);
        }
      } catch (err) {
        // Silent fail on polling, user can retry
        console.error('Polling error:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: '#25d36610', borderColor: '#25d36620' }}
          >
            <MessageSquare size={24} style={{ color: '#25d366' }} />
          </div>
          <div>
            <h2 className="text-[#0a0a0a] text-base font-bold font-['Space_Grotesk']">
              {paired ? '✓ WhatsApp Connected' : 'Pair WhatsApp'}
            </h2>
            <p className="text-[#a3a3a3] text-xs font-['Space_Grotesk']">
              {paired
                ? 'You can now chat with @talktohive'
                : 'Scan the QR code with your phone'}
            </p>
          </div>
        </div>

        {/* Status */}
        {paired && (
          <div className="mb-5 p-3 rounded-lg bg-emerald-50 border border-emerald-200 flex items-start gap-2">
            <CheckCircle2 size={16} className="text-emerald-600 mt-0.5" />
            <div className="text-sm text-emerald-700 font-['Space_Grotesk']">
              <strong>Connected!</strong> Your WhatsApp account is now linked.
            </div>
          </div>
        )}

        {/* QR Code Area */}
        <div className="mb-5">
          {loading && !qrCode && (
            <div className="flex items-center justify-center h-64 bg-[#faf9f4] rounded-xl border border-[#e3e0db]">
              <div className="text-center">
                <RefreshCw size={24} className="text-[#117dff] animate-spin mx-auto mb-2" />
                <p className="text-sm text-[#a3a3a3] font-['Space_Grotesk']">
                  Generating QR code...
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-64 bg-red-50 rounded-xl border border-red-200">
              <div className="text-center">
                <AlertCircle size={24} className="text-[#dc2626] mx-auto mb-2" />
                <p className="text-sm text-[#dc2626] font-['Space_Grotesk']">
                  {error}
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="mt-3 text-xs text-[#117dff] hover:underline font-semibold"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {qrCode && (
            <div className="bg-white rounded-xl border-2 border-[#25d366]/30 p-4 flex items-center justify-center">
              {qrCode.svg ? (
                <div dangerouslySetInnerHTML={{ __html: qrCode.svg }} />
              ) : qrCode.dataUrl ? (
                <img
                  src={qrCode.dataUrl}
                  alt="WhatsApp QR Code"
                  className="w-full max-w-xs"
                />
              ) : qrCode.ascii ? (
                <pre className="text-[10px] leading-tight font-mono text-[#25d366] overflow-auto max-h-64 max-w-full">
                  {qrCode.ascii}
                </pre>
              ) : (
                <p className="text-[#a3a3a3] text-sm">QR code format not supported</p>
              )}
            </div>
          )}
        </div>

        {/* Instructions */}
        {!paired && (
          <div className="mb-5 p-3 rounded-lg bg-[#117dff]/5 border border-[#117dff]/15">
            <ol className="space-y-2 text-xs text-[#525252] font-['Space_Grotesk'] list-decimal pl-4">
              <li>Open <strong>WhatsApp</strong> on your phone</li>
              <li>Go to <strong>Settings → Linked devices</strong></li>
              <li>Tap <strong>Link a device</strong></li>
              <li><strong>Scan this QR code</strong> with your phone camera</li>
              <li>Wait for confirmation (usually 10-30 seconds)</li>
            </ol>
          </div>
        )}

        {/* Timer / Status */}
        {!paired && (
          <div className="mb-5 flex items-center justify-center gap-2 text-xs text-[#a3a3a3] font-mono">
            <Clock size={12} />
            <span>Waiting for device pairing...</span>
            {pollCount > 0 && <span>({pollCount * 2}s elapsed)</span>}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-['Space_Grotesk'] bg-[#f3f1ec] text-[#525252] hover:bg-[#eae7e1] transition-all"
          >
            {paired ? 'Done' : 'Cancel'}
          </button>
          {!paired && (
            <button
              onClick={() => {
                setLoading(true);
                setQrCode(null);
                setError(null);
                setPollCount(0);
                // Trigger QR refresh
                window.location.reload();
              }}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-['Space_Grotesk'] bg-[#117dff] text-white hover:bg-[#0066e0] transition-all flex items-center justify-center gap-2"
            >
              <RefreshCw size={14} />
              New QR
            </button>
          )}
        </div>

        {/* Help text */}
        {!paired && (
          <p className="text-[10px] text-[#d4d0ca] font-['Space_Grotesk'] text-center mt-4">
            QR codes expire after 60 seconds. If nothing happens, click "New QR" to refresh.
          </p>
        )}
      </motion.div>
    </div>
  );
}
```

### 1.3 Update ConnectorCard to handle WhatsApp

**In the `ConnectorCard` component, update the "Connect" button logic:**

```jsx
// Around line 639-651, update the connect button section:

{connector.status === 'available' && !isSetupOnly && (
  <button
    onClick={() => {
      // NEW: Check for WhatsApp QR setup
      if (connector.isQrCodeSetup && connector.id === 'whatsapp') {
        // Open WhatsApp QR modal instead of OAuth flow
        // We'll need to pass a handler to open this modal
        // Add this to the component state management
        onWhatsAppQRClick?.();
        return;
      }
      
      // Existing OAuth flow...
      onConnect();
    }}
    disabled={connecting}
    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold font-['Space_Grotesk'] bg-[#117dff] text-white hover:bg-[#0066e0] disabled:opacity-50 transition-all"
  >
    {connecting ? (
      <RefreshCw size={12} className="animate-spin" />
    ) : (
      <Plus size={12} />
    )}
    {connecting ? 'Connecting...' : 'Connect'}
  </button>
)}
```

### 1.4 Update main Connectors component

**In the main `Connectors` export function, add WhatsApp state and handler:**

```jsx
// Add to state (around line 1170-1180):
const [whatsappQROpen, setWhatsappQROpen] = useState(false);
const [whatsappBackendUrl, setWhatsappBackendUrl] = useState(
  process.env.REACT_APP_BACKEND_URL || 'http://localhost:8040'
);

// Add handler in Connector Card props (around line 1554-1590):
<ConnectorCard
  // ... existing props ...
  onWhatsAppQRClick={() => setWhatsappQROpen(true)}
  // ... rest of props ...
/>

// Add modal to render section (before closing </div>, around line 1676-1685):
{/* WhatsApp QR Modal */}
<AnimatePresence>
  {whatsappQROpen && (
    <WhatsAppQRModal
      baseUrl={whatsappBackendUrl}
      onSuccess={() => {
        setToastMessage({ 
          type: 'success', 
          text: 'WhatsApp connected successfully!' 
        });
        refetchOAuth();
      }}
      onClose={() => setWhatsappQROpen(false)}
    />
  )}
</AnimatePresence>
```

---

## 🔌 Part 3: API Client Updates

**File: `api-client.js` (add these methods)**

```javascript
// WhatsApp QR Code methods
const whatsappConnect = async (options = {}) => {
  return client.post('/api/connectors/whatsapp/qr', options);
};

const whatsappStatus = async () => {
  return client.get('/api/connectors/whatsapp/status');
};

const whatsappDisconnect = async () => {
  return client.post('/api/connectors/whatsapp/disconnect');
};

// Export these methods
export default {
  // ... existing exports ...
  whatsappConnect,
  whatsappStatus,
  whatsappDisconnect,
};
```

---

## 🚀 Part 4: Backend Implementation

### Backend Endpoint Structure

Create these endpoints in your HIVEMIND backend:

#### **POST /api/connectors/whatsapp/qr**
Generates QR code for WhatsApp pairing

```python
# Python Flask example
@app.route('/api/connectors/whatsapp/qr', methods=['POST'])
@require_auth
def whatsapp_qr():
    """
    Start WhatsApp pairing process and return QR code
    Uses Hermes WhatsApp bridge under the hood
    """
    import subprocess
    import json
    from pathlib import Path
    
    try:
        user_id = g.user_id
        session_dir = Path.home() / '.hermes' / 'whatsapp' / 'session'
        session_dir.mkdir(parents=True, exist_ok=True)
        
        # Path to Hermes WhatsApp bridge script
        bridge_script = Path.home() / '.hermes' / 'hermes-agent' / 'scripts' / 'whatsapp-bridge' / 'bridge.js'
        
        # Run bridge in --pair-only mode to get QR
        result = subprocess.run(
            ['node', str(bridge_script), '--pair-only', '--session', str(session_dir)],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        # Parse QR from output or generated file
        qr_ascii = parse_qr_from_output(result.stdout)
        qr_svg = convert_ascii_to_svg(qr_ascii)  # Optional: convert to SVG for better rendering
        
        # Store session info in database
        db.session.save({
            'user_id': user_id,
            'connector': 'whatsapp',
            'status': 'pairing',
            'started_at': datetime.now(),
        })
        
        return jsonify({
            'success': True,
            'ascii': qr_ascii,  # ASCII version for fallback
            'svg': qr_svg,      # SVG version for better rendering
            'session_dir': str(session_dir),
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/connectors/whatsapp/status', methods=['GET'])
@require_auth
def whatsapp_status():
    """
    Check if WhatsApp pairing is complete
    Polls creds.json creation
    """
    import json
    from pathlib import Path
    
    try:
        session_dir = Path.home() / '.hermes' / 'whatsapp' / 'session'
        creds_file = session_dir / 'creds.json'
        
        if creds_file.exists():
            # Pairing complete!
            with open(creds_file, 'r') as f:
                creds = json.load(f)
            
            # Save to database
            user_id = g.user_id
            db.session.save({
                'user_id': user_id,
                'connector': 'whatsapp',
                'status': 'connected',
                'account_ref': f"WhatsApp ({creds.get('me', {}).get('id', 'unknown')})",
                'connected_at': datetime.now(),
            })
            
            return jsonify({
                'paired': True,
                'status': 'connected',
                'account_id': creds.get('me', {}).get('id'),
            })
        else:
            return jsonify({
                'paired': False,
                'status': 'waiting',
            })
            
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/connectors/whatsapp/disconnect', methods=['POST'])
@require_auth
def whatsapp_disconnect():
    """
    Disconnect WhatsApp and remove session
    """
    import shutil
    from pathlib import Path
    
    try:
        session_dir = Path.home() / '.hermes' / 'whatsapp' / 'session'
        
        if session_dir.exists():
            shutil.rmtree(session_dir)
        
        # Update database
        user_id = g.user_id
        db.session.delete_connector(user_id, 'whatsapp')
        
        return jsonify({'success': True})
        
    except Exception as e:
        return jsonify({'error': str(e)}), 400
```

#### **Helper Functions**

```python
def parse_qr_from_output(output: str) -> str:
    """
    Extract QR code ASCII art from Hermes bridge output
    The qrcode-terminal library outputs ASCII QR directly to stdout
    """
    lines = output.split('\n')
    qr_lines = []
    in_qr = False
    
    for line in lines:
        # QR code starts with special characters
        if '█' in line or '▄' in line or '▀' in line:
            in_qr = True
        if in_qr:
            qr_lines.append(line)
            if 'Scan this QR code' in line:
                break
    
    return '\n'.join(qr_lines) if qr_lines else output


def convert_ascii_to_svg(ascii_qr: str) -> str:
    """
    Convert ASCII QR code to SVG for better rendering
    Install: pip install qrcode[pil] pyzbar
    """
    import qrcode
    import io
    import base64
    
    try:
        # ASCII QR is harder to convert; instead regenerate from text
        # This is a simplified approach - in production use qrcode library
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_L,
            box_size=10,
            border=4,
        )
        qr.add_data('whatsapp-session')  # Placeholder; use actual token if available
        qr.make(fit=True)
        
        img = qr.make_image(fill_color='#25d366', back_color='white')
        
        # Convert to base64 data URL
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)
        data_url = 'data:image/png;base64,' + base64.b64encode(buffer.read()).decode()
        
        return data_url
    except:
        return None
```

---

## 🔐 Part 5: Environment Variables

**.env (Frontend)**
```bash
REACT_APP_BACKEND_URL=http://localhost:8040
# Or for production:
# REACT_APP_BACKEND_URL=https://api.yourdomain.com
```

**.env (Backend)**
```bash
HERMES_WHATSAPP_BRIDGE=/path/to/.hermes/hermes-agent/scripts/whatsapp-bridge
HERMES_SESSION_DIR=/path/to/.hermes/whatsapp
```

---

## 🧪 Part 6: Testing Flow

### Manual Test Steps

1. **Frontend**: Navigate to Connectors page
2. **UI**: Click "WhatsApp" connector → "Connect" button
3. **Modal**: WhatsAppQRModal opens with "Generating QR code..."
4. **Backend**: `/api/connectors/whatsapp/qr` endpoint called
5. **Hermes**: Bridge spawns in `--pair-only` mode
6. **QR Display**: ASCII or SVG QR appears in modal
7. **User Action**: Scan QR with phone WhatsApp
8. **Polling**: Frontend polls `/api/connectors/whatsapp/status` every 2s
9. **Completion**: `creds.json` appears, backend returns `paired: true`
10. **Callback**: Modal shows "✓ WhatsApp Connected", then closes
11. **Agent Ready**: "@talktohive" can now receive messages on WhatsApp

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| QR code not appearing | Check backend `/api/connectors/whatsapp/qr` endpoint is running |
| Pairing timeout after 60s | QR codes expire; click "New QR" to refresh |
| `creds.json` not created | Ensure Hermes bridge script path is correct |
| CORS errors | Add `CORS(app)` to Flask backend |
| "Node not found" | Ensure Node.js installed and Hermes bridge dependencies met |

---

## 📦 Database Schema

```sql
-- Add to connectors table
CREATE TABLE IF NOT EXISTS connectors (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    connector_type VARCHAR(50),  -- 'whatsapp', 'slack', etc.
    status VARCHAR(50),           -- 'connected', 'pairing', 'error'
    account_ref TEXT,             -- WhatsApp phone number or ID
    config JSONB,                 -- Session details, credentials ref
    connected_at TIMESTAMP,
    last_sync_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## 🎯 Summary

This integration:
- ✅ Adds WhatsApp connector to Connectors UI
- ✅ Shows QR code popup when user clicks Connect
- ✅ Polls backend for pairing completion
- ✅ Uses Hermes WhatsApp bridge under the hood
- ✅ Handles errors and timeouts gracefully
- ✅ Works with self-hosted backends
- ✅ Categorizes WhatsApp with other messaging platforms

---

## 📝 Next Steps

1. Copy the WhatsAppQRModal component to your Connectors.jsx
2. Add the WhatsApp connector definition to CONNECTORS array
3. Implement backend endpoints using the Python examples
4. Test the flow end-to-end
5. Deploy to production

---

**Created for blaiq Multi-Agent Platform**
