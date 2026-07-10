#!/usr/bin/env bash
set -euo pipefail

# Docker exposes published ports before ordinary host firewall policy. Keep the
# legacy edge services reachable only through the host-networked Caddy proxy.
ports=(8088 8090 8091 8095)

for port in "${ports[@]}"; do
  for firewall in iptables ip6tables; do
    if ! "$firewall" -C DOCKER-USER -p tcp --dport "$port" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
      "$firewall" -I DOCKER-USER -p tcp --dport "$port" -m conntrack --ctstate NEW -j DROP
    fi
  done
done
