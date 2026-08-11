#!/usr/bin/env bash
set -euo pipefail

# Docker's userland proxy accepts published ports in the host INPUT path. Keep
# the legacy edge services reachable only from host-networked Caddy over `lo`.
ports=(8088 8090 8091 8095)

for port in "${ports[@]}"; do
  for firewall in iptables ip6tables; do
    while "$firewall" -C DOCKER-USER -p tcp --dport "$port" -m conntrack --ctstate NEW -j DROP 2>/dev/null; do
      "$firewall" -D DOCKER-USER -p tcp --dport "$port" -m conntrack --ctstate NEW -j DROP
    done
    if ! "$firewall" -C INPUT -i lo -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      "$firewall" -I INPUT 1 -i lo -p tcp --dport "$port" -j ACCEPT
    fi
    if ! "$firewall" -C INPUT -p tcp --dport "$port" -j DROP 2>/dev/null; then
      "$firewall" -I INPUT 2 -p tcp --dport "$port" -j DROP
    fi
  done
done
