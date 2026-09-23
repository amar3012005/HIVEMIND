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
        seen = set()
        for scenario in fixture["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                seen.add(scenario["id"])
                execution_mode = {
                    "direct-answer": "direct",
                    "grounded-company-answer": "company_answer",
                    "company-work": "operating_plan",
                }[scenario["id"]]
                prompt = _build_workrun_prompt(
                    goal="Create a governed company deliverable",
                    hyperagent_slug=None,
                    playbook_id=None,
                    playbook_version=None,
                    scope={"company_context": {"mode": "minimal"}, "execution_mode": execution_mode},
                )
                for required in scenario.get("required", []):
                    if scenario["id"] == "direct-answer":
                        self.assertIn("not an operating plan", prompt)
                        self.assertIn("Answer immediately", prompt)
                    elif scenario["id"] == "grounded-company-answer":
                        self.assertIn("not an operating plan", prompt)
                        self.assertIn("smallest relevant context", prompt)
                    else:
                        self.assertIn(required, prompt)
                previous = -1
                for required in scenario.get("required_sequence", []):
                    current = prompt.index(required)
                    self.assertGreater(current, previous, required)
                    previous = current

        self.assertEqual(seen, {"direct-answer", "grounded-company-answer", "company-work"})


if __name__ == "__main__":
    unittest.main()
