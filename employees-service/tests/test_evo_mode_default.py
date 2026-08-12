"""Self-learning (evo) was confirmed live 2026-08-12: a real turn generated
genuinely useful lessons ("verify claims with external data", "state concrete
next steps with dates/owners") from its own verify verdict, persisted them,
and a follow-up turn read them straight back. It was correct and working,
just never turned on for any real room (defaulted to 'off' for a
never-configured room). Default flipped to 'on' — a room that never set
evo_mode should get self-learning by default now. A room that explicitly
stores 'off' must still get 'off' (this only changes the NULL/never-set case).
"""
import pytest

from hivemind_employees import db


class _Context:
    def __init__(self, value=None):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *_args):
        return False


class _Connection:
    def __init__(self, evo_mode_value):
        self.evo_mode_value = evo_mode_value

    async def fetchrow(self, *_args):
        if self.evo_mode_value is _MISSING_ROW:
            return None
        return {"evo_mode": self.evo_mode_value}


_MISSING_ROW = object()


class _Pool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return _Context(self.connection)


def _patched_pool(monkeypatch, evo_mode_value):
    connection = _Connection(evo_mode_value)

    async def _pool():
        return _Pool(connection)

    monkeypatch.setattr(db, "init_pool", _pool)


@pytest.mark.asyncio
async def test_never_configured_room_defaults_to_on(monkeypatch):
    # Column is NULL — a room that never touched this setting at all.
    _patched_pool(monkeypatch, None)
    assert await db.get_room_evo_mode("room-1", org_id="org-1") == "on"


@pytest.mark.asyncio
async def test_no_row_at_all_also_defaults_to_on(monkeypatch):
    _patched_pool(monkeypatch, _MISSING_ROW)
    assert await db.get_room_evo_mode("room-1", org_id="org-1") == "on"


@pytest.mark.asyncio
async def test_explicit_off_is_still_respected(monkeypatch):
    # The whole point of the fix: default changes, explicit override doesn't.
    _patched_pool(monkeypatch, "off")
    assert await db.get_room_evo_mode("room-1", org_id="org-1") == "off"


@pytest.mark.asyncio
async def test_explicit_on_still_works(monkeypatch):
    _patched_pool(monkeypatch, "on")
    assert await db.get_room_evo_mode("room-1", org_id="org-1") == "on"


@pytest.mark.asyncio
async def test_db_failure_fails_open_toward_on(monkeypatch):
    async def broken_pool():
        raise RuntimeError("db unavailable")
    monkeypatch.setattr(db, "init_pool", broken_pool)

    assert await db.get_room_evo_mode("room-1", org_id="org-1") == "on"
