"""HIVEMIND Digital Employees — Python sidecar service.

Hosts SlackAgents-backed WorkflowAgents, one per DigitalEmployee row.
Slack edge (Socket Mode) lives here; HIVEMIND memory + Slack action
gateway live in hm-core. This service never holds raw Slack tokens
directly — they stay encrypted in platform_integrations and are
resolved on demand via the HIVEMIND core REST API.
"""

__version__ = "0.1.0"
