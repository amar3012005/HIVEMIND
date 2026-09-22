# hm-agent-runtime-v2 — Phase 1 image
#
# Built FROM the repo root context so the build can see deploy/hm-agent-runtime-v2/.
# python:3.12-slim because AgentScope requires >=3.11 and 3.12 has the best
# wheel coverage; 3.13/3.14 still leave gaps in some transitive deps.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# curl is needed by the compose healthcheck; ca-certificates for outbound TLS
# (model providers, MCP servers, hubs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- dependencies first, so app.py edits do not invalidate the pip layer -----
COPY deploy/hm-agent-runtime-v2/requirements.txt /app/requirements.txt
RUN pip install --upgrade pip \
 && pip install -r /app/requirements.txt

# --- application -------------------------------------------------------------
COPY deploy/hm-agent-runtime-v2/app.py /app/app.py
COPY deploy/hm-agent-runtime-v2/cloudflare_gateway.py /app/cloudflare_gateway.py
COPY deploy/hm-agent-runtime-v2/gateway_credential.py /app/gateway_credential.py
COPY deploy/hm-agent-runtime-v2/hm_auth.py /app/hm_auth.py
COPY deploy/hm-agent-runtime-v2/hm_bridge.py /app/hm_bridge.py
COPY deploy/hm-agent-runtime-v2/workspace_backend.py /app/workspace_backend.py
COPY deploy/hm-agent-runtime-v2/agent_middlewares.py /app/agent_middlewares.py
COPY deploy/hm-agent-runtime-v2/agentscope_tracing.py /app/agentscope_tracing.py
COPY deploy/hm-agent-runtime-v2/resource_access.py /app/resource_access.py
COPY deploy/hm-agent-runtime-v2/hive_access_policy.py /app/hive_access_policy.py
COPY deploy/hm-agent-runtime-v2/hive_toolkit_groups.py /app/hive_toolkit_groups.py
COPY deploy/hm-agent-runtime-v2/hive_scheduler.py /app/hive_scheduler.py
COPY deploy/hm-agent-runtime-v2/model_capabilities.py /app/model_capabilities.py
# The `extra_agent_tools` factory. app.py imports this at module load, so a
# missing COPY is a hard ImportError at container start, not a degraded feature.
COPY deploy/hm-agent-runtime-v2/extra_agent_tools.py /app/extra_agent_tools.py
COPY deploy/hm-agent-runtime-v2/computer_executor.py /app/computer_executor.py

# Compact, on-disk AgentScope skills.  They are discovered progressively by
# the agent; they must be in the immutable image rather than hot-patched into
# a running container.
COPY deploy/hm-agent-runtime-v2/skills /app/skills

# Model cards for the gateway-routed DeepSeek models. Tells the frontend the
# real context/output limits and modality, instead of relying on defaults.
COPY deploy/hm-agent-runtime-v2/model_cards /app/model_cards

# Static web UI (single-page chat console) served at `/` by app.py.
COPY deploy/hm-agent-runtime-v2/static /app/static

# Workspace root. In Phase 1 LocalWorkspaceManager writes here, which is why it
# is a declared volume in docker-compose.yml — otherwise every `docker compose
# down` would silently discard agent working files.
RUN mkdir -p /data/workspaces
VOLUME ["/data/workspaces"]

# Drop privileges. The workspace volume is chowned so the app can write to it.
RUN useradd --create-home --uid 10001 appuser \
 && chown -R appuser:appuser /app /data

# The host's docker group GID is passed in at build time (see compose) so the
# non-root user can reach the mounted docker socket — needed when a workspace
# backend (or an MCP) wants to drive containers. Harmless in Phase 1, where the
# LocalWorkspaceManager does not use Docker at all.
ARG DOCKER_GID=0
RUN if [ "$DOCKER_GID" != "0" ]; then \
      getent group "$DOCKER_GID" >/dev/null || groupadd -g "$DOCKER_GID" dockergrp; \
      GRP=$(getent group "$DOCKER_GID" | cut -d: -f1); \
      usermod -aG "$GRP" appuser; \
    else \
      # Docker Desktop materializes a mounted socket as root:root inside the
      # Linux VM even when the macOS host socket reports a different GID. The
      # socket itself is an explicit compose mount; adding group 0 here only
      # makes that opted-in capability usable by the non-root runtime user.
      usermod -aG root appuser; \
    fi

USER appuser

EXPOSE 8000

# curl rather than a python one-liner: keeping the probe simple makes a failure
# obvious in `docker ps`. Hits /livez, not /health — /health now requires auth
# (it enumerates component topology), and a liveness probe must not need a
# credential or the orchestrator would kill a healthy container.
HEALTHCHECK --interval=10s --timeout=3s --start-period=25s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8000/livez || exit 1

CMD ["python", "app.py"]
