from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from agentscope_blaiq.runtime.config import settings


class Base(DeclarativeBase):
    pass


_engine: AsyncEngine | None = None
_session_local: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine, _session_local
    if _engine is None:
        _engine = create_async_engine(settings.database_url, future=True, echo=False)
        _session_local = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)
    return _engine


def get_session_local() -> async_sessionmaker[AsyncSession]:
    global _session_local
    if _session_local is None:
        get_engine()
    assert _session_local is not None
    return _session_local


async def get_db() -> AsyncIterator[AsyncSession]:
    async with get_session_local()() as session:
        yield session
