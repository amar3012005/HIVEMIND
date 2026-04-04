from __future__ import annotations

import json
from collections.abc import AsyncIterator

from agentscope_blaiq.contracts.events import StreamEvent


async def encode_sse(events: AsyncIterator[StreamEvent]) -> AsyncIterator[str]:
    async for event in events:
        yield f"data: {event.model_dump_json()}\n\n"
    yield "data: [DONE]\n\n"
