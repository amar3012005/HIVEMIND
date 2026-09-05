# Deep Agents governed-planning benchmark

This directory is deliberately isolated from production. It compares planning
ergonomics against three mock Composio Meta Tools and never receives customer
tokens, connected accounts, approvals, or provider writes.

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
DEEP_AGENT_MODEL=openai:gpt-5.5 python benchmark.py
```

The model must support tool calling and its provider key must be present in the
environment. Results are timing and tool-trajectory JSON only. They may inform
middleware design; they do not authorize a production runtime migration.
