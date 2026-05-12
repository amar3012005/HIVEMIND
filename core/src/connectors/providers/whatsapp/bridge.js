/**
 * WhatsApp Bridge — outbound messaging via whatsapp-web.js client.
 *
 * Goals:
 * - White-labelled: callers see HIVEMIND, never raw WhatsApp client surface.
 * - Stateless singleton: one client per process (whatsapp-web.js only supports 1).
 * - Called by /api/employees/slack-action (or /api/employees/whatsapp-action).
 *
 * Lifecycle:
 *  1. Control plane POST /api/connectors/whatsapp/qr → spawns client, returns QR
 *  2. Frontend polls GET /api/connectors/whatsapp/status → "paired" when ready
 *  3. Digital Employee tool calls → bridge.sendMessage(...)
 *  4. Control plane POST /api/connectors/whatsapp/disconnect → destroy client
 */

import { EventEmitter } from 'events';

const DEFAULT_TIMEOUT_MS = 15000;

export class WhatsAppBridge extends EventEmitter {
  constructor() {
    super();
    this._client = null;
    this._ready = false;
    this._phoneNumber = null;
    this._qrCode = null;
    this._sessionDir = null;
  }

  async _emitInboundMessage(msg) {
    if (msg.fromMe) {
      return;
    }

    const text = String(msg.body || '').trim();
    if (!text) {
      return;
    }

    let chat = null;
    try {
      chat = await msg.getChat();
    } catch {}

    const chatId = chat?.id?._serialized || msg.from;
    const contactName = chat?.name || msg._data?.notifyName || null;
    const fromNumber = String(msg.from || '').replace(/@c\.us$/, '');

    this.emit('message', {
      id: msg.id?._serialized || null,
      chatId,
      from: msg.from,
      fromNumber,
      text,
      timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
      contactName,
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Start the WhatsApp client in pair-only mode.
   * The QR code is emitted via the 'qr' event.
   * 'ready' fires when the device is fully paired.
   */
  async startPairing(sessionDir) {
    this._sessionDir = sessionDir;

    // Dynamic import — whatsapp-web.js has heavy deps (puppeteer)
    const { Client, LocalAuth } = await import('whatsapp-web.js');

    this._client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionDir }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    });

    this._client.on('qr', (qr) => {
      this._qrCode = qr;
      this.emit('qr', qr);
      console.log('[whatsapp-bridge] QR code ready for scanning');
    });

    this._client.on('ready', () => {
      this._ready = true;
      this._phoneNumber = this._client.info?.wid?.user || null;
      this._qrCode = null;
      this.emit('ready', { phoneNumber: this._phoneNumber });
      console.log('[whatsapp-bridge] Client ready — device paired');
    });

    this._client.on('authenticated', () => {
      console.log('[whatsapp-bridge] Authenticated');
      this.emit('authenticated');
    });

    this._client.on('message', (msg) => {
      this._emitInboundMessage(msg).catch((err) => {
        console.warn('[whatsapp-bridge] inbound message handling failed:', err.message);
      });
    });

    this._client.on('auth_failure', (msg) => {
      console.error('[whatsapp-bridge] Auth failure:', msg);
      this.emit('error', { type: 'auth_failure', message: msg });
    });

    this._client.on('disconnected', (reason) => {
      console.warn('[whatsapp-bridge] Disconnected:', reason);
      this._ready = false;
      this.emit('disconnected', { reason });
    });

    // Start initialization — returns immediately, QR shows later
    this._client.initialize().catch((err) => {
      console.error('[whatsapp-bridge] Init failed:', err.message);
      this.emit('error', { type: 'init_failed', message: err.message });
    });

    return this;
  }

  /**
   * Wait for the client to be ready (pairing complete).
   * Returns a promise that resolves when 'ready' fires or rejects on timeout.
   */
  waitForReady(timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      if (this._ready) return resolve({ phoneNumber: this._phoneNumber });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('WhatsApp pairing timed out'));
      }, timeoutMs);

      const onReady = (info) => { cleanup(); resolve(info); };
      const onError = (err) => { cleanup(); reject(new Error(err.message)); };

      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.off('error', onError);
      };

      this.once('ready', onReady);
      this.once('error', onError);
    });
  }

  /**
   * Get the current QR code (for polling).
   */
  getQrCode() {
    return this._qrCode;
  }

  /**
   * Check if client is paired and ready.
   */
  isReady() {
    return this._ready && this._client !== null;
  }

  getPhoneNumber() {
    return this._phoneNumber;
  }

  // ── Messaging ─────────────────────────────────────────────────

  /**
   * Send a WhatsApp message.
   * @param {string} to - phone number with country code (e.g. "491234567890")
   * @param {string} text - message text
   */
  async sendMessage(to, text) {
    if (!this.isReady()) {
      throw new Error('WhatsApp client not ready');
    }
    const chatId = `${to}@c.us`;
    const chat = await this._client.getChatById(chatId);
    const msg = await chat.sendMessage(text);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
      to: chatId,
    };
  }

  /**
   * Search recent chats.
   */
  async getChats(limit = 20) {
    if (!this.isReady()) {
      throw new Error('WhatsApp client not ready');
    }
    const chats = await this._client.getChats();
    return chats.slice(0, limit).map(c => ({
      id: c.id._serialized,
      name: c.name,
      isGroup: c.isGroup,
      unreadCount: c.unreadCount,
      lastMessage: c.lastMessage?.body?.slice(0, 200) || null,
      timestamp: c.timestamp,
    }));
  }

  /**
   * Get messages from a specific chat.
   */
  async getMessages(chatId, limit = 50) {
    if (!this.isReady()) {
      throw new Error('WhatsApp client not ready');
    }
    const chat = await this._client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    return messages.map(m => ({
      id: m.id._serialized,
      body: m.body,
      from: m.from,
      fromMe: m.fromMe,
      timestamp: m.timestamp,
      hasMedia: m.hasMedia,
    }));
  }

  // ── Cleanup ───────────────────────────────────────────────────

  async disconnect() {
    if (this._client) {
      try {
        await this._client.destroy();
      } catch (err) {
        console.warn('[whatsapp-bridge] destroy failed:', err.message);
      }
      this._client = null;
      this._ready = false;
      this._phoneNumber = null;
      this._qrCode = null;
    }
  }
}
