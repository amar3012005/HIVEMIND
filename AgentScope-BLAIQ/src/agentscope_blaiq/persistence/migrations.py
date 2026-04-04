from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine

from agentscope_blaiq.persistence.database import Base, get_engine


async def bootstrap_database(engine: AsyncEngine | None = None) -> None:
    """Create the schema for a fresh v1 deployment.

    This is the explicit bootstrap path used by the application lifespan.
    """

    active_engine = engine or get_engine()
    async with active_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
