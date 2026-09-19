from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENGINE = (ROOT / "src/hivemind_employees/hyper/engine.py").read_text()
API = (ROOT / "src/hivemind_employees/api_hyper_rooms.py").read_text()


def test_direct_depth_is_a_terminal_lead_execution_path():
    assert "async def _direct_turn" in ENGINE
    assert 'return await self._direct_turn(t0)' in ENGINE
    assert '"turn_mode": "direct"' in ENGINE


def test_direct_and_chat_bypass_report_verification_pipeline():
    assert 'result.get("turn_mode") in {"chat", "direct"}' in API

