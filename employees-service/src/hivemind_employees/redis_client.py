"""Redis client — shared with hm-core for rate-limit + event dedup."""
from __future__ import annotations

import redis.asyncio as redis
import logging
from typing import Optional

from .config import get_settings

log = logging.getLogger(__name__)

_client: Optional[redis.Redis] = None


async def init_redis() -> redis.Redis:
    global _client
    if _client is not None:
        return _client
    settings = get_settings()
    log.info("Connecting to Redis")
    _client = redis.from_url(
        settings.redis_url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
        max_connections=20,
    )
    try:
        await _client.ping()
    except Exception as e:
        log.warning("Redis ping failed: %s", e)
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None


async def dedup_event(event_id: str, ttl_seconds: int = 86_400) -> bool:
    """Return True if this event_id was seen before (already processed)."""
    r = await init_redis()
    key = f"slack:event:{event_id}"
    # SETNX semantics: NX only sets if not exists; returns 1 if new
    set_result = await r.set(key, "1", ex=ttl_seconds, nx=True)
    return set_result is None  # None means key already existed → dedupe hit
