import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';

import { getCentralPrismaClient } from '../db/prisma.js';

const { Client, Pool } = pg;
const NOTIFY_CHANNEL = 'hq_runtime_events';
const instanceId = crypto.randomUUID();
const local = new EventEmitter();
local.setMaxListeners(0);

let publisher = null;
let subscriber = null;
let subscriberReady = null;
let reconnectTimer = null;
let closing = false;

function databaseUrl() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const key of ['connection_limit', 'pool_timeout', 'socket_timeout']) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return raw;
  }
}

function runtimeChannel(runtimeId) {
  return `runtime:${runtimeId}`;
}

function serializedEvent(event) {
  return {
    runtime_id: String(event.runtimeId),
    org_id: String(event.orgId || ''),
    sequence: String(event.sequence),
    event: {
      ...event,
      sequence: String(event.sequence),
      createdAt: event.createdAt?.toISOString?.() || event.createdAt,
    },
  };
}

async function resolvePersistedEvent(runtimeId, sequence) {
  const prisma = getCentralPrismaClient();
  if (!prisma) return null;
  const row = await prisma.hqRuntimeEvent.findFirst({
    where: { runtimeId, sequence: BigInt(sequence) },
  }).catch(() => null);
  return row ? serializedEvent(row) : null;
}

async function handleNotification(message) {
  let notice;
  try { notice = JSON.parse(message.payload || '{}'); } catch { return; }
  if (!notice.runtime_id || notice.instance_id === instanceId) return;
  if (notice.transient === true && notice.event) {
    local.emit(runtimeChannel(String(notice.runtime_id)), notice);
    return;
  }
  if (notice.sequence == null) return;
  const payload = await resolvePersistedEvent(String(notice.runtime_id), String(notice.sequence));
  if (payload) local.emit(runtimeChannel(payload.runtime_id), payload);
}

function scheduleReconnect() {
  if (closing || reconnectTimer || !databaseUrl()) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    subscriberReady = null;
    subscriber = null;
    ensureSubscriber().catch(() => scheduleReconnect());
  }, 1_000);
  reconnectTimer.unref?.();
}

async function ensureSubscriber() {
  if (subscriberReady) return subscriberReady;
  if (!databaseUrl()) return null;
  subscriberReady = (async () => {
    const client = new Client({ connectionString: databaseUrl(), application_name: 'hq-runtime-events-listener' });
    client.on('notification', (message) => {
      if (message.channel === NOTIFY_CHANNEL) handleNotification(message).catch(() => {});
    });
    client.on('error', (error) => {
      if (!closing && process.env.NODE_ENV !== 'test') console.warn('[hq-runtime] PostgreSQL event listener unavailable:', error.message);
      scheduleReconnect();
    });
    client.on('end', () => scheduleReconnect());
    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    subscriber = client;
    return client;
  })().catch((error) => {
    subscriberReady = null;
    if (process.env.NODE_ENV !== 'test') console.warn('[hq-runtime] PostgreSQL event listener failed:', error.message);
    scheduleReconnect();
    return null;
  });
  return subscriberReady;
}

function ensurePublisher() {
  if (!publisher && databaseUrl()) {
    publisher = new Pool({
      connectionString: databaseUrl(),
      max: 2,
      idleTimeoutMillis: 30_000,
      application_name: 'hq-runtime-events-publisher',
    });
    publisher.on('error', (error) => {
      if (process.env.NODE_ENV !== 'test') console.warn('[hq-runtime] PostgreSQL event publisher unavailable:', error.message);
    });
  }
  return publisher;
}

export async function publishHqRuntimeEvent(event) {
  if (!event?.runtimeId || event.sequence == null) return;
  const payload = serializedEvent(event);
  local.emit(runtimeChannel(event.runtimeId), payload);
  const pool = ensurePublisher();
  if (!pool) return;
  await pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, JSON.stringify({
    instance_id: instanceId,
    runtime_id: payload.runtime_id,
    sequence: payload.sequence,
  })]).catch(() => {});
}

export async function publishHqRuntimeTransient({ runtimeId, orgId, event }) {
  if (!runtimeId || !event) return;
  const payload = {
    instance_id: instanceId,
    transient: true,
    runtime_id: String(runtimeId),
    org_id: String(orgId || ''),
    event: { ...event, transient: true },
  };
  local.emit(runtimeChannel(String(runtimeId)), payload);
  const pool = ensurePublisher();
  if (!pool) return;
  await pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, JSON.stringify(payload)]).catch(() => {});
}

export async function subscribeHqRuntimeEvents(runtimeId, listener) {
  const name = runtimeChannel(runtimeId);
  local.on(name, listener);
  await ensureSubscriber();
  return async () => local.off(name, listener);
}

export async function closeHqRuntimeEventBus() {
  closing = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  local.removeAllListeners();
  const clients = [subscriber?.end?.(), publisher?.end?.()].filter(Boolean);
  subscriber = null;
  publisher = null;
  subscriberReady = null;
  await Promise.allSettled(clients);
  closing = false;
}
