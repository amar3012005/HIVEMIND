# -*- coding: utf-8 -*-
"""Cloudflare-AI-Gateway credential + chat model for AgentScope 2.0.8.

Why a subclass is required
--------------------------
Routing an AgentScope model through the gateway needs two things that the
stock ``OpenAICredential`` / ``OpenAIChatModel`` pair cannot express through the
Agent Service API:

1. **``base_url``** pointing at the gateway's OpenRouter route. This *is*
   available on ``OpenAICredential``, so it is set at credential-creation time
   (see ``install_on_credential``) and persisted with the credential record.
2. **``client_kwargs``** carrying ``default_headers`` (``cf-aig-authorization``,
   ``cf-aig-byok-alias``) and an ``http_client`` whose request hook strips the
   ``Authorization`` header the OpenAI SDK insists on sending.

Point 2 has no injection point: ``app/_service/_model.py`` constructs the model as

    model_cls(credential=credential, model=config.model, parameters=parameters)

with no ``client_kwargs`` argument. A subclass is therefore the clean way to get
the gateway headers in, rather than patching framework internals. It is also
exactly the extension mechanism AgentScope documents for custom providers:
``CredentialBase.get_chat_model_class()``.

The stock models stay untouched, so switching back to direct routing is a
credential-type change, not a code change.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Literal, Type

from pydantic import ConfigDict

from agentscope.credential import CredentialBase, OpenAICredential
from agentscope.model import OpenAIChatModel, ModelCard

from cloudflare_gateway import (
    MODEL_CALL_DEADLINE_S,
    deadline_stream,
    enabled,
    gateway_base_url,
    gateway_client_kwargs,
)

# Where the gateway-routed model cards live. ``ChatModelBase.list_models()``
# defaults to a ``_models`` directory sitting next to the *subclass's* source
# file — which for this module would be ``/app/_models``. The cards are shipped
# to ``/app/model_cards`` instead, so the path is passed explicitly.
MODEL_CARDS_DIR = os.getenv("AGENTSCOPE_MODEL_CARDS", "/app/model_cards")


class CloudflareGatewayOpenAICredential(OpenAICredential):
    """An OpenAI-compatible credential routed through Cloudflare AI Gateway.

    Extends ``OpenAICredential`` rather than replacing it, so it keeps the full
    stock contract (``organization``, ``base_url``, the OpenAI chat/embedding/TTS
    model classes) and the existing ``openai_credential``-shaped callers keep
    working.

    ``api_key`` is inherited and stays **schema-required**, because the API
    contract for an OpenAI credential expects one. In gateway mode the value is
    never transmitted: the BYOK alias supplies the provider key gateway-side and
    the SDK's ``Authorization`` header is stripped before egress. The frontend
    renders the field because it is required; operators can paste any placeholder.

    A future improvement is to mark the field optional and hide it in the form
    when the gateway is enabled — see the README's "known rough edges".
    """

    model_config = ConfigDict(title="Cloudflare AI Gateway (OpenRouter)")

    # MUST be a Literal: credentials are a pydantic discriminated union keyed on
    # `type`, and a plain `str` raises
    #   PydanticUserError: Model '…' needs field 'type' to be of type `Literal`
    # at request time (HTTP 500), not at import time. It also makes the field
    # render as a `const` in GET /credential/schemas, which is how the frontend
    # identifies the credential type.
    type: Literal["cloudflare_gateway_credential"] = "cloudflare_gateway_credential"
    """The credential type."""

    @classmethod
    def get_chat_model_class(cls) -> Type["OpenAIChatModel"]:
        """Return the gateway-aware chat model class."""
        return CloudflareGatewayChatModel


class CloudflareGatewayChatModel(OpenAIChatModel):
    """``OpenAIChatModel`` that applies the Cloudflare AI Gateway shim.

    Identical to the stock model except that ``client_kwargs`` are supplied
    internally, so the gateway headers and the Authorization-stripping HTTP
    client are always present regardless of how the model was constructed.
    """

    @classmethod
    def list_models(cls, custom_yaml_dir: str | None = None) -> list["ModelCard"]:
        """List the gateway-routed models.

        Overridden because the base implementation resolves the YAML directory
        relative to the *subclass's* source file, which would be ``/app/_models``.
        The cards ship to ``/app/model_cards``.

        This must live on the MODEL class, not the credential class: the service
        resolves the catalogue via ``credential.get_chat_model_class().list_models()``
        (see ``app/_router/_model.py``), so a credential-level override is never
        consulted.

        Falls back to the stock OpenAI catalogue when the directory is missing or
        empty, so a misconfigured path degrades to "no DeepSeek cards" instead of
        an empty model list that makes the credential unusable.
        """
        cards_dir = Path(custom_yaml_dir or MODEL_CARDS_DIR)
        if cards_dir.is_dir():
            cards = super().list_models(str(cards_dir))
            if cards:
                return cards
        return super().list_models()

    def __init__(
        self,
        credential: OpenAICredential,
        model: str,
        parameters: "OpenAIChatModel.Parameters | None" = None,
        **kwargs: Any,
    ) -> None:
        # Caller-supplied client_kwargs win over the gateway defaults, so this
        # class stays usable for a direct (non-gateway) override if ever needed.
        merged_client_kwargs = {**gateway_client_kwargs(), **kwargs.pop("client_kwargs", {})}

        # ``OpenAIChatModel`` forwards ``credential.base_url``; if the credential
        # predates the gateway being enabled, correct it here so a mixed fleet of
        # credential records still routes correctly.
        if enabled() and not credential.base_url:
            credential.base_url = gateway_base_url()

        super().__init__(
            credential=credential,
            model=model,
            parameters=parameters,
            client_kwargs=merged_client_kwargs,
            **kwargs,
        )

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        deadline = MODEL_CALL_DEADLINE_S
        try:
            result = await asyncio.wait_for(super().__call__(*args, **kwargs), timeout=deadline)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"model call exceeded wall-clock deadline of {deadline:g}s "
                f"(model={self.model})",
            ) from exc
        if hasattr(result, "__aiter__"):
            return deadline_stream(result, deadline, self.model)
        return result


def register() -> list[type[CredentialBase]]:
    """Credential classes to pass to ``create_app(extra_credentials=[...])``."""
    return [CloudflareGatewayOpenAICredential]


__all__ = [
    "CloudflareGatewayOpenAICredential",
    "CloudflareGatewayChatModel",
    "register",
]