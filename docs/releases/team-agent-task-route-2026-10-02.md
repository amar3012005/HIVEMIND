# Your Team task route correction

Native Harness source: `88965c70d36967c48e15ef7393e9a86d600795c6`.

- Team selection waits for the native agent selection receipt, then opens that blank session on `/hivemind/app/employee/harness/session/<id>`.
- Native recent-session projection subscribes to route changes and immediately switches between Brain recents and Your agent tasks, retaining durable owner avatars/names and room-topic hover text.
- Existing native session and agent execution remain in place.

Release image: `hivemind/harness-chat:sha-88965c70d3-team-route`.
Digest: `sha256:fad36b3753019ab7b213ab6b61437fb5f45b4948d2b8a0e96aa05b48460d2231`.
Base includes the Think capabilities, PDF font fix, and latest background-job update (`bafe2f41d4`).
Rollback image: `hivemind/harness-chat:sha-5b526ca008-team-route`.
Manifest: `/root/releases/manifests/hyperagents/team-route-88965c70d3`.

Focused TypeScript and full pre-push host/client compilation passed. Runner profile verification passed; production is healthy and sibling container identities were unchanged. Only the native runner was released.

Live browser verification: clicked Elena in Your Team from Overview. Native receipt selected Elena, URL became `/hivemind/app/employee/harness/session/session-d19f97ec-d9c0-4946-8e82-84df36cb1d85`, headline became OS, and Your agent tasks appeared immediately with Ravi/Elena avatars and names. Draft stayed empty; no task was sent. Screenshot: `/tmp/hivemind-team-task-route.png`.
