import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
COMPOSE = (ROOT / 'infra' / 'docker-compose.hetzner.yml').read_text()
RELEASE = (ROOT / 'scripts' / 'release-canonical.sh').read_text()


class HarnessCloudflareCredentialTests(unittest.TestCase):
    def test_runner_receives_only_managed_gateway_references(self):
        for key in (
            'CLOUDFLARE_ACCOUNT_ID: ${CLOUDFLARE_ACCOUNT_ID:-}',
            'CLOUDFLARE_AI_GATEWAY_ID: ${CLOUDFLARE_AI_GATEWAY_ID:-}',
            'CLOUDFLARE_AI_GATEWAY_TOKEN: ${CLOUDFLARE_AI_GATEWAY_TOKEN:-}',
        ):
            self.assertIn(key, COMPOSE)
        self.assertNotIn('CLOUDFLARE_API_KEY: ${CLOUDFLARE_API_TOKEN:-}', COMPOSE)

    def test_release_preflight_accepts_supported_managed_reference(self):
        self.assertIn('CLOUDFLARE_API_KEY" || $1 == "CLOUDFLARE_API_TOKEN" || $1 == "CLOUDFLARE_AI_GATEWAY_TOKEN', RELEASE)

    def test_release_rewrites_both_shared_environment_file_forms(self):
        self.assertIn('s#env_file: \\[../.env\\]#env_file: [$ENVF]#g', RELEASE)
        self.assertIn('s#env_file: \\[../.env,#env_file: [$ENVF,#g', RELEASE)


if __name__ == '__main__':
    unittest.main()
