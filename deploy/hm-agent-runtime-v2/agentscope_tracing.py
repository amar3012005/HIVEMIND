"""Opt-in OpenTelemetry wiring for AgentScope's native tracing middleware."""

from __future__ import annotations

import os
from typing import Any


def configure() -> dict[str, Any]:
    """Configure the process-wide OTel provider once, returning its status."""
    enabled = os.getenv("AGENTSCOPE_OTEL_ENABLED", "0") == "1"
    endpoint = os.getenv("AGENTSCOPE_OTEL_ENDPOINT", "").strip()
    if not enabled:
        return {"enabled": False, "reason": "disabled"}
    if not endpoint:
        return {"enabled": False, "reason": "missing_endpoint"}

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    if isinstance(trace.get_tracer_provider(), TracerProvider):
        return {"enabled": True, "reason": "already_configured", "endpoint": endpoint}

    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": os.getenv(
                    "AGENTSCOPE_OTEL_SERVICE_NAME", "hivemind-agent-runtime-v2"
                ),
                "service.version": os.getenv("AGENTSCOPE_RUNTIME_VERSION", "dev"),
            }
        )
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    return {"enabled": True, "reason": "configured", "endpoint": endpoint}
