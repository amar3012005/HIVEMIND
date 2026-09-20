# -*- coding: utf-8 -*-
"""Opt-in OpenTelemetry setup for the native AgentScope tracing middleware.

AgentScope's ``TracingMiddleware`` owns agent/model/tool spans. HIVE only
installs the provider/exporter and does not create a second tracing vocabulary.
Tracing is intentionally disabled without an explicit OTLP traces endpoint so
local development never exports prompts, tool arguments, or company evidence.
"""

from __future__ import annotations

import logging
import os


_log = logging.getLogger("hm-agent-runtime.observability")


def configure_tracing() -> bool:
    """Install a process-wide OTLP trace exporter when explicitly configured.

    ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`` follows the OpenTelemetry standard;
    the HIVE-prefixed alias is provided for the runtime compose environment.
    A pre-existing SDK provider is left untouched so embedded/test hosts remain
    authoritative over their telemetry lifecycle.
    """
    endpoint = (
        os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip()
        or os.getenv("AGENTSCOPE_OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    )
    if not endpoint:
        return False

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:
        _log.warning("OTLP tracing requested but dependencies are unavailable: %s", exc)
        return False

    if isinstance(trace.get_tracer_provider(), TracerProvider):
        _log.info("OpenTelemetry provider already configured; preserving existing provider")
        return True

    provider = TracerProvider(resource=Resource.create({
        "service.name": os.getenv("OTEL_SERVICE_NAME", "hm-agent-runtime-v2"),
        "service.version": os.getenv("HM_RUNTIME_VERSION", "unknown"),
    }))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    _log.info("AgentScope OpenTelemetry tracing enabled")
    return True
