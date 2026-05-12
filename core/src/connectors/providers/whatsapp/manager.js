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
  constructor(sessionsDir = null) {
    /** @type {Map<string, import('./bridge.js').WhatsAppBridge>} */
    this._bridges = new Map();
    this._sessionsDir = sessionsDir || DEFAULT_SESSIONS_DIR;
    fs.mkdirSync(this._sessionsDir, { recursive: true });
  }

  /**
   * Start QR pairing for a user. Returns the bridge instance so callers
   * can wait for the 'qr' event.
   */
  async startPairing(userId) {
    // Destroy existing bridge if any
    if (this._bridges.has(userId)) {
      await this.disconnect(userId);
    }

    const sessionDir = path.join(this._sessionsDir, userId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { WhatsAppBridge } = await import('./bridge.js');
    const bridge = new WhatsAppBridge();
    bridge.startPairing(sessionDir);
    this._bridges.set(userId, bridge);
    return bridge;
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
  getStatus(userId) {
    const bridge = this._bridges.get(userId);
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
