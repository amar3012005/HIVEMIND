import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class NativeSchedulerConfigTests(unittest.TestCase):
    def test_single_runtime_owns_agentscope_scheduler_and_channel_worker(self):
        app_source = (ROOT / "app.py").read_text(encoding="utf-8")
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("enable_scheduler=ENABLE_SCHEDULER", app_source)
        self.assertIn("enable_channel_worker=ENABLE_CHANNEL_WORKER", app_source)
        self.assertIn('AGENTSCOPE_ENABLE_SCHEDULER: "1"', compose)
        self.assertIn('AGENTSCOPE_ENABLE_CHANNEL_WORKER: "1"', compose)
        self.assertIn("Exactly one replica may hold these", app_source)


if __name__ == "__main__":
    unittest.main()
