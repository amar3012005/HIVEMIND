"""
Groq Whisper API Client

Async HTTP client for Groq's transcription endpoint with retry logic and latency tracking.
"""

import asyncio
import io
import logging
import time
import re
import wave
from typing import Optional, Dict, Any, List
import httpx

logger = logging.getLogger(__name__)


class GroqTranscriptionResult:
    """Parsed result from Groq transcription API"""
    
    def __init__(self, response_data: Dict[str, Any]):
        self.text: str = response_data.get("text", "").strip()
        self.language: Optional[str] = response_data.get("language")
        self.duration: Optional[float] = response_data.get("duration")
        
        # Verbose JSON metadata
        self.segments: List[Dict] = response_data.get("segments", [])
        self.words: List[Dict] = response_data.get("words", [])
        
        # Quality metrics from segments
        self.avg_logprob: Optional[float] = None
        self.no_speech_prob: Optional[float] = None
        self.compression_ratio: Optional[float] = None
        
        if self.segments:
            # Average quality metrics across segments
            logprobs = [s.get("avg_logprob", 0) for s in self.segments if "avg_logprob" in s]
            no_speech = [s.get("no_speech_prob", 0) for s in self.segments if "no_speech_prob" in s]
            compression = [s.get("compression_ratio", 0) for s in self.segments if "compression_ratio" in s]
            
            if logprobs:
                self.avg_logprob = sum(logprobs) / len(logprobs)
            if no_speech:
                self.no_speech_prob = sum(no_speech) / len(no_speech)
            if compression:
                self.compression_ratio = sum(compression) / len(compression)
                
            # Range and temperature
            self.start = self.segments[0].get("start", 0)
            self.end = self.segments[-1].get("end", 0)
            self.temperature = self.segments[0].get("temperature", 0)
        else:
            self.start = 0
            self.end = 0
            self.temperature = 0
    
    @property
    def is_empty(self) -> bool:
        """Check if transcription is empty or just noise"""
        return not self.text or len(self.text.strip()) == 0
    
    @property
    def is_low_quality(self) -> bool:
        """Check if transcription quality is poor (likely noise/silence)"""
        if self.no_speech_prob and self.no_speech_prob > 0.8:
            return True
        if self.avg_logprob and self.avg_logprob < -1.0:
            return True
        return False
    
    @property
    def is_hallucination(self) -> bool:
        """Check if transcription is a known Whisper hallucination"""
        if not self.text:
            return False
        
        # Lowercase and strip punctuation for robust comparison
        text_raw = self.text.lower().strip()
        # Remove everything except letters and numbers
        text_clean = re.sub(r'[^a-zA-Z0-9]', '', text_raw)
        
        hallucinations_clean = [
            "thankyou",
            "you",
            "thanksforwatching",
            "bye",
            "goodbye",
            "subscribetomychannel",
            "pleasesubscribe",
            "theend",
            "hallo", # Whisper sometimes hallucinates "Hallo" for silence
            "und",   # "And" in German
        ]
        
        # Exact clean match
        if text_clean in hallucinations_clean:
            return True
        
        # Also check for empty strings after punctuation removal (just "....")
        if not text_clean:
            return True
        
        # Common Whisper hallucinations (literal list as fallback)
        hallucinations_literal = [
            "thank you", "thank you.", "thank you...", "thank you....", 
            "you", "you.", "you...", "you....",
            "thanks for watching", "bye", "bye.", "goodbye",
            ".", "..", "...", "....",
        ]
        
        if text_raw in hallucinations_literal:
            return True
            
        # Check for very short transcripts with high no_speech_prob
        if len(text_clean) < 5 and self.no_speech_prob and self.no_speech_prob > 0.5:
            return True
        
        # Check for repetitive patterns (e.g., "you you you")
        words = text_raw.split()
        if len(words) > 1 and len(set(words)) == 1:  # All words are the same
            return True
        
        return False
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "text": self.text,
            "language": self.language,
            "duration": self.duration,
            "words": self.words,
            "avg_logprob": self.avg_logprob,
            "no_speech_prob": self.no_speech_prob,
            "compression_ratio": self.compression_ratio,
        }


