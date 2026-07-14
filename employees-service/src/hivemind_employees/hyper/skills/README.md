# Room METHOD Skills

One folder per room kind (`market`, `content`, `business`, `outreach`, `strategy`, `general`).
Each skill is a markdown file:

```
---
when: one-liner the planner sees in the catalog
---

FULL METHOD BODY — evidence-forcing contract the room follows.
```

Progressive disclosure: the planner sees only `name — when`; the body loads onto the
room blackboard only when selected (or via a reactor `NEED: skill <name>` request).
Add a skill = drop a new `.md` file. Malformed files are skipped with a warning.
