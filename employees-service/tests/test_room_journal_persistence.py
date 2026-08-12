import json

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
    def __init__(self):
        self.updated = None

    def transaction(self):
        return _Context()

    async def fetchrow(self, _query, _room_id, _org_id):
        return {"room_journal": [{"turn_id": "prior"}, {"turn_id": "current", "status": "running"}]}

    async def execute(self, _query, payload, room_id, org_id):
        self.updated = (json.loads(payload), room_id, org_id)


class _Pool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return _Context(self.connection)


@pytest.mark.asyncio
async def test_room_journal_entry_is_appended_atomically(monkeypatch):
    connection = _Connection()

    async def _pool():
        return _Pool(connection)

    monkeypatch.setattr(db, "init_pool", _pool)
    entry = {"turn_id": "current", "status": "complete"}

    assert await db.append_room_journal_entry("room-id", "org-id", entry)
    assert connection.updated == ([{"turn_id": "prior"}, entry], "room-id", "org-id")


class _ConnectionWithNTurns:
    """Simulates a room that already has N prior turns stored."""
    def __init__(self, prior_turns):
        self.prior_turns = [{"turn_id": f"t{i}"} for i in range(prior_turns)]
        self.updated = None

    def transaction(self):
        return _Context()

    async def fetchrow(self, _query, _room_id, _org_id):
        return {"room_journal": list(self.prior_turns)}

    async def execute(self, _query, payload, room_id, org_id):
        self.updated = (json.loads(payload), room_id, org_id)


@pytest.mark.asyncio
async def test_append_no_longer_destructively_trims_to_the_eager_window(monkeypatch):
    # The bug: append_room_journal_entry used to trim the STORED array to 8 on
    # every write, permanently deleting anything older — a room's real history
    # beyond turn 8 never existed to progressively load. Confirmed live
    # 2026-08-12: a room's own prior "Validate European AI Compliance Demand"
    # decision was already gone by the next turn. Now the storage cap is 200,
    # independent of the 8-entry eager-injection window.
    connection = _ConnectionWithNTurns(prior_turns=15)

    async def _pool():
        return _Pool(connection)

    monkeypatch.setattr(db, "init_pool", _pool)

    assert await db.append_room_journal_entry("room-id", "org-id", {"turn_id": "new"})
    stored, _, _ = connection.updated
    assert len(stored) == 16, "15 prior turns + 1 new must ALL survive — not trimmed to 8"


@pytest.mark.asyncio
async def test_get_room_journal_default_limit_still_returns_the_eager_window(monkeypatch):
    # Default behavior for the always-injected eager block must be unchanged:
    # last 8, even though storage now holds far more than that.
    connection = _ConnectionWithNTurns(prior_turns=20)

    async def _pool():
        return _Pool(connection)

    monkeypatch.setattr(db, "init_pool", _pool)

    result = await db.get_room_journal("room-id", "org-id")
    assert len(result) == 8
    assert [e["turn_id"] for e in result] == [f"t{i}" for i in range(12, 20)]


@pytest.mark.asyncio
async def test_get_room_journal_larger_limit_reaches_further_back(monkeypatch):
    # This is the progressive-load path: a Director asking for more history
    # than the eager window gets real older turns, because they were never
    # deleted from storage.
    connection = _ConnectionWithNTurns(prior_turns=20)

    async def _pool():
        return _Pool(connection)

    monkeypatch.setattr(db, "init_pool", _pool)

    result = await db.get_room_journal("room-id", "org-id", limit=15)
    assert len(result) == 15
    assert result[0]["turn_id"] == "t5", "must reach back to turn 5, well past the 8-turn eager window"
