# Active Goal Loop

No autonomous production goal is active by default.

Before starting a loop, define:

- one bounded objective and owner;
- isolated branch/worktree and base SHA;
- owned files/services;
- deterministic acceptance checks;
- security and tenant-isolation checks;
- maximum iterations/time and stop conditions;
- explicit production gate and rollback owner.

Loops may implement and verify source on task branches. They may not deploy,
migrate, restart, prune, rotate secrets, or modify customer data without the
explicit release workflow and human authorization required by the production
protocol.
