/**
 * WhatsApp QR Lifecycle Manager
 *
 * Per-user WhatsAppBridge instances. One bridge = one WhatsApp Web session.
 * Sessions persist to disk at HIVEMIND_WHATSAPP_SESSIONS_DIR (default: ./data/whatsapp-sessions).
 *
 * Use by control-plane-server.js:
 *   POST /api/connectors/whatsapp/qr          → manager.startPairing(userId, sessionDir)
 *   GET  /api/connectors/whatsapp/status      → { paired, phoneNumber, qr? }
 *   POST /api/connectors/whatsapp/disconnect  → manager.disconnect(userId)
 *   POST /api/employees/whatsapp-action        → manager.sendMessage(userId, to, text)
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const DEFAULT_SESSIONS_DIR = path.join(process.cwd(), 'data', 'whatsapp-sessions');

export class WhatsAppLifecycleManager {
  constructor(sessionsDir = null, options = {}) {
    /** @type {Map<string, import('./bridge.js').WhatsAppBridge>} */
    this._bridges = new Map();
    this._sessionsDir = sessionsDir || DEFAULT_SESSIONS_DIR;
    this._onInboundMessage = typeof options.onInboundMessage === 'function'
      ? options.onInboundMessage
      : null;
    this._histories = new Map();
    fs.mkdirSync(this._sessionsDir, { recursive: true });
  }

  _sessionDirFor(userId) {
    return path.join(this._sessionsDir, userId);
  }

  _historyKey(userId, chatId) {
    return `${userId}:${chatId}`;
  }

  getHistory(userId, chatId) {
    return this._histories.get(this._historyKey(userId, chatId)) || [];
  }

  appendHistory(userId, chatId, role, content) {
    const trimmed = String(content || '').trim();
    if (!trimmed) {
      return;
    }

    const key = this._historyKey(userId, chatId);
    const history = this._histories.get(key) || [];
    history.push({ role, content: trimmed });
    this._histories.set(key, history.slice(-20));
  }

  async _wireBridge(userId, bridge, { replace = false } = {}) {
    if (replace && this._bridges.has(userId)) {
      const current = this._bridges.get(userId);
      if (current && current !== bridge) {
        try {
          await current.disconnect();
        } catch {}
      }
    }

    if (this._onInboundMessage) {
      bridge.on('message', async (event) => {
        this.appendHistory(userId, event.chatId, 'user', event.text);
        try {
          const result = await this._onInboundMessage({
            userId,
            chatId: event.chatId,
            history: this.getHistory(userId, event.chatId),
            event,
          });
          const reply = String(result?.response || '').trim();
          if (!reply) {
            return;
          }

          await bridge.sendMessage(event.fromNumber, reply);
          this.appendHistory(userId, event.chatId, 'assistant', reply);
        } catch (err) {
          console.error(`[whatsapp-manager] inbound reply failed for ${userId}:`, err.message);
        }
      });
    }

    this._bridges.set(userId, bridge);
    return bridge;
  }

  async ensureBridge(userId) {
    const existing = this._bridges.get(userId);
    if (existing) {
      return existing;
    }

    const sessionDir = this._sessionDirFor(userId);
    if (!fs.existsSync(sessionDir)) {
      return null;
    }

    const { WhatsAppBridge } = await import('./bridge.js');
    const bridge = new WhatsAppBridge();
    await bridge.startPairing(sessionDir);
    return this._wireBridge(userId, bridge);
  }

  /**
   * Start QR pairing for a user. Returns the bridge instance so callers
   * can wait for the 'qr' event.
   */
  async startPairing(userId) {
    const existing = this._bridges.get(userId);
    if (existing?.hasActiveClient()) {
      return existing;
    }

    const sessionDir = this._sessionDirFor(userId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { WhatsAppBridge } = await import('./bridge.js');
    const bridge = new WhatsAppBridge();
    await bridge.startPairing(sessionDir);
    return this._wireBridge(userId, bridge, { replace: true });
  }

  /**
   * Get bridge for a user (or null if not paired).
   */
  getBridge(userId) {
    return this._bridges.get(userId) || null;
  }

  /**
   * Poll pairing status for a user.
   * Returns { paired, phoneNumber, qr?, error? }
   */
  async getStatus(userId, { ensureSession = true } = {}) {
    const bridge = ensureSession ? await this.ensureBridge(userId) : this._bridges.get(userId);
    if (!bridge) {
      return { paired: false, phoneNumber: null, error: 'No active pairing session' };
    }
    if (bridge.isReady()) {
      return { paired: true, phoneNumber: bridge.getPhoneNumber() };
    }
    const qr = bridge.getQrCode();
    return { paired: false, phoneNumber: null, qr: qr || null };
  }

  /**
   * Send a message via the user's paired WhatsApp client.
   */
  async sendMessage(userId, to, text) {
    const bridge = this._bridges.get(userId);
    if (!bridge) throw new Error('WhatsApp not connected for user');
    return bridge.sendMessage(to, text);
  }

  /**
   * Get recent chats.
   */
  async getChats(userId, limit) {
    const bridge = this._bridges.get(userId);
    if (!bridge) throw new Error('WhatsApp not connected for user');
    return bridge.getChats(limit);
  }

  /**
   * Get messages from a specific chat.
   */
  async getMessages(userId, chatId, limit) {
    const bridge = this._bridges.get(userId);
    if (!bridge) throw new Error('WhatsApp not connected for user');
    return bridge.getMessages(chatId, limit);
  }

  /**
   * Disconnect and destroy the user's WhatsApp session.
   */
  async disconnect(userId) {
    const bridge = this._bridges.get(userId);
    if (bridge) {
      await bridge.disconnect();
      this._bridges.delete(userId);
    }
    for (const key of [...this._histories.keys()]) {
      if (key.startsWith(`${userId}:`)) {
        this._histories.delete(key);
      }
    }
  }

  /**
   * Disconnect all active sessions (graceful shutdown).
   */
  async shutdown() {
    const ids = [...this._bridges.keys()];
    await Promise.all(ids.map(id => this.disconnect(id)));
  }

  /**
   * List all paired users.
   */
  listPaired() {
    const result = [];
    for (const [userId, bridge] of this._bridges) {
      if (bridge.isReady()) {
        result.push({ userId, phoneNumber: bridge.getPhoneNumber() });
      }
    }
    return result;
  }
}