class GroqWhisperClient:
    """
    Async client for Groq's Whisper transcription API.
    
    Handles audio conversion, API calls with retry logic, and latency tracking.
    """
    
    def __init__(self, config):
        """
        Initialize Groq Whisper client.
        
        Args:
            config: GroqWhisperConfig instance
        """
        self.config = config
        self._client: Optional[httpx.AsyncClient] = None
        
        # Metrics
        self.total_requests = 0
        self.successful_requests = 0
        self.failed_requests = 0
        self.total_latency_ms = 0.0
        self.last_latency_ms = 0.0
    
    async def _ensure_client(self) -> httpx.AsyncClient:
        """Ensure HTTP client is initialized"""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.config.api_timeout_seconds),
                limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
                verify=not self.config.skip_ssl_verify
            )
        return self._client
    
    def _convert_pcm_to_wav(self, pcm_bytes: bytes) -> bytes:
        """
        Convert raw PCM bytes to WAV format for Groq API.
        
        Args:
            pcm_bytes: Raw PCM audio (16kHz, 16-bit, mono)
            
        Returns:
            WAV file bytes
        """
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(self.config.sample_rate)
            wav_file.writeframes(pcm_bytes)
        
        buffer.seek(0)
        return buffer.read()

    async def _retry_strict_native_transcription(
        self,
        client: httpx.AsyncClient,
        headers: Dict[str, str],
        files: Dict[str, Any],
        base_data: Dict[str, Any],
        language: Optional[str],
    ) -> Optional[GroqTranscriptionResult]:
        retry_data = dict(base_data)
        retry_data["prompt"] = self.config.build_transcription_prompt(
            extra_prompt=(
                "Return the transcript only in the original spoken language. "
                "Do not translate German speech into English."
            ),
            language=language,
        )
        response = await client.post(
            self.config.transcription_url,
            headers=headers,
            data=retry_data,
            files=files,
        )
        if response.status_code != 200:
            logger.warning(f"Strict native-language retry failed with status {response.status_code}: {response.text}")
            return None
        return GroqTranscriptionResult(response.json())
    
    async def transcribe(
        self,
        audio_bytes: bytes,
        prompt: Optional[str] = None,
        language: Optional[str] = None
    ) -> Optional[GroqTranscriptionResult]:
        """
        Transcribe audio chunk using Groq API.
        
        Args:
            audio_bytes: Raw PCM audio bytes (16kHz, 16-bit, mono)
            prompt: Optional context from previous transcription
            language: Optional language code (ISO-639-1)
            
        Returns:
            GroqTranscriptionResult or None on failure
        """
        if not audio_bytes or len(audio_bytes) < 48:
            logger.debug("Skipping transcription - audio chunk too small")
            return None
        
        start_time = time.time()
        self.total_requests += 1
        
        # Convert PCM to WAV
        wav_bytes = self._convert_pcm_to_wav(audio_bytes)

        # OpenRouter parakeet path (realtime ASR). Falls back to Groq Whisper on
        # failure (e.g. key limit / outage) so STT never goes fully dark.
        if getattr(self.config, 'stt_provider', 'groq') == 'openrouter':
            _or = await self._transcribe_openrouter(wav_bytes, start_time)
            if _or is not None:
                return _or
            if not self.config.api_key:
                return None  # no Groq fallback available
            logger.warning("⚠️ OpenRouter STT failed — falling back to Groq Whisper")

        # Prepare multipart form data
        files = {
            "file": ("audio.wav", wav_bytes, "audio/wav")
        }
        
        data = {
            "model": self.config.model,
            "response_format": self.config.response_format,
            "temperature": str(self.config.temperature),
        }
        
        # Add explicit language hint only when the session is intentionally locked.
        language_hint = self.config.request_language_hint(language)
        if language_hint:
            data["language"] = language_hint

        prompt_text = self.config.build_transcription_prompt(prompt, language=language)
        if prompt_text:
            data["prompt"] = prompt_text
        
        # Add timestamp granularities for word-level timing
        if self.config.include_word_timestamps and self.config.response_format == "verbose_json":
            data["timestamp_granularities[]"] = "word"
        
        # Prepare headers
        headers = {
            "Authorization": f"Bearer {self.config.api_key}"
        }
        
        # Retry loop with exponential backoff
        last_error = None
        for attempt in range(self.config.max_retries):
            try:
                client = await self._ensure_client()
                
                response = await client.post(
                    self.config.transcription_url,
                    headers=headers,
                    data=data,
                    files=files
                )
                
                elapsed_ms = (time.time() - start_time) * 1000
                self.last_latency_ms = elapsed_ms
                self.total_latency_ms += elapsed_ms
                
                if response.status_code == 200:
                    self.successful_requests += 1
                    result = GroqTranscriptionResult(response.json())

                    # Accept English transcriptions when Groq detects English speech.
                    # The orchestrator handles multilingual sessions (SUPPORTED_LANGUAGES=en,de).
                    # Forcing German re-transcription mangles legitimate English input.
                    expected_language = language_hint
                    if self.config.is_german_language(expected_language):
                        result_language = (result.language or "").strip().lower()
                        if result_language.startswith("en"):
                            logger.info("ℹ️ Groq detected English speech during German-default session — accepting as-is")
                    
                    if result.text:
                        status = "🚫 HALLUCINATION" if result.is_hallucination else "✅"
                        logger.info(f"{status} Groq transcription ({elapsed_ms:.0f}ms): '{result.text[:50]}...'")
                    else:
                        logger.debug(f"📭 Groq returned empty transcription ({elapsed_ms:.0f}ms)")
                    
                    return result
                    
                elif response.status_code == 429:
                    # Rate limited - wait and retry
                    wait_time = 2 ** attempt
                    logger.warning(f"⏳ Groq rate limited, waiting {wait_time}s before retry")
                    await asyncio.sleep(wait_time)
                    last_error = f"Rate limited: {response.text}"
                    
                else:
                    last_error = f"API error {response.status_code}: {response.text}"
                    logger.error(f"❌ Groq API error: {last_error}")
                    break  # Don't retry on non-retryable errors
                    
            except httpx.TimeoutException:
                last_error = "Request timeout"
                logger.warning(f"⏰ Groq request timeout (attempt {attempt + 1}/{self.config.max_retries})")
                await asyncio.sleep(0.5)
                
            except Exception as e:
                last_error = str(e)
                logger.error(f"❌ Groq request error: {e}")
                break
        
        # All retries failed
        self.failed_requests += 1
        logger.error(f"❌ Groq transcription failed after {self.config.max_retries} attempts: {last_error}")
        return None
    
    async def _transcribe_openrouter(self, wav_bytes: bytes, start_time: float):
        """OpenRouter parakeet (nvidia/parakeet-tdt-0.6b-v3) — JSON base64, returns {text}."""
        import base64, json as _json
        b64 = base64.b64encode(wav_bytes).decode("utf-8")
        try:
            client = await self._ensure_client()
            resp = await client.post(
                self.config.openrouter_url,
                headers={
                    "Authorization": f"Bearer {self.config.openrouter_api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://hivemind.davinciai.eu",
                    "X-OpenRouter-Title": "HIVEMIND TARA",
                },
                content=_json.dumps({
                    "model": self.config.stt_model,
                    "input_audio": {"data": b64, "format": "wav"},
                }),
            )
            elapsed_ms = (time.time() - start_time) * 1000
            self.last_latency_ms = elapsed_ms
            self.total_latency_ms += elapsed_ms
            if resp.status_code != 200:
                self.failed_requests += 1
                logger.error(f"❌ OpenRouter STT {resp.status_code}: {resp.text[:200]}")
                return None
            j = resp.json()
            text = (j.get("text") or "").strip()
            self.successful_requests += 1
            if text:
                logger.info(f"✅ Parakeet ({elapsed_ms:.0f}ms): '{text[:60]}'")
            return GroqTranscriptionResult({"text": text})
        except Exception as e:  # noqa: BLE001
            self.failed_requests += 1
            logger.error(f"❌ OpenRouter STT error: {e}")
            return None

    async def close(self):
        """Close HTTP client"""
        if self._client:
            await self._client.aclose()
            self._client = None
    
    def get_stats(self) -> Dict[str, Any]:
        """Get client statistics"""
        avg_latency = (
            self.total_latency_ms / self.successful_requests
            if self.successful_requests > 0
            else 0
        )
        
        return {
            "total_requests": self.total_requests,
            "successful_requests": self.successful_requests,
            "failed_requests": self.failed_requests,
            "avg_latency_ms": avg_latency,
            "last_latency_ms": self.last_latency_ms,
            "model": self.config.model,
        }
