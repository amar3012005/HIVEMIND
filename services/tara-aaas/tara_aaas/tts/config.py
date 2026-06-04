"""
Configuration for TTS-Cartesia Microservice

Loads environment variables for Cartesia API, audio settings, and connection pooling.
"""

import os
import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


@dataclass
class CartesiaConfig:
    """
    Configuration for Cartesia TTS microservice.
    
    Handles API connectivity, audio format, and connection pool settings.
    """
    
    # Cartesia API settings
    api_key: str = field(default_factory=lambda: os.getenv("CARTESIA_API_KEY", ""))
    model: str = field(default_factory=lambda: os.getenv("CARTESIA_MODEL", "sonic-3"))
    voice_id: str = field(default_factory=lambda: os.getenv("CARTESIA_VOICE_ID", ""))

    # WebSocket settings
    websocket_url: str = "wss://api.cartesia.ai/tts/websocket"
    api_version: str = "2024-06-10"  # Cartesia API version

    # Audio format settings
    sample_rate: int = field(default_factory=lambda: int(os.getenv("CARTESIA_SAMPLE_RATE", "").strip() or "16000"))
    output_format: str = field(default_factory=lambda: os.getenv("CARTESIA_OUTPUT_FORMAT", "").strip() or "pcm_s16le")
    container: str = "raw"  # raw or mp3

    # Voice settings
    language: str = field(default_factory=lambda: os.getenv("CARTESIA_LANGUAGE", "").strip() or "de")
    speed: float = field(default_factory=lambda: float(os.getenv("CARTESIA_SPEED", "").strip() or "0.95"))
    max_buffer_delay_ms: int = field(default_factory=lambda: int(os.getenv("CARTESIA_MAX_BUFFER_DELAY_MS", "0").strip() or "0"))

    # Pronunciation dictionary for tenant-specific brand names
    pronunciation_dict_id: Optional[str] = field(default_factory=lambda: os.getenv("CARTESIA_PRONUNCIATION_DICT_ID", "").strip() or None)
    
    # Connection pool settings (for robustness)
    pool_size: int = field(default_factory=lambda: int(os.getenv("CONNECTION_POOL_SIZE", "3")))
    max_reconnect_attempts: int = 5
    reconnect_base_delay_ms: int = 500  # Exponential backoff base
    
    # Timeouts
    connection_timeout_seconds: float = 10.0
    ping_interval_seconds: float = 20.0
    ping_timeout_seconds: float = 10.0
    
    # Service settings
    host: str = field(default_factory=lambda: os.getenv("TTS_CARTESIA_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.getenv("TTS_CARTESIA_PORT", "8000")) if os.getenv("TTS_CARTESIA_PORT", "8000").isdigit() else 8000)
    debug: bool = field(default_factory=lambda: os.getenv("TTS_CARTESIA_DEBUG", "false").lower() == "true")
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))
    
    def __post_init__(self):
        """Validate configuration"""
        if not self.api_key:
            raise ValueError(
                "CARTESIA_API_KEY must be set. "
                "Get your API key from https://play.cartesia.ai/"
            )

        if not self.voice_id:
            logger.warning("CARTESIA_VOICE_ID not set, using default German voice")
            # Default to German-native voice for optimal German pronunciation
            self.voice_id = "694f9389-aac1-45b6-b726-9d9369183238"  # German-native voice

        # Validate model
        valid_models = ["sonic-english", "sonic-multilingual", "sonic-2", "sonic-3", "sonic-4"]
        if self.model not in valid_models:
            logger.warning(f"Unknown model '{self.model}', using 'sonic-3' for multilingual support")
            self.model = "sonic-3"

        # Validate speed (Cartesia range: 0.5-2.0)
        if not (0.5 <= self.speed <= 2.0):
            logger.warning(f"Speed {self.speed} out of range [0.5-2.0], clamping to 0.9")
            self.speed = 0.9

        # Validate Cartesia buffering. When the orchestrator already chunks on
        # clause boundaries, keep this at 0 to avoid re-buffering latency.
        if not (0 <= self.max_buffer_delay_ms <= 5000):
            logger.warning(f"max_buffer_delay_ms {self.max_buffer_delay_ms} out of range [0-5000], clamping to 0")
            self.max_buffer_delay_ms = 0

        # Validate output format
        valid_formats = ["pcm_s16le", "pcm_f32le", "pcm_mulaw", "pcm_alaw"]

        # DEBUG LOGGING
        logger.info(f"🔍 DEBUG: Raw output_format from env: '{self.output_format}'")

        if self.output_format not in valid_formats:
            logger.warning(f"Invalid output_format '{self.output_format}', forcing 'pcm_f32le'")
            self.output_format = "pcm_f32le"

        # Note: pcm_s16le is now the default for browser compatibility
        # No forced upgrade needed

        # Log configuration
        masked_key = f"{self.api_key[:8]}...{self.api_key[-4:]}" if len(self.api_key) > 12 else "***"
        logger.info(f"🔑 Cartesia API key configured: {masked_key}")
        logger.info(f"🎤 Model: {self.model} ({'multilingual' if 'multilingual' in self.model.lower() or 'sonic-3' in self.model.lower() or 'sonic-4' in self.model.lower() else 'english-only'})")
        logger.info(f"🔊 Voice ID: {self.voice_id} (German-native)")
        logger.info(f"🌐 Language: {self.language} (for multilingual models)")
        logger.info(f"⚡ Speed: {self.speed} (0.95 optimized for German clarity)")
        logger.info(f"⏱️ Max buffer delay: {self.max_buffer_delay_ms}ms")
        logger.info(f"📊 Sample rate: {self.sample_rate}Hz (16kHz real-time optimized)")
        logger.info(f"🔄 Encoding: {self.output_format} (16-bit for browser compatibility)")
        logger.info(f"🔄 Connection pool size: {self.pool_size}")
        if self.pronunciation_dict_id:
            logger.info(f"📖 Pronunciation Dictionary: {self.pronunciation_dict_id}")
    
    def get_websocket_url(self) -> str:
        """Get full WebSocket URL with query parameters"""
        return f"{self.websocket_url}?api_key={self.api_key}&cartesia_version={self.api_version}"
    
    def get_output_format_config(self) -> Dict[str, Any]:
        """Get output format configuration for Cartesia API"""
        return {
            "container": self.container,
            "encoding": self.output_format,
            "sample_rate": self.sample_rate
        }
    
    def get_voice_config(self) -> Dict[str, Any]:
        """Get voice configuration for Cartesia API"""
        return {
            "mode": "id",
            "id": self.voice_id
        }
    
    @staticmethod
    def from_env() -> "CartesiaConfig":
        """Load configuration from environment variables"""
        return CartesiaConfig()
