from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


try:
    from agentscope.agent import ReActAgent as AgentScopeReActAgent
    from agentscope.message import Msg as AgentScopeMsg
    from agentscope.tool import Toolkit as AgentScopeToolkit
except ImportError:  # pragma: no cover
    AgentScopeReActAgent = None
    AgentScopeMsg = None
    AgentScopeToolkit = None


if AgentScopeMsg is not None:
    Msg = AgentScopeMsg
else:
    @dataclass
    class Msg:  # pragma: no cover - simple runtime shim
        name: str
        content: Any
        role: str
        metadata: dict[str, Any] = field(default_factory=dict)


if AgentScopeToolkit is not None:
    Toolkit = AgentScopeToolkit
else:
    class Toolkit:  # pragma: no cover - simple runtime shim
        def __init__(self) -> None:
            self._tools: dict[str, Callable[..., Any]] = {}

        def register_tool_function(self, fn: Callable[..., Any], name: str | None = None) -> None:
            self._tools[name or fn.__name__] = fn

        async def call(self, name: str, *args: Any, **kwargs: Any) -> Any:
            result = self._tools[name](*args, **kwargs)
            if isinstance(result, Awaitable):
                return await result
            return result

        def list_tools(self) -> list[str]:
            return sorted(self._tools.keys())
