# -*- coding: utf-8 -*-
"""AgentScope ResourceAccessPolicy that asks hm-core. Fail closed."""
from __future__ import annotations

import logging
import os
from typing import Any

from agentscope.app.access import ResourceAccessPolicyBase, ResourceKind, ResourceRef

logger = logging.getLogger("hm-agent-runtime.access")


class HiveMindResourceAccessPolicy(ResourceAccessPolicyBase):
    """Cross-owner sharing is decided by hm-core, not AgentScope storage."""

    async def list_accessible(
        self,
        viewer_id: str,
        kind: ResourceKind,
        storage: Any,
    ) -> list[ResourceRef]:
        url = os.getenv("HM_CORE_URL", "").rstrip("/")
        if not url:
            return []
        try:
            import httpx

            headers = {
                "X-API-Key": os.getenv("HIVEMIND_MASTER_API_KEY", ""),
                "X-HM-User-Id": viewer_id,
            }
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(
                    f"{url}/internal/hivemind/resource-access",
                    params={"kind": str(kind)},
                    headers=headers,
                )
            if resp.status_code != 200:
                logger.warning("resource-access %s for %s", resp.status_code, kind)
                return []
            payload = resp.json()
            refs: list[ResourceRef] = []
            for item in payload.get("refs") or []:
                refs.append(
                    ResourceRef(
                        kind=kind,
                        owner_id=str(item["owner_id"]),
                        resource_id=str(item["resource_id"]),
                        permission=item.get("permission") or "read",
                    ),
                )
            return refs
        except Exception:
            logger.exception("resource-access failed; deny cross-owner")
            return []
