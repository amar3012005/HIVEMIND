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
import fs from 'fs';
import path from 'path';

const DEFAULT_TIMEOUT_MS = 15000;

export class WhatsAppBridge extends EventEmitter {
  constructor() {
    super();
    this._client = null;
    this._ready = false;
    this._phoneNumber = null;
    this._qrCode = null;
    this._sessionDir = null;
    this._lastError = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._isReconnecting = false;
  }

  hasActiveClient() {
    return this._client !== null;
  }

  getLastError() {
    return this._lastError;
  }

  _emitError(payload) {
    this._lastError = payload;
    if (this.listenerCount('error') > 0) {
      this.emit('error', payload);
    }
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _shouldReconnect(reason) {
    const value = String(reason?.message || reason?.reason || reason || '').toLowerCase();
    return value.includes('515') || value.includes('restart');
  }

  _scheduleReconnect(reason) {
    if (this._isReconnecting || !this._sessionDir) {
      return;
    }
    if (!this._shouldReconnect(reason)) {
      return;
    }

    this._clearReconnectTimer();
    this._isReconnecting = true;
    this._reconnectAttempts += 1;
    const delayMs = Math.min(1000 * this._reconnectAttempts, 5000);

    console.warn(`[whatsapp-bridge] reconnect requested (${String(reason?.message || reason || 'unknown')})`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._restartClient().catch((err) => {
        this._isReconnecting = false;
        this._emitError({ type: 'reconnect_failed', message: err.message });
      });
    }, delayMs);
  }

  async _restartClient() {
    const sessionDir = this._sessionDir;
    await this.disconnect({ preserveSessionDir: true });
    this._isReconnecting = false;
    if (sessionDir) {
      await this.startPairing(sessionDir);
    }
  }

  _normalizePhoneId(rawValue) {
    return String(rawValue || '').replace(/@(c|s)\.us$/, '').replace(/\D/g, '');
  }

  _clearSingletonLocks() {
    if (!this._sessionDir) {
      return;
    }

    for (const baseDir of [this._sessionDir, path.join(this._sessionDir, 'session')]) {
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try {
          fs.rmSync(path.join(baseDir, name), { force: true });
        } catch {}
      }
    }
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
    const fromNumber = this._normalizePhoneId(msg.from);

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
    this._lastError = null;
    this._clearSingletonLocks();

    // Dynamic import — whatsapp-web.js has heavy deps (puppeteer)
    const whatsappModule = await import('whatsapp-web.js');
    const Client = whatsappModule.Client || whatsappModule.default?.Client;
    const LocalAuth = whatsappModule.LocalAuth || whatsappModule.default?.LocalAuth;

    if (!Client || !LocalAuth) {
      throw new Error('whatsapp-web.js exports are unavailable');
    }

    this._client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionDir }),
      puppeteer: {
        headless: true,
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH ||
          (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
        protocolTimeout: 180000,
        timeout: 180000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
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
      this._phoneNumber = this._normalizePhoneId(this._client.info?.wid?.user || null);
      this._qrCode = null;
      this._lastError = null;
      this._reconnectAttempts = 0;
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
      this._emitError({ type: 'auth_failure', message: msg });
    });

    this._client.on('disconnected', (reason) => {
      console.warn('[whatsapp-bridge] Disconnected:', reason);
      this._ready = false;
      this.emit('disconnected', { reason });
      this._scheduleReconnect(reason);
    });

    // Start initialization — returns immediately, QR shows later
    this._client.initialize().catch((err) => {
      console.error('[whatsapp-bridge] Init failed:', err.message);
      this._emitError({ type: 'init_failed', message: err.message });
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

  async disconnect(options = {}) {
    return this._disconnectInternal({
      preserveSessionDir: false,
      ...options,
    });
  }

  async _disconnectInternal({ preserveSessionDir = false } = {}) {
    this._clearReconnectTimer();
    this._isReconnecting = false;
    if (this._client) {
      const client = this._client;
      try {
        await client.destroy();
      } catch (err) {
        console.warn('[whatsapp-bridge] destroy failed:', err.message);
      }

      try {
        const browser = client.pupBrowser;
        if (browser?.isConnected?.()) {
          await browser.close();
        }
      } catch (err) {
        console.warn('[whatsapp-bridge] browser close failed:', err.message);
      }

      this._client = null;
      this._ready = false;
      this._phoneNumber = null;
      this._qrCode = null;
      this._lastError = null;
    }
    if (!preserveSessionDir) {
      this._sessionDir = null;
      this._reconnectAttempts = 0;
    }
  }
}
