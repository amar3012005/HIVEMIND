"""
Groq LLM Provider - Using high-speed Groq Cloud API with AsyncGroq.
"""

import logging
import asyncio
from typing import Generator, AsyncGenerator, Optional, Any, Union, List, Dict
from groq import AsyncGroq
from .base import LLMProvider

logger = logging.getLogger(__name__)


class GroqProvider(LLMProvider):
    """
    Groq provider implementation for ultra-low latency inference.
    Uses AsyncGroq for non-blocking streaming.
    """
    
    _client_instance: Optional[AsyncGroq] = None

    @staticmethod
    def _is_gpt_oss(model_name: str) -> bool:
        return "gpt-oss" in (model_name or "").lower()

    def initialize(self) -> bool:
        """Initialize Groq async client."""
        try:
            if GroqProvider._client_instance is None:
                GroqProvider._client_instance = AsyncGroq(
                    api_key=self.api_key
                )
            self._client = GroqProvider._client_instance
            self._last_usage: Dict[str, Any] = {}
            logger.info(f"✅ Groq initialized (AsyncGroq): {self.model_name}")
            return True
        except Exception as e:
            logger.error(f"❌ Groq initialization failed: {e}")
            return False
    
    def generate(
        self,
        prompt: str,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        stream: bool = False,
        **kwargs
    ) -> Union[str, Generator[str, None, None], AsyncGenerator[str, None]]:
        """
        Generate response using Groq.
        
        Note: For Groq, we prioritize AsyncGenerator when streaming is enabled.
        """
        if not self.is_available():
            raise RuntimeError("Groq provider not initialized")
        
        if stream:
            return self._generate_stream(prompt, max_tokens, temperature, **kwargs)
        else:
            # We return a coroutine for non-streaming sync-style calls if needed, 
            # but usually the engine handles the await.
            return self._generate_sync(prompt, max_tokens, temperature, **kwargs)

    async def generate_messages(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int = 1024,
        temperature: float = 0.5,
        response_format: Optional[Dict[str, str]] = None,
        **kwargs
    ) -> str:
        """
        Generate response from a list of messages (chat completion style).
        """
        if not self.is_available():
            raise RuntimeError("Groq provider not initialized")
        
        try:
            extra_args = {}
            if response_format:
                extra_args["response_format"] = response_format
                
            model = kwargs.pop("model", self.model_name)
            if self._is_gpt_oss(model):
                chat_completion = await self._client.chat.completions.create(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_completion_tokens=max_tokens,
                    reasoning_effort=kwargs.pop("reasoning_effort", "low"),
                    include_reasoning=kwargs.pop("include_reasoning", False),
                    **extra_args,
                    **kwargs
                )
            else:
                chat_completion = await self._client.chat.completions.create(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    **extra_args,
                    **kwargs
                )
            return chat_completion.choices[0].message.content
        except Exception as e:
            logger.error(f"Groq message generation error: {e}")
            raise

    async def _generate_sync(self, prompt: str, max_tokens: int, temperature: float, **kwargs) -> str:
        """Internal async method for single completions."""
        try:
            # Check for response_format in kwargs
            response_format = kwargs.pop("response_format", None)
            extra_args = {}
            if response_format:
                extra_args["response_format"] = response_format

            model = kwargs.pop("model", self.model_name)
            
            # Intelligent splitting for Zoned XML Architecture
            messages = []
            if "<system_configuration>" in prompt:
                try:
                    parts = prompt.split("</system_configuration>")
                    system_content = parts[0].replace("<system_configuration>", "").strip()
                    user_content = parts[1].strip()
                    
                    # Safety net for Groq's JSON mode requirement
                    if response_format and response_format.get("type") == "json_object":
                        if "json" not in system_content.lower():
                            system_content += "\nRespond in json format."
                        if "json" not in user_content.lower():
                            user_content += "\nRespond in json format."

                    messages = [
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": user_content}
                    ]
                except Exception:
                    messages = [{"role": "user", "content": prompt}]
            else:
                messages = [{"role": "user", "content": prompt}]

            if self._is_gpt_oss(model):
                reasoning_effort = (kwargs.pop("reasoning_effort", "low") or "low").strip().lower()
                # Groq GPT-OSS supports only: low | medium | high
                if reasoning_effort == "none":
                    reasoning_effort = "low"
                if reasoning_effort not in {"low", "medium", "high"}:
                    reasoning_effort = "low"
                include_reasoning = bool(kwargs.pop("include_reasoning", False))

                chat_completion = await self._client.chat.completions.create(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_completion_tokens=max_tokens,
                    include_reasoning=include_reasoning,
                    reasoning_effort=reasoning_effort,
                    **extra_args,
                    **kwargs
                )
            else:
                chat_completion = await self._client.chat.completions.create(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    **extra_args,
                    **kwargs
                )
            
            # Log Usage for Caching Verification
            if hasattr(chat_completion, 'usage'):
                u = chat_completion.usage
                cached_tokens = self._extract_cached_tokens(u)
                self._last_usage = {
                    "prompt_tokens": getattr(u, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(u, "completion_tokens", 0) or 0,
                    "total_tokens": getattr(u, "total_tokens", 0) or 0,
                    "cached_tokens": cached_tokens,
                    "model": model,
                }
                cache_suffix = f" | cached={cached_tokens}" if cached_tokens else ""
                logger.info(f"🧬 Groq Usage: {u.prompt_tokens} prompt / {u.completion_tokens} completion. Total: {u.total_tokens}{cache_suffix}")
            else:
                self._last_usage = {}

            return chat_completion.choices[0].message.content
        except Exception as e:
            logger.error(f"Groq generation error: {e}")
            raise

    async def generate_with_reasoning(
        self, 
        prompt: str, 
        max_completion_tokens: int = 2048, 
        temperature: float = 0.6,
        reasoning_effort: str = "high",
        **kwargs
    ) -> dict:
        """
        Generate response with Chain of Thought reasoning enabled.
        
        GROQ API RULES FOR REASONING MODELS (GPT-OSS):
        1. Use max_completion_tokens (NOT max_tokens) — CoT tokens count against this
        2. NO system messages — put ALL instructions in user message
        3. response_format={"type":"json_object"} is supported and should be paired with
           include_reasoning or hidden reasoning depending on caller needs
        4. reasoning_effort: "low" | "medium" | "high" (GPT-OSS only)
        5. include_reasoning and reasoning_format are mutually exclusive
        
        Returns dict with 'content' and 'reasoning' keys.
        """
        if not self.is_available():
            raise RuntimeError("Groq provider not initialized")
        
        try:
            response_format = kwargs.pop("response_format", None)
            reasoning_format = kwargs.pop("reasoning_format", None)
            include_reasoning = kwargs.pop("include_reasoning", True)
            # Also pop max_tokens if someone accidentally passes it
            kwargs.pop("max_tokens", None)
            
            model = kwargs.pop("model", self.model_name)
            
            # CRITICAL: For reasoning models, ALL instructions go in user message
            # Docs say: "Avoid system prompts — include all instructions in the user message"
            user_content = ""
            if "<system_configuration>" in prompt:
                try:
                    parts = prompt.split("</system_configuration>")
                    system_part = parts[0].replace("<system_configuration>", "").strip()
                    user_part = parts[1].strip()
                    # Merge system instructions into user message
                    user_content = f"INSTRUCTIONS:\n{system_part}\n\nTASK:\n{user_part}"
                except Exception:
                    user_content = prompt
            else:
                user_content = prompt
            
            # Reinforce JSON mode in-prompt because callers depend on strict machine parsing.
            if response_format and response_format.get("type") == "json_object":
                user_content += "\n\nIMPORTANT: You MUST respond with ONLY a valid JSON object. No explanation text, no markdown code fences, no commentary — just the raw JSON."
            
            messages = [{"role": "user", "content": user_content}]

            if include_reasoning and reasoning_format:
                raise ValueError("include_reasoning and reasoning_format cannot be used together")

            extra_args: Dict[str, Any] = {}
            if response_format:
                extra_args["response_format"] = response_format
            if reasoning_format:
                extra_args["reasoning_format"] = reasoning_format
            else:
                extra_args["include_reasoning"] = include_reasoning

            chat_completion = await self._client.chat.completions.create(
                messages=messages,
                model=model,
                temperature=temperature,
                max_completion_tokens=max_completion_tokens,
                reasoning_effort=reasoning_effort,
                stream=False,
                **extra_args,
                **kwargs
            )
            
            # Log Usage
            if hasattr(chat_completion, 'usage'):
                u = chat_completion.usage
                logger.info(f"🧠 Reasoning [{model}] {reasoning_effort}: {u.prompt_tokens}→{u.completion_tokens} tokens (total: {u.total_tokens})")

            message = chat_completion.choices[0].message
            reasoning = getattr(message, 'reasoning', None) or ""
            content = message.content or ""
            
            # Robust JSON extraction when content is empty
            if not content.strip() and reasoning:
                import re
                # Find the last complete JSON object in reasoning
                json_matches = list(re.finditer(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', reasoning))
                if json_matches:
                    content = json_matches[-1].group(0)
                    logger.warning(f"Extracted JSON from reasoning field (content was empty, found {len(json_matches)} candidates)")
            
            # Strip markdown code fences if present
            if content.strip().startswith("```"):
                import re
                fenced = re.search(r'```(?:json)?\s*([\s\S]*?)```', content)
                if fenced:
                    content = fenced.group(1).strip()
            
            if reasoning:
                logger.info(f"💭 CoT ({len(reasoning)} chars): {reasoning[:300]}...")
            
            return {"content": content, "reasoning": reasoning}
        except Exception as e:
            logger.error(f"Groq reasoning error [{model}]: {e}")
            raise

    async def generate_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        *,
        model: Optional[str] = None,
        tool_choice: str = "auto",
        max_tokens: int = 1024,
        temperature: float = 0.1,
        **kwargs
    ) -> Any:
        """
        Generate a chat completion with native Groq tool calling.

        Returns the raw `message` object from `choices[0].message` so the
        caller can inspect `.tool_calls`, `.content`, etc.
        """
        if not self.is_available():
            raise RuntimeError("Groq provider not initialized")

        effective_model = model or self.model_name
        try:
            extra_args = {}
            if self._is_gpt_oss(effective_model):
                # GPT-OSS reasoning models use max_completion_tokens and special reasoning params
                extra_args["max_completion_tokens"] = max_tokens
                # If tool_choice is required, we still need to pass it, but some reasoning models prefer auto
                chat_completion = await self._client.chat.completions.create(
                    messages=messages,
                    model=effective_model,
                    tools=tools,
                    tool_choice=tool_choice,
                    temperature=temperature,
                    reasoning_effort=kwargs.pop("reasoning_effort", "low"),
                    **extra_args,
                    **kwargs,
                )
            else:
                chat_completion = await self._client.chat.completions.create(
                    messages=messages,
                    model=effective_model,
                    tools=tools,
                    tool_choice=tool_choice,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    **kwargs,
                )

            # Log usage
            if hasattr(chat_completion, "usage") and chat_completion.usage:
                u = chat_completion.usage
                cached_tokens = self._extract_cached_tokens(u)
                self._last_usage = {
                    "prompt_tokens": getattr(u, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(u, "completion_tokens", 0) or 0,
                    "total_tokens": getattr(u, "total_tokens", 0) or 0,
                    "cached_tokens": cached_tokens,
                    "model": effective_model,
                }
                cache_suffix = f" | cached={cached_tokens}" if cached_tokens else ""
                logger.info(
                    f"🧬 Groq Tools Usage [{effective_model}]: "
                    f"{u.prompt_tokens}→{u.completion_tokens} tokens{cache_suffix}"
                )

            return chat_completion.choices[0].message
        except Exception as e:
            logger.error(f"Groq tool-calling error [{effective_model}]: {e}")
            raise

    async def generate_vision(
        self,
        text_prompt: str,
        image_b64: str,
        *,
        model: str = "meta-llama/llama-4-scout-17b-16e-instruct",
        max_tokens: int = 1024,
        temperature: float = 0.3,
        image_mime: str = "image/jpeg",
        **kwargs,
    ) -> str:
        """
        Generate a response from a multimodal vision model using Groq.

        Uses meta-llama/llama-4-scout-17b-16e-instruct which supports:
        - Image + text understanding
        - Tool use with images
        - JSON mode with images
        - Multi-turn visual conversations

        Args:
            text_prompt: The text question or instruction about the image.
            image_b64: Base64-encoded image string (JPEG or PNG).
            model: Vision-capable model ID.
            max_tokens: Max completion tokens.
            temperature: Sampling temperature.
            image_mime: MIME type of the image (image/jpeg or image/png).

        Returns:
            The model's text response describing/analyzing the image.
        """
        if not self.is_available():
            raise RuntimeError("Groq provider not initialized")

        try:
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": text_prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{image_mime};base64,{image_b64}",
                            },
                        },
                    ],
                }
            ]

            chat_completion = await self._client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_completion_tokens=max_tokens,
                **kwargs,
            )

            # Log usage
            if hasattr(chat_completion, "usage") and chat_completion.usage:
                u = chat_completion.usage
                cached_tokens = self._extract_cached_tokens(u)
                self._last_usage = {
                    "prompt_tokens": getattr(u, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(u, "completion_tokens", 0) or 0,
                    "total_tokens": getattr(u, "total_tokens", 0) or 0,
                    "cached_tokens": cached_tokens,
                    "model": model,
                }
                cache_suffix = f" | cached={cached_tokens}" if cached_tokens else ""
                logger.info(
                    f"👁️ Groq Vision [{model}]: "
                    f"{u.prompt_tokens}→{u.completion_tokens} tokens{cache_suffix}"
                )

            return chat_completion.choices[0].message.content or ""
        except Exception as e:
            logger.error(f"Groq vision error [{model}]: {e}")
            raise

    async def _generate_stream(self, prompt: str, max_tokens: int, temperature: float, **kwargs) -> AsyncGenerator[str, None]:
        """Internal async generator for streaming."""
        try:
            model = kwargs.pop("model", self.model_name)
            
            # Intelligent splitting for Zoned XML Architecture
            # Support both old <system_configuration> and new <zone_a_system_configuration> tags
            messages = []
            if "<zone_a_system_configuration>" in prompt:
                try:
                    parts = prompt.split("</zone_a_system_configuration>")
                    system_content = parts[0].replace("<zone_a_system_configuration>", "").strip()
                    user_content = parts[1].strip()
                    
                    if kwargs.get("response_format") and kwargs["response_format"].get("type") == "json_object":
                        if "json" not in system_content.lower():
                            system_content += "\nRespond in json format."
                        if "json" not in user_content.lower():
                            user_content += "\nRespond in json format."

                    messages = [
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": user_content}
                    ]
                    logger.debug(f"Split prompt into system ({len(system_content)} chars) + user ({len(user_content)} chars)")
                except Exception:
                    messages = [{"role": "user", "content": prompt}]
            elif "<system_configuration>" in prompt:
                try:
                    parts = prompt.split("</system_configuration>")
                    system_content = parts[0].replace("<system_configuration>", "").strip()
                    user_content = parts[1].strip()
                    
                    if kwargs.get("response_format") and kwargs["response_format"].get("type") == "json_object":
                        if "json" not in system_content.lower():
                            system_content += "\nRespond in json format."
                        if "json" not in user_content.lower():
                            user_content += "\nRespond in json format."

                    messages = [
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": user_content}
                    ]
                except Exception:
                    messages = [{"role": "user", "content": prompt}]
            else:
                messages = [{"role": "user", "content": prompt}]

            if self._is_gpt_oss(model):
                stream = await self._client.chat.completions.create(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_completion_tokens=max_tokens,
                    reasoning_effort=kwargs.pop("reasoning_effort", "low"),
                    include_reasoning=kwargs.pop("include_reasoning", False),
                    stream=True,
                    stream_options={"include_usage": True},
                    **kwargs
                )
            else:
                stream = await self._client.chat.completions.create(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=True,
                    stream_options={"include_usage": True},
                    **kwargs
                )
            
            # Track usage from final chunk
            usage_info = None
            async for chunk in stream:
                if hasattr(chunk, 'usage') and chunk.usage:
                    cached_tokens = self._extract_cached_tokens(chunk.usage)
                    usage_info = {
                        "prompt_tokens": chunk.usage.prompt_tokens,
                        "completion_tokens": chunk.usage.completion_tokens,
                        "total_tokens": chunk.usage.total_tokens,
                        "cached_tokens": cached_tokens,
                        "model": model
                    }
                    self._last_usage = usage_info
                    cache_suffix = f" | cached={cached_tokens}" if cached_tokens else ""
                    logger.info(f"🧬 Groq Stream Usage: {chunk.usage.prompt_tokens} prompt / {chunk.usage.completion_tokens} completion.{cache_suffix}")

                content = chunk.choices[0].delta.content
                if content:
                    yield content
            
            # Yield usage metadata as a sentinel after all text chunks
            if usage_info:
                yield {"__usage__": usage_info}
            else:
                self._last_usage = {}
        except Exception as e:
            logger.error(f"Groq streaming error: {e}")
            raise

    def is_available(self) -> bool:
        """Check if Groq client is ready."""
        return self._client is not None

    @staticmethod
    def _extract_cached_tokens(usage: Any) -> int:
        """Best-effort extraction of prompt cached tokens from Groq usage object."""
        try:
            details = getattr(usage, "prompt_tokens_details", None)
            if details is None and isinstance(usage, dict):
                details = usage.get("prompt_tokens_details")
            if details is None:
                return 0

            if isinstance(details, dict):
                return int(details.get("cached_tokens", 0) or 0)
            return int(getattr(details, "cached_tokens", 0) or 0)
        except Exception:
            return 0

    def get_last_usage(self) -> Dict[str, Any]:
        """Return usage metadata from most recent Groq request."""
        return dict(getattr(self, "_last_usage", {}) or {})
