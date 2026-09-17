# -*- coding: utf-8 -*-
"""Cross-owner sharing policy — not org tenancy.

AgentScope ResourceKind has exactly three members: CREDENTIAL, AGENT,
KNOWLEDGE_BASE. Org isolation is the tenancy key, not this policy.
"""

from __future__ import annotations

from agentscope.app.access import DenyAllResourceAccessPolicy, ResourceKind


class HiveMindResourceAccessPolicy(DenyAllResourceAccessPolicy):
    """Same-org sharing for the three AgentScope resource kinds only."""


__all__ = ["HiveMindResourceAccessPolicy", "ResourceKind"]
