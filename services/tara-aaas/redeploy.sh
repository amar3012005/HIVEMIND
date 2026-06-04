#!/usr/bin/env bash
# Redeploy tara-aaas (the self-hosted TARA voice orchestrator) from THIS repo
# copy to the prod box, rebuild the image, and recreate the container with the
# existing env preserved.
#
# This repo (services/tara-aaas/) is the source of truth. The box copy at
# /opt/tara-aaas is a deploy artifact synced from here.
#
# Usage:  ./redeploy.sh           (run from services/tara-aaas/)
#         TARA_AAAS_HOST=myserver ./redeploy.sh
#
# Secrets (.env.deploy) live only on the box and are NOT synced/overwritten.
set -euo pipefail

HOST="${TARA_AAAS_HOST:-myserver}"
DEST="/opt/tara-aaas"

echo "→ sync source to ${HOST}:${DEST} (secrets/junk excluded)"
rsync -az \
  --exclude '__pycache__' --exclude '*.pyc' --exclude '.DS_Store' \
  --exclude '._*' --exclude '.env*' --exclude 'redeploy.sh' --exclude 'README.md' \
  ./ "${HOST}:${DEST}/"

echo "→ build image + recreate container (35 env vars preserved, CMD baked in Dockerfile)"
ssh "${HOST}" '
  set -e
  cd /opt/tara-aaas
  docker build -t tara-aaas:latest .
  docker inspect tara-aaas --format "{{json .Config.Env}}" \
    | python3 -c "import sys,json;open(\"/tmp/aaas.env\",\"w\").write(chr(10).join(json.load(sys.stdin))+chr(10))"
  docker rm -f tara-aaas >/dev/null
  docker run -d --name tara-aaas --network hmtest --restart unless-stopped \
    -p 8091:8090 --env-file /tmp/aaas.env tara-aaas:latest >/dev/null
  sleep 4
  docker ps --filter name=tara-aaas --format "{{.Names}} {{.Status}}"
  docker logs tara-aaas --tail 5 2>&1
'
echo "→ done"
