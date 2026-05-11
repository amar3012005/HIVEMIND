# HIVEMIND Digital Employees — Python sidecar
# Runs alongside hm-core + hm-control-plane as `hm-employees` container.
# Built/deployed via Coolify on git push; locally via `docker build .`

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps:
# - curl for HEALTHCHECK + bootstrap calls to HIVEMIND core
# - build-essential + python3-dev for asyncpg native extension
# - ca-certificates for outbound HTTPS to Slack + LLM providers
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gcc \
        python3-dev \
        build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Install vendored SlackAgents (Apache 2.0)
COPY vendor/slackagents /app/vendor/slackagents
RUN pip install --no-cache-dir -e /app/vendor/slackagents

# 2. Install our wrapper + deps via pyproject
COPY pyproject.toml ./
COPY src/ ./src/
COPY README.md ./
COPY NOTICE ./
RUN pip install --no-cache-dir -e .

# Default port for FastAPI service
EXPOSE 8060

# Health check — Coolify + scripts/deploy.sh employees probe this
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8060/health || exit 1

CMD ["python", "-m", "hivemind_employees.main"]
