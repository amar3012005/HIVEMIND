import importlib.util
import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "provision-open-dot-owner-binding.py"
SPEC = importlib.util.spec_from_file_location("open_dot_owner_binding", MODULE_PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class OwnerBindingConfigTests(unittest.TestCase):
    def test_writes_only_binding_values_and_keeps_private_exact_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            original = b"KEEP_THIS=byte-for-byte # literal\nPOSTGRES_USER=app\nPOSTGRES_DB=hivemind\nPOSTGRES_PASSWORD=p%ass\n"
            env_path.write_bytes(original)
            os.chmod(env_path, 0o600)
            content, values = module.env_values(env_path)
            module.write_binding(env_path, content, values,
                                 "12345678-1234-4234-8234-123456789abc",
                                 "abcdefab-cdef-4abc-8def-abcdefabcdef")
            updated = env_path.read_bytes()
            self.assertTrue(updated.startswith(original))
            self.assertIn(b"OPEN_DOT_ORGANIZATION_ID=12345678-1234-4234-8234-123456789abc\n", updated)
            self.assertIn(b"OPEN_DOT_USER_ID=abcdefab-cdef-4abc-8def-abcdefabcdef\n", updated)
            self.assertIn(b"OPEN_DOT_PUBLIC_URL=https://dots.singulancelabs.com\n", updated)
            backups = list(Path(directory).glob(".env.open-dot-binding.*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)

    def test_conflicting_existing_binding_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "OPEN_DOT_USER_ID=12345678-1234-4234-8234-123456789abc\n",
                encoding="utf-8",
            )
            original = env_path.read_bytes()
            content, values = module.env_values(env_path)
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    module.write_binding(original=content, values=values, path=env_path,
                                         organization_id="12345678-1234-4234-8234-123456789abc",
                                         user_id="abcdefab-cdef-4abc-8def-abcdefabcdef")
            self.assertEqual(env_path.read_bytes(), original)
            self.assertEqual(list(Path(directory).glob("*.bak")), [])

    def test_database_query_is_scoped_to_one_account_and_active_workspace_owner(self):
        self.assertIn("u.email = ${'amarsai2005@gmail.com'}", module.QUERY)
        self.assertIn("u.deleted_at IS NULL", module.QUERY)
        self.assertIn("uo.is_active = TRUE", module.QUERY)
        self.assertIn("uo.deactivated_at IS NULL", module.QUERY)
        self.assertIn("UPPER(o.name) = ${'SINGULANCE'}", module.QUERY)
        self.assertIn("uo.role = 'owner'", module.QUERY)
        self.assertIn("SET TRANSACTION READ ONLY", module.QUERY)
        self.assertIn("rows.length !== 1", module.QUERY)

    def test_network_uses_managed_postgres_alias_on_a_core_attached_network(self):
        core_networks = ["hivemind_default", "monitoring"]
        postgres_alias_networks = ["hivemind_default"]
        self.assertEqual(module.matching_networks(core_networks, postgres_alias_networks), ["hivemind_default"])
        self.assertEqual(module.matching_networks(core_networks, ["unrelated_postgres"]), [])
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn('"hm-postgres",', source)
        self.assertIn('"--read-only", "--cap-drop=ALL"', source)
        self.assertIn('"--security-opt=no-new-privileges:true"', source)


if __name__ == "__main__":
    unittest.main()
