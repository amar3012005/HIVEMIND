import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
COMPOSE = (ROOT / 'infra' / 'docker-compose.hetzner.yml').read_text()
RELEASE = (ROOT / 'scripts' / 'release-canonical.sh').read_text()


class HarnessCloudflareCredentialTests(unittest.TestCase):
    def test_runner_prefers_managed_api_token_before_gateway_fallback(self):
        self.assertIn(
            'CLOUDFLARE_API_KEY: ${CLOUDFLARE_API_KEY:-${CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_AI_GATEWAY_TOKEN:-}}}',
            COMPOSE,
        )

    def test_release_preflight_accepts_supported_managed_reference(self):
        self.assertIn('CLOUDFLARE_API_KEY" || $1 == "CLOUDFLARE_API_TOKEN" || $1 == "CLOUDFLARE_AI_GATEWAY_TOKEN', RELEASE)


if __name__ == '__main__':
    unittest.main()
