# TARA AaaS — single-service voice pipeline (STT + tara_stream + TTS in-proc).
FROM python:3.11-slim

# webrtcvad needs build tools; audioop is builtin on 3.11.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tara_aaas/ ./tara_aaas/

ENV PYTHONUNBUFFERED=1
EXPOSE 8090

# Single worker (asyncio I/O-bound; scale via replicas behind LB).
CMD ["uvicorn", "tara_aaas.app:app", "--host", "0.0.0.0", "--port", "8090", "--ws-ping-interval", "20"]
