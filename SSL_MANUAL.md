# HIVE-MIND SSL Setup Manual (Certbot + Caddy)

This guide documents how SSL was enabled for `hivemind.davinciai.eu` in this environment.

## 1. The Challenge (Port 80/443 Conflict)
On this server, port 80 and 443 are owned by the **Coolify Global Proxy (Traefik)**. Standard Certbot validation (Standalone) will fail because it cannot bind to port 80.

## 2. Methodology: DNS-01 Challenge
We used the **DNS-01 Challenge** via Certbot. This method verifies domain ownership by checking for a specific TXT record in your DNS, rather than needing to listen on a port.

### Commands to obtain the certificate:
```bash
certbot certonly --manual --preferred-challenges dns -d hivemind.davinciai.eu
```

1. Certbot provided a TXT record: `_acme-challenge.hivemind.davinciai.eu`.
2. The value `ctav8yNjYvsSo8e0TRo3tXa_aPEnTmZgGjPliHYyo2k` was added to the DNS provider.
3. Once verified, the certificates were saved to: `/etc/letsencrypt/live/hivemind.davinciai.eu/`.

## 3. Integration with HIVE-MIND
Instead of modifying the core application code to handle SSL, we used a **Caddy sidecar** container.

### Docker Compose Configuration
The certificates from the host (`/etc/letsencrypt`) are mounted directly into the Caddy container:

```yaml
services:
  caddy:
    image: caddy:latest
    ports:
      - "8050:443" # External Port 8050 -> SSL Port 443
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on:
      - app
```

### Caddyfile Configuration
Caddy handles the TLS handshake using the Let's Encrypt files and proxies traffic to the internal Node.js app:

```caddy
https://hivemind.davinciai.eu:443 {
    reverse_proxy app:3000
    tls /etc/letsencrypt/live/hivemind.davinciai.eu/fullchain.pem /etc/letsencrypt/live/hivemind.davinciai.eu/privkey.pem
}
```

## 4. Auto-Renewal Setup
Manual certificates do not renew automatically by default. We have set up a crontab entry to attempt renewal and restart the Caddy container to pick up new certificates:

### Crontab Entry (`crontab -e`):
```bash
0 */12 * * * certbot renew --quiet && docker compose -f /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/docker-compose.yaml restart caddy
```

## 5. Verification
To verify the SSL certificate is being served correctly on port 8050:

```bash
curl -v https://hivemind.davinciai.eu:8050/health
```
