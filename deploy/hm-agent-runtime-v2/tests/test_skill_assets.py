import unittest
from pathlib import Path


REQUIRED_DOMAIN_SKILLS = {
    "prospect-research",
    "source-verification",
    "lead-qualification",
    "market-analysis",
    "competitive-analysis",
    "outbound-strategy",
    "financial-analysis",
    "web-research",
}


class SkillAssetTests(unittest.TestCase):
    def test_domain_skill_markdown_is_shipped_with_the_runtime(self):
        skills_dir = Path(__file__).resolve().parents[1] / "skills"
        available = {path.parent.name for path in skills_dir.glob("*/SKILL.md")}
        self.assertTrue(REQUIRED_DOMAIN_SKILLS <= available)
        for skill in REQUIRED_DOMAIN_SKILLS:
            self.assertGreater((skills_dir / skill / "SKILL.md").stat().st_size, 0)


if __name__ == "__main__":
    unittest.main()
