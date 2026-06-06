# hm-hermes — HIVEMIND's Hermes runtime (NousResearch).
# One container hosts tenant Hermes profiles (the "external agent brains").
# State (profiles, sessions, skills, cookies) persists in the /opt/data volume;
# HiveMind MCP remains the memory system of record (wired in Phase 3 via mcp.json).
#
# Base is the official image. We extend only to bake a healthcheck + the
# hm-control shim; runtime config/secrets come from env + the mounted volume.
FROM nousresearch/hermes-agent:latest

# Shim: lets hm-control drive jobs (reads a task spec, invokes Hermes, streams
# status). Completed in Phase 4; present here so the image is shim-ready.
COPY shim.mjs /opt/hm-hermes/shim.mjs

# Gateway exposes the OpenAI-compatible API on 8642; dashboard on 9119.
EXPOSE 8642 9119

# Liveness: gateway API must answer. (Path tolerant — 200/401/404 all prove the
# server is up; only connection failure is unhealthy.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8642/').then(r=>process.exit(0)).catch(()=>process.exit(1))" || exit 1

# Default command = run the gateway (state in /opt/data). Overridable for setup.
CMD ["gateway", "run"]
