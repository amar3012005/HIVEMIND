"""
Configuration for the Groq Whisper STT microservice.

Loads environment variables with GROQ_* and STT_* prefixes to drive
REST API calls, audio processing, and transcription settings.
"""

import os
import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class GroqWhisperConfig:
    """
    Unified configuration for Groq Whisper STT microservice.
    
    Handles REST API connectivity, audio format, micro-chunking strategy, and VAD settings.
    """
    
    # Groq API settings
    api_key: str = os.getenv("GROQ_API_KEY", "")
    base_url: str = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
    model: str = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3")

    # STT provider switch: 'groq' (Whisper) | 'openrouter' (nvidia parakeet, realtime).
    stt_provider: str = os.getenv("STT_PROVIDER", "groq")
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    stt_model: str = os.getenv("STT_MODEL", "nvidia/parakeet-tdt-0.6b-v3")
    openrouter_url: str = os.getenv("OPENROUTER_STT_URL", "https://openrouter.ai/api/v1/audio/transcriptions")
    
    # Audio format settings
    sample_rate: int = int(os.getenv("GROQ_SAMPLE_RATE", "16000"))
    audio_format: str = os.getenv("GROQ_AUDIO_FORMAT", "wav")  # wav, flac, mp3
    
    # Micro-chunking settings (ultra-low latency per user preference)
    enable_micro_chunking: bool = os.getenv("ENABLE_MICRO_CHUNKING", "false").lower() == "true"  # Toggle chunking mode
    chunk_duration_ms: int = int(os.getenv("CHUNK_DURATION_MS", "120"))  # larger chunks improve noise robustness
    overlap_duration_ms: int = int(os.getenv("OVERLAP_DURATION_MS", "60"))  # overlap for continuity
    context_window_segments: int = int(os.getenv("CONTEXT_WINDOW_SEGMENTS", "3"))  # larger context reduces drift
    
    # Base prompt for spelling guidance (e.g., proper nouns, acronyms)
    base_prompt: str = os.getenv("GROQ_BASE_PROMPT", "")
    
    # VAD settings (local pre-filtering)
    # Higher energy threshold = less sensitive (reduces false positives from ambient noise/echo)
    vad_energy_threshold: int = int(os.getenv("VAD_ENERGY_THRESHOLD", "850"))  # RMS energy threshold (default: 850, range: 500-1000)
    use_webrtcvad: bool = os.getenv("USE_WEBRTCVAD", "true").lower() == "true"
    webrtcvad_aggressiveness: int = int(os.getenv("WEBRTCVAD_AGGRESSIVENESS", "2"))
    webrtcvad_frame_ms: int = int(os.getenv("WEBRTCVAD_FRAME_MS", "20"))
    min_voiced_ratio: float = float(os.getenv("MIN_VOICED_RATIO", "0.45"))
    min_speech_duration_ms: int = int(os.getenv("MIN_SPEECH_DURATION_MS", "500"))  # Minimum speech length in ms (default: 500ms)
    speech_start_trigger_ms: int = int(os.getenv("SPEECH_START_TRIGGER_MS", "160"))  # Debounce speech start to reduce false VAD triggers
    min_silence_duration_ms: int = int(os.getenv("MIN_SILENCE_DURATION_MS", "1050"))  # Baseline silence before speech_end in ms
    final_silence_padding_ms: int = int(os.getenv("FINAL_SILENCE_PADDING_MS", "900"))
    finalization_wait_ms: int = int(os.getenv("FINALIZATION_WAIT_MS", "40"))  # Wait briefly for the last in-flight chunk before finalizing
    pre_speech_padding_ms: int = int(os.getenv("PRE_SPEECH_PADDING_MS", "640"))
    adaptive_endpointing: bool = os.getenv("STT_ADAPTIVE_ENDPOINTING", "true").lower() == "true"
    continuation_silence_bonus_ms: int = int(os.getenv("CONTINUATION_SILENCE_BONUS_MS", "520"))
    continuation_word_threshold: int = int(os.getenv("CONTINUATION_WORD_THRESHOLD", "5"))
    continuation_min_duration_ms: int = int(os.getenv("CONTINUATION_MIN_DURATION_MS", "1200"))
    
    # Groq API parameters
    language: Optional[str] = os.getenv("GROQ_LANGUAGE", "de")  # auto, en, de
    response_format: str = os.getenv("GROQ_RESPONSE_FORMAT", "verbose_json")  # json, verbose_json, text
    temperature: float = float(os.getenv("GROQ_TEMPERATURE", "0.0"))
    include_word_timestamps: bool = os.getenv("GROQ_WORD_TIMESTAMPS", "true").lower() == "true"
    reject_no_speech_prob: float = float(os.getenv("REJECT_NO_SPEECH_PROB", "0.72"))
    reject_avg_logprob: float = float(os.getenv("REJECT_AVG_LOGPROB", "-0.90"))
    reject_compression_ratio: float = float(os.getenv("REJECT_COMPRESSION_RATIO", "2.40"))
    reject_short_utterance_ms: int = int(os.getenv("REJECT_SHORT_UTTERANCE_MS", "450"))
    reject_short_text_chars: int = int(os.getenv("REJECT_SHORT_TEXT_CHARS", "6"))
    
    # Service settings
    host: str = os.getenv("STT_GROQ_HOST", "0.0.0.0")
    port: int = int(os.getenv("STT_GROQ_PORT", "8002"))
    debug: bool = os.getenv("GROQ_DEBUG", "false").lower() == "true"
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    
    # Redis settings (optional, for backward compatibility)
    redis_host: str = os.getenv("REDIS_HOST", "redis")
    redis_port: int = 6379  # Default
    redis_db: int = int(os.getenv("REDIS_DB", "0"))
    
    # Production: Direct orchestrator WebSocket
    orchestrator_ws_url: Optional[str] = os.getenv("ORCHESTRATOR_WS_URL", None)
    skip_ssl_verify: bool = os.getenv("STT_SKIP_SSL_VERIFY", "true").lower() == "true"
    
    # Timeout settings
    api_timeout_seconds: float = float(os.getenv("GROQ_API_TIMEOUT", "5.0"))
    callback_timeout_seconds: float = float(os.getenv("STT_CALLBACK_TIMEOUT_SECONDS", "0.75"))
    max_retries: int = int(os.getenv("GROQ_MAX_RETRIES", "3"))
    
    @property
    def chunk_bytes(self) -> int:
        """Calculate bytes per chunk (16-bit PCM, mono)"""
        return int(self.sample_rate * self.chunk_duration_ms / 1000 * 2)
    
    @property
    def overlap_bytes(self) -> int:
        """Calculate overlap bytes"""
        return int(self.sample_rate * self.overlap_duration_ms / 1000 * 2)
    
    @property
    def transcription_url(self) -> str:
        """Get the transcription endpoint URL"""
        return f"{self.base_url}/audio/transcriptions"

    def resolve_language(self, preferred: Optional[str] = None) -> str:
        """Normalize and force a stable language choice for transcription requests."""
        lang = (preferred or self.language or "de").strip().lower()
        if lang in {"de", "deu", "ger", "german", "deutsch"}:
            return "de"
        if lang in {"en", "eng", "english"}:
            return "en"
        return "de"

    def request_language_hint(self, preferred: Optional[str] = None) -> Optional[str]:
        """
        Return an explicit Groq language hint only when configured intentionally.
        """
        raw = (preferred if preferred is not None else self.language) or ""
        lang = raw.strip().lower()
        if not lang or lang in {"auto", "detect", "multilingual"}:
            return None
        return self.resolve_language(lang)

    def build_transcription_prompt(self, extra_prompt: Optional[str] = None, language: Optional[str] = None) -> Optional[str]:
        """
        Build a strict no-translation transcription prompt.
        This reduces Whisper's tendency to normalize non-English speech into English.
        """
        lang = self.request_language_hint(language)
        parts = []
        if self.base_prompt:
            parts.append(self.base_prompt.strip())
        if self.is_german_language(lang):
            parts.append(
                "Transcribe the spoken audio exactly as spoken. The primary language is German. "
                "If the speaker switches to English, transcribe the English portions in English. "
                "Do not translate between languages — preserve whatever language the speaker actually uses. "
                "Preserve names, brands, German compounds, umlauts, and the Eszett (ß) when appropriate. "
                "Keep acronyms and product names as spoken. "
                "Do not spell words letter by letter unless the speaker explicitly spells them. "
                "If audio is unclear, omit uncertain fragments rather than guessing."
            )
        elif lang == "en":
            parts.append(
                "Transcribe the spoken audio exactly in English. Do not translate, summarize, or paraphrase. "
                "Preserve names, brands, and phrasing as spoken. "
                "If audio is unclear, transcribe only the clearly spoken words and omit uncertain fragments rather than guessing."
            )
        else:
            parts.append(
                "Transcribe the spoken audio exactly as spoken. "
                "If the speaker switches languages, preserve each spoken portion in that same language. "
                "Do not translate, summarize, or paraphrase. "
                "Preserve names, brands, and product names as spoken. "
                "If audio is unclear, transcribe only clearly spoken words and omit uncertain fragments rather than inventing them."
            )
        if extra_prompt:
            parts.append(extra_prompt.strip())
        prompt = " ".join(part for part in parts if part)
        # Groq rejects longer prompts; keep headroom below the platform limit.
        return prompt[:850] if prompt else None

    @staticmethod
    def is_german_language(language: Optional[str]) -> bool:
        return (language or "").strip().lower() in {"de", "deu", "ger", "german", "deutsch"}
    
    def __post_init__(self):
        """Validate configuration and handle port parsing"""
        # Handle REDIS_PORT which might be set to tcp://... by Kubernetes
        env_port = os.getenv("REDIS_PORT", "6379")
        if env_port.startswith("tcp://"):
            try:
                self.redis_port = int(env_port.split(":")[-1])
            except ValueError:
                self.redis_port = 6379
        else:
            try:
                self.redis_port = int(env_port)
            except ValueError:
                self.redis_port = 6379

        if not self.api_key:
            raise ValueError(
                "GROQ_API_KEY must be set. "
                "Set GROQ_API_KEY environment variable with your Groq API key."
            )
        
        # Log API key status (masked for security)
        masked_key = f"{self.api_key[:8]}...{self.api_key[-4:]}" if len(self.api_key) > 12 else "***"
        logger.info(f"🔑 Groq API key configured: {masked_key}")
        
        if self.language:
            self.language = self.language.strip().lower()

        if self.model not in ["whisper-large-v3-turbo", "whisper-large-v3"]:
            logger.warning(f"Unknown model '{self.model}', using 'whisper-large-v3-turbo'")
            self.model = "whisper-large-v3-turbo"
        
        if self.audio_format not in ["wav", "flac", "mp3", "webm", "ogg"]:
            logger.warning(f"Invalid audio_format '{self.audio_format}', using 'wav'")
            self.audio_format = "wav"
        
        # Log chunk configuration
        if self.enable_micro_chunking:
            logger.info(f"⏱️ Mode: MICRO-CHUNKING ({self.chunk_duration_ms}ms chunks, {self.chunk_bytes} bytes)")
            logger.info(f"🔄 Overlap: {self.overlap_duration_ms}ms")
            logger.info(f"📊 Context window: {self.context_window_segments} segments")
        else:
            logger.info(f"⏱️ Mode: FULL TRANSCRIPTION (buffer until speech end)")
        
        if self.base_prompt:
            logger.info(f"📝 Base prompt: '{self.base_prompt[:50]}...'")

        # Keep the trailing pad within the speech-end threshold.
        self.final_silence_padding_ms = max(0, min(self.final_silence_padding_ms, self.min_silence_duration_ms))

        # Guard against values that would make speech start feel delayed.
        self.speech_start_trigger_ms = max(0, min(self.speech_start_trigger_ms, self.min_speech_duration_ms))
        self.continuation_silence_bonus_ms = max(0, self.continuation_silence_bonus_ms)
        self.continuation_word_threshold = max(1, self.continuation_word_threshold)
        self.continuation_min_duration_ms = max(self.min_speech_duration_ms, self.continuation_min_duration_ms)
        self.webrtcvad_aggressiveness = max(0, min(3, self.webrtcvad_aggressiveness))
        if self.webrtcvad_frame_ms not in {10, 20, 30}:
            self.webrtcvad_frame_ms = 20
        self.min_voiced_ratio = max(0.0, min(1.0, self.min_voiced_ratio))
        self.reject_short_utterance_ms = max(0, self.reject_short_utterance_ms)
        self.reject_short_text_chars = max(1, self.reject_short_text_chars)
    
    @staticmethod
    def from_env() -> "GroqWhisperConfig":
        """Load configuration from environment variables"""
        return GroqWhisperConfig()
