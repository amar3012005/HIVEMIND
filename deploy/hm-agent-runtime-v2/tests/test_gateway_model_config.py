import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import app


class _Storage:
    def __init__(self, records):
        self.records = records

    async def list_credentials(self, user_id):
        self.last_user_id = user_id
        return self.records


class GatewayModelConfigTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_storage = app.app.state.storage

    def tearDown(self):
        app.app.state.storage = self.original_storage

    async def test_existing_gateway_credential_is_bound_to_the_workrun_session(self):
        storage = _Storage([
            SimpleNamespace(
                id="credential-existing",
                data={"type": "cloudflare_gateway_credential"},
            ),
        ])
        app.app.state.storage = storage

        with patch(
            "agentscope.app._router._credential.create_credential",
            new=AsyncMock(),
        ) as create_credential:
            config = await app._ensure_gateway_chat_model_config("user-1")

        self.assertEqual(storage.last_user_id, "user-1")
        create_credential.assert_not_awaited()
        self.assertEqual(config["type"], "cloudflare_gateway_credential")
        self.assertEqual(config["credential_id"], "credential-existing")
        self.assertTrue(config["model"])
        self.assertEqual(config["parameters"], {"parallel_tool_calls": False})

    async def test_missing_gateway_credential_is_minted_before_session_dispatch(self):
        app.app.state.storage = _Storage([])

        with patch(
            "agentscope.app._router._credential.create_credential",
            new=AsyncMock(return_value=SimpleNamespace(credential_id="credential-new")),
        ) as create_credential:
            config = await app._ensure_gateway_chat_model_config("user-1")

        create_credential.assert_awaited_once()
        request = create_credential.await_args.kwargs["body"]
        self.assertEqual(request.data["type"], "cloudflare_gateway_credential")
        self.assertEqual(config["credential_id"], "credential-new")


if __name__ == "__main__":
    unittest.main()
