import json
import unittest
from pathlib import Path

from app import _build_workrun_prompt


FIXTURE = Path(__file__).resolve().parents[1] / "evals" / "workrun-operating-os-golden.json"


class WorkRunOperatingOsGoldenTests(unittest.TestCase):
    """Lock the governed mode contract without fabricating an LLM evaluation.

    The fixture is intentionally declarative. A live model canary evaluates
    behavior separately after a non-production provider credential is supplied.
    """

    def test_all_golden_scenarios_are_present_in_the_native_opening_contract(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(fixture["contract"], "hivemind.agentscope.workrun-operating-os-golden.v1")
        prompt = _build_workrun_prompt(
            goal="Create a governed company deliverable",
            hyperagent_slug=None,
            playbook_id=None,
            playbook_version=None,
            scope={"company_context": {"mode": "minimal"}},
        )

        seen = set()
        for scenario in fixture["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                seen.add(scenario["id"])
                for required in scenario.get("required", []):
                    self.assertIn(required, prompt)
                scenario_prompt = prompt
                if scenario["id"] == "company-work":
                    scenario_prompt = prompt[prompt.index("For company work"):]
                previous = -1
                for required in scenario.get("required_sequence", []):
                    current = scenario_prompt.index(required)
                    self.assertGreater(current, previous, required)
                    previous = current

        self.assertEqual(seen, {"direct-answer", "grounded-company-answer", "company-work"})


if __name__ == "__main__":
    unittest.main()
