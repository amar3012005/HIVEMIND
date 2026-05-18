# Deploy Playbook

## Topology

- **FE**: Vercel auto-deploy on push to `main` of `frontend/Da-vinci`
- **BE**: Hetzner `116.202.24.69` via Coolify, containers: hm-core, hm-control, postgres, qdrant, nango, nango-connect-ui, redis, caddy-api, caddy-core
- **Domains**: `hivemind.davinciai.eu` (FE), `api.hivemind.davinciai.eu` (BE/Nango), `core.hivemind.davinciai.eu` (core API)

## Standard deploy

### FE
```
git push  # main branch
# wait ~90s for Vercel build
# verify: hard-refresh FE page, check new main.<hash>.js chunk hash
```

### BE
```
git push
ssh root@116.202.24.69
cd /path/to/hivemind
git pull
docker compose -f docker-compose.coolify.yml up -d --no-deps <svc>
docker logs <svc> --tail 30
```

### Migration
```
ssh root@116.202.24.69
docker exec hm-core npx prisma migrate deploy
```

## Restart a service
```
ssh root@116.202.24.69 "docker restart <svc>"
```

## Rollback
```
git revert <bad-sha> && git push
# OR pin previous image tag in compose, redeploy
```

## Health checks
```
curl https://hivemind.davinciai.eu/                                    # FE
curl https://api.hivemind.davinciai.eu:8040/health                     # control-plane
curl https://core.hivemind.davinciai.eu:8050/health                    # core
curl https://api.hivemind.davinciai.eu:8042/                           # Nango
curl https://api.hivemind.davinciai.eu:8043/                           # Connect UI
```

## Caddy reload
```
ssh root@116.202.24.69 "docker exec caddy-api caddy reload --config /etc/caddy/Caddyfile"
```

## Firewall ports
8040 (control-plane), 8042 (Nango), 8043 (Connect UI), 8050 (core)
