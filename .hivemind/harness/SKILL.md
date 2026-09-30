---
name: harness
description: Develop and release the native DeepSeek Harness integration for HIVE-MIND BRAIN and HyperAgents, including tenant sessions, Schedule, Preview, and runner images.
---

# HIVE-MIND Harness

Start with [INSTRUCTIONS.md](INSTRUCTIONS.md). In the Harness checkout, read `harness-fe-guide.md` for the owning frontend file and `harness-development-playbook.md` for the fast local and runner release path. Those files live beside each other at the Harness repository root; find the active checkout by its Git remote instead of assuming a fixed worktree path.

For a Schedule or session persistence change, also read [tenant-schedule.md](playbooks/tenant-schedule.md). For a production release, use the existing [platform-release skill](../skills/platform-release/SKILL.md) and its runbook. Keep native Harness, Core, Control Plane, outer frontend, and VOICE as separate deployment owners.
