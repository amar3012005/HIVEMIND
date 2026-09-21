import os
import unittest
from unittest.mock import patch

from app import _runtime_identity


class RuntimeIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_identity_exposes_the_immutable_build_ref_only_to_authenticated_callers(self):
        with patch.dict(os.environ, {"HM_BUILD_REF": "c666df704"}, clear=False):
            identity = await _runtime_identity(user_id="hm-core-user")
        self.assertEqual(identity, {"runtime": "hm-agent-runtime-v2", "build_ref": "c666df704"})


if __name__ == "__main__":
    unittest.main()
