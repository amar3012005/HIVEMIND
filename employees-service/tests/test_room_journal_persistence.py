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
