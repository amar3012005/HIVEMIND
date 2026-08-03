import { EventEmitter } from 'node:events';
import Redis from 'ioredis';

const CHANNEL_PREFIX = 'hq-runtime:event:';
const local = new EventEmitter();
local.setMaxListeners(0);

let publisher = null;
let subscriber = null;
let subscriberReady = null;
const listeners = new Map();

function redisUrl() {
  return process.env.HIVEMIND_CONTROL_PLANE_REDIS_URL || process.env.REDIS_URL || '';
}

function channel(runtimeId) {
  return `${CHANNEL_PREFIX}${runtimeId}`;
}

function redisClient(role) {
  const url = redisUrl();
  if (!url) return null;
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_500,
    maxRetriesPerRequest: role === 'subscriber' ? null : 1,
    enableReadyCheck: true,
  });
  client.on('error', (error) => {
    if (process.env.NODE_ENV !== 'test') console.warn(`[hq-runtime] Redis ${role} unavailable:`, error.message);
  });
  return client;
}

async function ensurePublisher() {
  if (!publisher) publisher = redisClient('publisher');
  if (!publisher) return null;
  if (publisher.status === 'wait') await publisher.connect();
  return publisher;
}

async function ensureSubscriber() {
  if (subscriberReady) return subscriberReady;
  subscriberReady = (async () => {
    if (!subscriber) {
      subscriber = redisClient('subscriber');
      if (!subscriber) return null;
      subscriber.on('message', (name, payload) => {
        let event;
        try { event = JSON.parse(payload); } catch { return; }
        for (const listener of listeners.get(name) || []) listener(event);
      });
    }
    if (subscriber.status === 'wait') await subscriber.connect();
    return subscriber;
  })().catch((error) => {
    subscriberReady = null;
    throw error;
  });
  return subscriberReady;
}

export async function publishHqRuntimeEvent(event) {
  if (!event?.runtimeId || event.sequence == null) return;
  const payload = {
    runtime_id: String(event.runtimeId),
    org_id: String(event.orgId || ''),
    sequence: String(event.sequence),
    event: {
      ...event,
      sequence: String(event.sequence),
      createdAt: event.createdAt?.toISOString?.() || event.createdAt,
    },
  };
  local.emit(channel(event.runtimeId), payload);
  const client = await ensurePublisher().catch(() => null);
  if (client) await client.publish(channel(event.runtimeId), JSON.stringify(payload)).catch(() => {});
}

export async function subscribeHqRuntimeEvents(runtimeId, listener) {
  const name = channel(runtimeId);
  local.on(name, listener);
  let remote = false;
  const client = await ensureSubscriber().catch(() => null);
  if (client) {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
      await client.subscribe(name);
    }
    set.add(listener);
    remote = true;
  }
  return async () => {
    local.off(name, listener);
    if (!remote || !subscriber) return;
    const set = listeners.get(name);
    set?.delete(listener);
    if (set?.size) return;
    listeners.delete(name);
    await subscriber.unsubscribe(name).catch(() => {});
  };
}

export async function closeHqRuntimeEventBus() {
  const clients = [publisher, subscriber].filter(Boolean);
  publisher = null;
  subscriber = null;
  subscriberReady = null;
  listeners.clear();
  local.removeAllListeners();
  await Promise.allSettled(clients.map((client) => client.quit()));
}
