import unittest
import asyncio
import json
from pathlib import Path

from agentscope.message import ToolCallBlock
from agentscope.state import AgentState
from agentscope.tool import Toolkit


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

    def test_agentscope_skill_viewer_loads_full_instructions_on_demand(self):
        """The model sees metadata first; AgentScope loads SKILL.md on invocation."""
        async def verify():
            toolkit = Toolkit(skills_or_loaders=["/app/skills/prospect-research"])
            schemas = await toolkit.get_tool_schemas()
            skill_schema = next(item["function"] for item in schemas if item["function"]["name"] == "Skill")
            self.assertIn("skill", skill_schema["parameters"]["required"])
            self.assertNotIn("# Prospect research", skill_schema["description"])

            call = ToolCallBlock(
                id="skill-proof",
                name="Skill",
                input=json.dumps({"skill": "prospect-research"}),
            )
            responses = []
            async for response in toolkit.call_tool(call, AgentState()):
                responses.append(response)
            self.assertTrue(responses)
            text = responses[-1].content[0].text
            self.assertIn("# Prospect research", text)
            self.assertIn("Search and read first-party sources", text)

        asyncio.run(verify())


if __name__ == "__main__":
    unittest.main()
