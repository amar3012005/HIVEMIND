"""
Cartesia WebSocket Manager

Robust, persistent WebSocket connection manager for Cartesia TTS API.
Features:
- Connection pooling with pre-warming
- Automatic reconnection with exponential backoff
- context_id management for prosody continuity
- Never disconnects mid-session
"""

import asyncio
import json
import base64
import logging
import re
import time
import uuid
from typing import Optional, Callable, Dict, Any, AsyncGenerator, Union, List
from dataclasses import dataclass, field
from enum import Enum

import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException
from websockets.protocol import State

from .config import CartesiaConfig

logger = logging.getLogger(__name__)


class ConnectionState(Enum):
    """WebSocket connection states"""
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    STREAMING = "streaming"
    RECONNECTING = "reconnecting"
    FAILED = "failed"


@dataclass
class ConnectionMetrics:
    """Track connection health and performance"""
    connect_time: Optional[float] = None
    last_activity: float = field(default_factory=time.time)
    messages_sent: int = 0
    messages_received: int = 0
    reconnect_count: int = 0
    total_audio_bytes: int = 0
    first_chunk_latency_ms: Optional[float] = None


class CartesiaConnection:
    """
    Single managed persistent WebSocket connection to Cartesia with dispatcher.
    
    Handles:
    - Persistent background connection monitor
    - Automatic reconnection with exponential backoff
    - context_id multiplexing/dispatching
    - Health monitoring
    """
    
    def __init__(self, config: CartesiaConfig, connection_id: str):
        self.config = config
        self.connection_id = connection_id
        self.ws: Optional[websockets.ClientConnection] = None
        self.state = ConnectionState.DISCONNECTED
        self.metrics = ConnectionMetrics()
        self._lock = asyncio.Lock()
        self._monitor_task: Optional[asyncio.Task] = None
        self._connected_event = asyncio.Event()
        self._dispatch_queues: Dict[str, asyncio.Queue] = {}
        self._dispatch_lock = asyncio.Lock()
        self.is_busy = False # Still used by Manager for load balancing
    
    async def connect(self) -> bool:
        """Initialize monitor task and wait for connection"""
        async with self._lock:
            if self._monitor_task is None or self._monitor_task.done():
                logger.info(f"[{self.connection_id}] Starting persistent connection monitor...")
                self._monitor_task = asyncio.create_task(self._monitor_loop())
        
        try:
            # Wait for initial connection (up to 10s)
            await asyncio.wait_for(self._connected_event.wait(), timeout=10.0)
            return True
        except asyncio.TimeoutError:
            logger.warning(f"[{self.connection_id}] Initial connection timed out, monitor will continue retrying")
            return False
    
    async def _monitor_loop(self):
        """Background task to keep connection alive and dispatch messages"""
        backoff = self.config.reconnect_base_delay_ms / 1000.0
        max_backoff = 30.0

        while True:
            try:
                # Build WebSocket URL without API key in query string
                ws_url = self.config.websocket_url + f"?cartesia_version={self.config.api_version}"
                self.state = ConnectionState.CONNECTING

                # Add API key via Authorization header instead of URL parameter
                extra_headers = {
                    "Authorization": f"Bearer {self.config.api_key}",
                    "User-Agent": "CartesiaPythonClient/1.0"
                }

                logger.debug(f"[{self.connection_id}] Connecting to {self.config.websocket_url}...")

                async with websockets.connect(
                    ws_url,
                    extra_headers=extra_headers,
                    ping_interval=self.config.ping_interval_seconds,
                    ping_timeout=self.config.ping_timeout_seconds,
                    max_size=10_000_000,
                    close_timeout=5
                ) as ws:
                    self.ws = ws
                    self.state = ConnectionState.CONNECTED
                    self._connected_event.set()
                    self.metrics.connect_time = time.time()
                    self.metrics.last_activity = time.time()
                    backoff = self.config.reconnect_base_delay_ms / 1000.0
                    
                    logger.info(f"✅ [{self.connection_id}] Persistent WebSocket established")
                    
                    # Message loop
                    async for message in ws:
                        self.metrics.messages_received += 1
                        self.metrics.last_activity = time.time()

                        try:
                            data = json.loads(message)
                            ctx_id = data.get("context_id")
                            msg_type = data.get("type", "unknown")
                            if ctx_id:
                                async with self._dispatch_lock:
                                    queue = self._dispatch_queues.get(ctx_id)
                                    registered_ids = list(self._dispatch_queues.keys())
                                if queue:
                                    await queue.put(data)
                                else:
                                    logger.warning(f"[{self.connection_id}] ⚠️ No queue for ctx={ctx_id[:8]} type={msg_type} (registered: {[k[:8] for k in registered_ids]})")
                            else:
                                logger.warning(f"[{self.connection_id}] ⚠️ Message without context_id: type={msg_type}")
                        except Exception as e:
                            logger.error(f"[{self.connection_id}] Dispatch error: {e}", exc_info=True)
                
                # If we exit the loop normally, ws was closed
                logger.warning(f"[{self.connection_id}] Connection closed by server")
                
            except Exception as e:
                logger.warning(f"[{self.connection_id}] Connection error: {e}")
            
            # Reset state and retry
            self.metrics.reconnect_count += 1
            self.state = ConnectionState.DISCONNECTED
            self._connected_event.clear()
            self.ws = None
            
            logger.info(f"[{self.connection_id}] Reconnecting in {backoff:.1f}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)

    async def disconnect(self):
        """Shutdown monitor and close connection"""
        async with self._lock:
            if self._monitor_task:
                self._monitor_task.cancel()
                self._monitor_task = None
            
            if self.ws:
                try:
                    await self.ws.close()
                except Exception:
                    pass
                self.ws = None
            
            self.state = ConnectionState.DISCONNECTED
            self._connected_event.clear()
            logger.info(f"[{self.connection_id}] Persistent connection stopped")
    
    async def ensure_connected(self) -> bool:
        """Wait for connection to be ready"""
        if self.state == ConnectionState.CONNECTED:
            return True
        
        try:
            await asyncio.wait_for(self._connected_event.wait(), timeout=5.0)
            return True
        except asyncio.TimeoutError:
            return False
    
    async def send(self, data: Dict[str, Any]):
        """Send message over the connection"""
        if self.ws and self.state == ConnectionState.CONNECTED:
            await self.ws.send(json.dumps(data))
            self.metrics.messages_sent += 1
        else:
            # Wait briefly for reconnection
            if await self.ensure_connected():
                await self.ws.send(json.dumps(data))
                self.metrics.messages_sent += 1
            else:
                raise ConnectionError(f"[{self.connection_id}] Cannot send: Connection unavailable")

    def is_available(self) -> bool:
        """Check if connection is alive and ready for work"""
        return (
            self.state == ConnectionState.CONNECTED and
            self._connected_event.is_set() and
            not self.is_busy
        )


class CartesiaManager:
    """
    High-level manager for Cartesia TTS streaming.
    
    Features:
    - Connection pool for concurrent sessions
    - Robust error handling and reconnection
    - context_id tracking for prosody continuity
    - Never drops mid-session
    """
    
    def __init__(self, config: CartesiaConfig):
        self.config = config
        self._connections: List[CartesiaConnection] = []
        self._connection_lock = asyncio.Lock()
        self._is_warmed = False
    
    async def warmup(self):
        """Pre-warm connection pool"""
        if self._is_warmed:
            return
        
        logger.info(f"🔥 Warming up {self.config.pool_size} Cartesia connections...")
        
        async with self._connection_lock:
            for i in range(self.config.pool_size):
                conn = CartesiaConnection(self.config, f"pool-{i}")
                if await conn.connect():
                    self._connections.append(conn)
                else:
                    logger.warning(f"Failed to warm connection pool-{i}")
        
        self._is_warmed = True
        logger.info(f"✅ Warmed {len(self._connections)} connections")
    
    async def get_connection(self) -> Optional[CartesiaConnection]:
        """Get an available connection from the pool"""
        async with self._connection_lock:
            # Find available connection
            for conn in self._connections:
                if conn.is_available():
                    return conn
            
            # All connections busy, create a new one
            if len(self._connections) < self.config.pool_size * 2:  # Allow 2x pool size
                conn = CartesiaConnection(self.config, f"dynamic-{len(self._connections)}")
                if await conn.connect():
                    self._connections.append(conn)
                    return conn
            
            # Wait briefly for a connection to become available
            await asyncio.sleep(0.1)
            for conn in self._connections:
                if conn.is_available():
                    return conn
            
            return None
    
    async def stream_text_to_audio(
        self,
        text_iterator: Union[AsyncGenerator[str, None], List[str], str],
        audio_callback: Callable[[bytes, int, Dict[str, Any]], Any],
        context_id: Optional[str] = None,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
        model_id: Optional[str] = None,
        pronunciation_dict_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Stream text to audio using multiplexed persistent connections.
        """
        # Normalize text iterator
        if isinstance(text_iterator, str):
            async def _str_gen():
                yield text_iterator
            text_iter = _str_gen()
        elif isinstance(text_iterator, list):
            async def _list_gen():
                for item in text_iterator:
                    yield item
            text_iter = _list_gen()
        else:
            text_iter = text_iterator
        
        # Get connection
        conn = await self.get_connection()
        if not conn:
            logger.error("No connection available")
            return {"error": "No connection available"}
        
        # Ensure connected
        if not await conn.ensure_connected():
            return {"error": "Failed to connect"}
        
        # Mark as busy during this stream (for load balancing)
        conn.is_busy = True
        
        # Use provided context_id or generate new one
        ctx_id = context_id or str(uuid.uuid4())
        
        # Register dispatcher queue. Reuse an existing queue if one was
        # pre-registered for this context so external dispatchers/tests can
        # attach before stream startup without being overwritten.
        async with conn._dispatch_lock:
            queue = conn._dispatch_queues.get(ctx_id)
            if queue is None:
                queue = asyncio.Queue()
                conn._dispatch_queues[ctx_id] = queue
            
        try:
            # Stats tracking
            stats = {
                "chunks_received": 0,
                "total_audio_bytes": 0,
                "first_chunk_latency_ms": None,
                "total_time_ms": 0,
                "context_id": ctx_id,
            }
            start_time = time.time()
            first_chunk_time: Optional[float] = None
            stream_start_time: Optional[float] = None
            
            # Shared state
            send_complete = asyncio.Event()
            receive_error: Optional[str] = None
            
            # Cartesia Sonic 3 only supports 5 SSML emotion values.
            # Map LLM-generated emotion names to valid Cartesia values.
            CARTESIA_EMOTION_MAP = {
                # Direct matches
                "angry": "angry",
                "sad": "sad",
                "curious": "curious",
                "surprised": "surprised",
                "positive": "positive",
                # LLM emotion → closest Cartesia emotion
                "content": "positive",
                "enthusiastic": "positive",
                "excited": "surprised",
                "sympathetic": "sad",
                "determined": "positive",
                "calm": None,           # no Cartesia equivalent — strip tag
                "joking/comedic": "positive",
                "neutral": None,        # no Cartesia equivalent — strip tag
                "anxious": "sad",
                "proud": "positive",
                "nostalgic": "sad",
                "confused": "curious",
            }

            async def send_text():
                """Send text chunks to Cartesia via multiplexed connection"""
                nonlocal stream_start_time
                try:
                    sent_chunks = 0
                    pending_chunk: Optional[str] = None

                    async def send_chunk(clean_text: str, is_final: bool) -> None:
                        nonlocal stream_start_time, sent_chunks
                        target_model = model_id or self.config.model

                        # Build base message
                        message = {
                            "context_id": ctx_id,
                            "model_id": target_model,
                            "transcript": clean_text,
                            "voice": (voice_id and len(voice_id.strip()) > 0) and {"mode": "id", "id": voice_id} or self.config.get_voice_config(),
                            "output_format": self.config.get_output_format_config(),
                            # Cartesia expects every chunk that will be followed by
                            # more input to set continue=true. Only the final chunk
                            # of the turn should close the context.
                            "continue": not is_final,
                        }

                        # CRITICAL: Always send language parameter for correct phonology
                        # Cartesia Sonic-3 auto-detects but defaults to English without explicit language
                        raw_lang = language or self.config.language
                        if raw_lang:
                            # Normalize language code: "de-DE" → "de", "en_US" → "en"
                            message["language"] = raw_lang.split("-")[0].split("_")[0]
                            logger.debug(f"[{ctx_id[:8]}] Language: {message['language']}")

                        # Add speed control (0.9 recommended for German compound words)
                        if hasattr(self.config, 'speed') and self.config.speed:
                            message["speed"] = self.config.speed

                        if hasattr(self.config, 'max_buffer_delay_ms') and self.config.max_buffer_delay_ms is not None:
                            message["max_buffer_delay_ms"] = int(self.config.max_buffer_delay_ms)

                        # Add pronunciation dictionary for tenant-specific brand names
                        dict_id = pronunciation_dict_id or getattr(self.config, 'pronunciation_dict_id', None)
                        if dict_id and dict_id.strip().strip('"').strip("'"):
                            clean_dict_id = dict_id.strip().strip('"').strip("'")
                            if clean_dict_id.startswith("pdict_"):
                                message["pronunciation_dict_id"] = clean_dict_id
                                logger.debug(f"[{ctx_id[:8]}] Pronunciation dict: {clean_dict_id}")
                            else:
                                logger.warning(f"[{ctx_id[:8]}] Ignoring invalid pronunciation_dict_id: '{dict_id}'")

                        if stream_start_time is None:
                            logger.info(f"[{ctx_id[:8]}] Sending first chunk: {clean_text[:30]}...")
                            stream_start_time = time.time()

                        await conn.send(message)
                        sent_chunks += 1

                    async for text_chunk in text_iter:
                        if not text_chunk or not text_chunk.strip():
                            continue

                        # Cartesia Sonic 3 strictly rejects newlines paired with XML tags
                        clean_text = text_chunk.replace('\n', ' ').replace('\r', ' ')

                        # Map LLM emotion tags to valid Cartesia SSML emotion values.
                        # Invalid values cause Cartesia to silently return 0 audio chunks.
                        emotion_match = re.search(r'<emotion\s+value="([^"]+)"\s*/>', clean_text)
                        if emotion_match:
                            raw_emotion = emotion_match.group(1).lower().strip()
                            mapped = CARTESIA_EMOTION_MAP.get(raw_emotion)
                            if mapped:
                                # Replace with valid Cartesia emotion tag
                                clean_text = re.sub(
                                    r'<emotion\s+value="[^"]+"\s*/>',
                                    f'<emotion value="{mapped}" />',
                                    clean_text
                                )
                                logger.info(f"[{ctx_id[:8]}] Mapped emotion '{raw_emotion}' → '{mapped}'")
                            else:
                                # No valid mapping — strip the tag entirely
                                clean_text = re.sub(r'<emotion\s+value="[^"]+"\s*/>', '', clean_text).strip()
                                logger.info(f"[{ctx_id[:8]}] Stripped unsupported emotion '{raw_emotion}'")

                        # Skip if only whitespace/tags remain after processing
                        text_without_tags = re.sub(r'<[^>]+/?>', '', clean_text).strip()
                        if not text_without_tags:
                            logger.debug(f"[{ctx_id[:8]}] Skipping chunk with no speakable text")
                            continue

                        if pending_chunk is not None:
                            await send_chunk(pending_chunk, is_final=False)

                        pending_chunk = clean_text
                    if pending_chunk is not None:
                        await send_chunk(pending_chunk, is_final=True)

                    logger.info(f"[{ctx_id[:8]}] ✅ All text sent, waiting for audio chunks...")

                except Exception as e:
                    logger.error(f"[{ctx_id[:8]}] Send error: {e}", exc_info=True)
                finally:
                    logger.info(f"[{ctx_id[:8]}] Send complete, setting send_complete event")
                    send_complete.set()
            
            async def receive_audio():
                """Consume audio chunks from dispatcher queue"""
                nonlocal first_chunk_time, receive_error
                try:
                    logger.info(f"[{ctx_id[:8]}] Starting audio receive loop (waiting for Cartesia chunks)...")
                    provisional_error: Optional[str] = None
                    while True:
                        try:
                            # Wait for message from dispatcher
                            logger.debug(f"[{ctx_id[:8]}] Waiting for message from queue...")
                            data = await asyncio.wait_for(queue.get(), timeout=10.0)
                            logger.debug(f"[{ctx_id[:8]}] Received message type: {data.get('type')}")
                            
                            msg_type = data.get("type")
                            
                            if msg_type == "error":
                                provisional_error = data.get("message") or data.get("error")
                                logger.warning(
                                    f"[{ctx_id[:8]}] Cartesia error frame received before stream completion: "
                                    f"{provisional_error}"
                                )
                                continue
                            
                            if msg_type == "chunk":
                                audio_b64 = data.get("data")
                                if audio_b64:
                                    provisional_error = None
                                    audio_bytes = base64.b64decode(audio_b64)
                                    stats["chunks_received"] += 1
                                    stats["total_audio_bytes"] += len(audio_bytes)
                                    
                                    if first_chunk_time is None and stream_start_time:
                                        first_chunk_time = time.time()
                                        latency_ms = (first_chunk_time - stream_start_time) * 1000
                                        stats["first_chunk_latency_ms"] = latency_ms
                                        logger.info(f"📊 [{ctx_id[:8]}] TTFT: {latency_ms:.0f}ms")
                                    
                                    metadata = {
                                        "chunk_index": stats["chunks_received"],
                                        "context_id": ctx_id,
                                        "sample_rate": self.config.sample_rate,
                                        "format": self.config.output_format,
                                        "word_timestamps": data.get("word_timestamps"),
                                    }
                                    
                                    try:
                                        result = audio_callback(audio_bytes, self.config.sample_rate, metadata)
                                        if asyncio.iscoroutine(result):
                                            await result
                                    except Exception as e:
                                        logger.error(f"Callback error: {e}")
                                        
                            elif msg_type == "done":
                                if provisional_error and stats["chunks_received"] == 0:
                                    receive_error = provisional_error
                                logger.info(f"✅ [{ctx_id[:8]}] Stream complete")
                                break
                                
                        except asyncio.TimeoutError:
                            if send_complete.is_set():
                                if provisional_error and stats["chunks_received"] == 0:
                                    receive_error = provisional_error
                                logger.warning(f"[{ctx_id[:8]}] ⏱️ Receive timeout after send complete (chunks received: {stats['chunks_received']})")
                                break
                            else:
                                logger.debug(f"[{ctx_id[:8]}] Timeout waiting for message, but send still in progress...")
                            continue
                            
                except Exception as e:
                    logger.error(f"Receive error: {e}")
                    receive_error = str(e)
            
            # Run concurrently
            await asyncio.gather(send_text(), receive_audio())
            
            if receive_error:
                stats["error"] = receive_error
            return stats
            
        finally:
            # Unregister queue
            async with conn._dispatch_lock:
                conn._dispatch_queues.pop(ctx_id, None)
            conn.is_busy = False
    
    async def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
        model_id: Optional[str] = None,
        pronunciation_dict_id: Optional[str] = None,
    ) -> bytes:
        """
        Synthesize text to complete audio bytes.
        
        Args:
            text: Text to synthesize
            voice_id: Optional voice ID override
            language: Optional language override
            
        Returns:
            Complete audio bytes
        """
        audio_chunks: List[bytes] = []
        
        def collect_audio(audio_bytes: bytes, sample_rate: int, metadata: Dict[str, Any]):
            audio_chunks.append(audio_bytes)
        
        stats = await self.stream_text_to_audio(
            text,
            collect_audio,
            voice_id=voice_id,
            language=language,
            model_id=model_id,
            pronunciation_dict_id=pronunciation_dict_id,
        )
        
        if stats.get("error"):
            logger.error(f"Synthesis failed: {stats['error']}")
            return b""
        
        return b"".join(audio_chunks)
    
    async def close(self):
        """Close all connections"""
        async with self._connection_lock:
            for conn in self._connections:
                await conn.disconnect()
            self._connections.clear()
        
        self._is_warmed = False
        logger.info("Cartesia manager closed")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get manager statistics"""
        return {
            "pool_size": len(self._connections),
            "available_connections": sum(1 for c in self._connections if c.is_available()),
            "is_warmed": self._is_warmed,
            "connections": [
                {
                    "id": c.connection_id,
                    "state": c.state.value,
                    "messages_sent": c.metrics.messages_sent,
                    "messages_received": c.metrics.messages_received,
                    "total_audio_bytes": c.metrics.total_audio_bytes,
                    "reconnect_count": c.metrics.reconnect_count,
                }
                for c in self._connections
            ]
        }
