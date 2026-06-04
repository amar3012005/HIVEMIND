import asyncio
import json
import logging
import time
import ssl
from typing import Optional, Any, Dict
import websockets
from websockets.client import WebSocketClientProtocol

logger = logging.getLogger(__name__)


class OrchestratorWSClient:
    """
    Robust WebSocket client for STT service to send events/transcripts
    directly to the orchestrator. Implements persistent connection with 
    automatic recovery.
    """
    
    def __init__(self, orchestrator_url: str, session_id: str, skip_ssl: bool = True):
        self.orchestrator_url = orchestrator_url
        self.session_id = session_id
        self.skip_ssl = skip_ssl
        self.ws: Optional[WebSocketClientProtocol] = None
        self._connected_event = asyncio.Event()
        self._monitor_task: Optional[asyncio.Task] = None
        self._is_running = False
        self._lock = asyncio.Lock()
        
    async def connect(self) -> bool:
        """Initialize monitor task and wait for connection"""
        async with self._lock:
            if not self._is_running:
                self._is_running = True
                self._monitor_task = asyncio.create_task(self._monitor_loop())
        
        try:
            # Wait up to 5s for initial connection
            await asyncio.wait_for(self._connected_event.wait(), timeout=5.0)
            return True
        except asyncio.TimeoutError:
            logger.warning(f"⏳ [{self.session_id}] Initial orchestrator connection timed out, will keep retrying")
            return False

    async def _monitor_loop(self):
        """Background task to maintain connection and handle sending"""
        backoff = 0.5
        max_backoff = 10.0
        
        # Prepare SSL context if skipping
        ssl_context = None
        if self.orchestrator_url.startswith("wss://") and self.skip_ssl:
            ssl_context = ssl.SSLContext()
            ssl_context.verify_mode = ssl.CERT_NONE
            ssl_context.check_hostname = False
        
        while self._is_running:
            try:
                base_url = self.orchestrator_url.rstrip("/")
                ws_url = f"{base_url}?session_id={self.session_id}&source=stt_groq"
                if not "/ws" in base_url and not base_url.endswith("/ws"):
                     ws_url = f"{base_url}/ws?session_id={self.session_id}&source=stt_groq"
                
                logger.info(f"🔌 [{self.session_id}] Connecting to orchestrator: {ws_url}")
                
                async with websockets.connect(
                    ws_url,
                    ssl=ssl_context,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5
                ) as ws:
                    self.ws = ws
                    self._connected_event.set()
                    backoff = 0.5
                    logger.info(f"✅ [{self.session_id}] Connected to orchestrator WebSocket")
                    
                    # Connection stays open as long as this block is active
                    # We can use a message loop or just wait for cancellation
                    while self._is_running:
                        try:
                            # Wait for something to send or a heartbeat
                            # This also keeps the connection open
                            msg = await ws.recv()
                            # Currently we don't expect messages from orchestrator, but we log them
                            logger.debug(f"📥 [{self.session_id}] Received from orchestrator: {msg}")
                        except websockets.ConnectionClosed:
                            break
                        except Exception as e:
                            logger.warning(f"⚠️ [{self.session_id}] WS receive error: {e}")
                            break
                            
            except Exception as e:
                logger.error(f"❌ [{self.session_id}] Orchestrator connection failed: {e}")
            
            # Reset state and backoff
            self.ws = None
            self._connected_event.clear()
            
            if self._is_running:
                logger.info(f"🔄 [{self.session_id}] Reconnecting to orchestrator in {backoff:.1f}s...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)

    async def send_event(self, event_type: str, signal_type: str, **extra: Any) -> bool:
        """Send VAD event directly to orchestrator"""
        message = {
            "type": "stt_event",
            "event_type": event_type,
            "signal_type": signal_type,
            "timestamp": time.time(),
            "session_id": self.session_id,
            "source": "groq_whisper"
        }
        if extra:
            message.update(extra)
        return await self._send(message)

    async def send_transcript(
        self, 
        text: str, 
        is_final: bool, 
        language: str = "en",
        words: Optional[list] = None,
        language_code: Optional[str] = None,
        latency_ms: Optional[float] = None,
        avg_logprob: Optional[float] = None,
        no_speech_prob: Optional[float] = None,
        compression_ratio: Optional[float] = None,
    ) -> bool:
        """Send transcript directly to orchestrator"""
        message = {
            "type": "stt_transcript",
            "text": text,
            "is_final": is_final,
            "language": language,
            "timestamp": time.time(),
            "session_id": self.session_id,
            "source": "groq_whisper"
        }
        
        if words: message["words"] = words
        if language_code: message["language_code"] = language_code
        if latency_ms: message["latency_ms"] = latency_ms
        if avg_logprob is not None: message["avg_logprob"] = avg_logprob
        if no_speech_prob is not None: message["no_speech_prob"] = no_speech_prob
        if compression_ratio is not None: message["compression_ratio"] = compression_ratio
        
        return await self._send(message)

    async def _send(self, message: Dict[str, Any]) -> bool:
        """Internal send helper with ensuring connection"""
        if not self._connected_event.is_set():
            # Wait briefly for connection
            try:
                await asyncio.wait_for(self._connected_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                logger.warning(f"⚠️ [{self.session_id}] Dropping message - orchestrator not connected")
                return False
                
        try:
            if self.ws:
                await self.ws.send(json.dumps(message))
                return True
            return False
        except Exception as e:
            logger.error(f"❌ [{self.session_id}] Send failed: {e}")
            return False

    async def close(self):
        """Close client and stop monitor"""
        self._is_running = False
        if self._monitor_task:
            self._monitor_task.cancel()
            self._monitor_task = None
        
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
            
        self._connected_event.clear()
        logger.info(f"🔌 [{self.session_id}] Closed orchestrator client")
