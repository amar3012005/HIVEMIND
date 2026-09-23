FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/models/huggingface \
    HM_UNDERSTAND_MODEL_REVISION=f227d3cd637bd4e6757ae143935316d062393341 \
    HM_UNDERSTAND_MODEL_ID=gliner-community/gliner_small-v2.5

WORKDIR /srv/hm-understand
RUN apt-get update && apt-get install -y --no-install-recommends curl libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv==0.7.3
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
ENV OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    TOKENIZERS_PARALLELISM=false \
    HM_UNDERSTAND_TORCH_THREADS=2
COPY app ./app
COPY models.lock.json ./models.lock.json
RUN addgroup --system app && adduser --system --ingroup app app \
    && mkdir -p /opt/models \
    && chown -R app:app /srv/hm-understand /opt/models
USER app
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/health || exit 1
CMD ["/srv/hm-understand/.venv/bin/uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "8090"]
