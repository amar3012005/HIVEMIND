# HIVE-MIND SSL Certification Runbook

This runbook documents the certificate flow used for the HIVE-MIND production hosts:

- `https://hivemind.davinciai.eu`
- `https://api.hivemind.davinciai.eu:8040`
- `https://core.hivemind.davinciai.eu:8050`

It captures the DNS, issuance, and proxy steps we used to bring the live domains online.

## Overview

HIVE-MIND uses per-host TLS certificates, not one shared wildcard certificate.

- `hivemind.davinciai.eu` serves the frontend / landing site
- `api.hivemind.davinciai.eu:8040` serves the control plane
- `core.hivemind.davinciai.eu:8050` serves the memory engine and MCP endpoints

Each hostname must resolve in DNS and must have a valid certificate installed on the proxy that terminates TLS.

## Prerequisites

Before issuing certificates:

1. Add the DNS `A` record for each host to the production server IP.
2. Confirm the hostname resolves publicly.
3. Make sure the reverse proxy is listening on the expected port.
4. Confirm the application is reachable locally on the internal port before exposing it publicly.

For the HIVE-MIND deployment, the production IP used during setup was:

- `116.202.24.69`

## Certificate Flow

### 1. Create or confirm the DNS record

For each hostname, add a DNS record such as:

```text
api.hivemind.davinciai.eu  A  116.202.24.69
core.hivemind.davinciai.eu A  116.202.24.69
```

If you use a wildcard host for other subdomains, that does not replace the explicit `A` record for the critical hosts above.

### 2. Request the TLS certificate

For Let’s Encrypt DNS validation, create the TXT record provided by the ACME client.

The TXT record name follows this pattern:

```text
_acme-challenge.<hostname>
```

Examples:

- `_acme-challenge.api.hivemind.davinciai.eu`
- `_acme-challenge.core.hivemind.davinciai.eu`

Add the TXT value exactly as provided by the certificate request, wait for propagation, and then complete issuance.

### 3. Install the certificate on the proxy

Once the cert is issued, install it on the TLS-terminating proxy for that host.

In our deployment, we used Caddy sidecars:

- `hivemind-caddy` for the frontend / root host
- `hivemind-caddy-api` for the control plane
- the core service proxy for `core.hivemind.davinciai.eu`

### 4. Restart the service and proxy

After the certificate is installed, restart the application container and the proxy sidecar so the new certificate and route mapping are loaded.

For the live cutover we used:

```bash
docker restart hm-core
docker restart control-plane-s0k0s0k40wo44w4w8gcs8ow0
docker restart hivemind-caddy
docker restart hivemind-caddy-api
```

If your container names differ, restart the equivalent app and proxy containers for the host you changed.

### 5. Verify HTTPS

Verify the endpoint returns `200` and the certificate subject matches the host:

```bash
curl -I https://core.hivemind.davinciai.eu:8050/health
curl -I https://api.hivemind.davinciai.eu:8040/health
curl -I https://hivemind.davinciai.eu/
```

Expected results:

- HTTP `200`
- valid TLS certificate for the hostname
- no default proxy certificate

## Production Host Mapping

Final production mapping used by HIVE-MIND:

| Host | Purpose | Port |
|------|---------|------|
| `hivemind.davinciai.eu` | Frontend | `443` or proxy-mapped |
| `api.hivemind.davinciai.eu` | Control plane | `8040` |
| `core.hivemind.davinciai.eu` | Memory engine + MCP | `8050` |

## Common Mistakes

- Issuing a cert for the root host and expecting it to cover a separate subdomain automatically.
- Adding the TXT challenge to the wrong hostname.
- Updating DNS but forgetting to restart the proxy.
- Restarting the container but not the TLS proxy sidecar.
- Leaving old frontend or MCP configs pointed at the previous host.

## What We Learned

The working pattern for HIVE-MIND is:

1. Resolve hostnames in DNS.
2. Issue a separate certificate per active host.
3. Install the cert on the matching proxy.
4. Restart the app and proxy.
5. Verify `health` and browser access.

That sequence was enough to bring the frontend, control plane, and core engine online with the new domain split.
