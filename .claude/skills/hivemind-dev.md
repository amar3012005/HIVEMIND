# HIVEMIND Development

1. Read `.claude/INSTRUCTIONS.md` and the relevant `decision_docs` record.
2. Use graph-first recon, then verify source, callers, tests, and Git history.
3. Add a Started journal entry and work in an isolated task branch.
4. Extend the canonical implementation; retire replaced legacy paths.
5. Add focused regression, tenant-isolation, and affected-consumer coverage.
6. Push the task branch and append a Committed journal entry with the SHA.
7. Merge/release only through the branch and production protocols.

No hardcoded tenant fixtures, secrets, broad catch fallbacks, test-only logic,
or unverified claims of storage/backend parity.
