# Mobile design and notification repair

Packaged frontend source: `0ab2897186b1c7526a97104d2bc67c8427619fab`.
Design references are saved in the frontend task checkout under `artifacts/mobile-design-20261012`.

## Implemented

- Sidebar notification dropdown portals outside the header. The header's broad 40px button rule is narrowed to direct header controls. Real titles and descriptions wrap naturally; timestamps and unread markers retain their saved semantics. The list is independently scrollable and viewport bounded.
- Refined HIVEMIND glass material on notification and meeting controls, with native Reduce Transparency and Increase Contrast fallbacks.
- Upload document rows preserve filenames, tags, selection, details and existing actions. Bulk actions wrap within the phone viewport.
- Connectors retain native Slack and Composio flows, with larger titles and actions.
- Meeting statistics are expandable. Recording remains the existing recorder action and is visually prioritized.

## Verified

- Notification component tests: 2 passed, covering portal isolation, long content, exact-row selection, focus restoration, dismissal and focus containment.
- Notification polling tests: 4 passed, including no automatic attention popups and preserved lifecycle-email behavior.
- Native origin/navigation checks: 2 passed.
- Production web compilation and signed Xcode simulator builds passed.
- Packaged asset sync and native configuration checks passed.
- Actual signed-in iPhone 18 Pro Max simulator showed readable real notification rows without overlap, descriptions, timestamps and continuation below the visible list. Dismissed sidebar was also observed.
- The final refined mobile package launched from the user's existing Xcode project with the authenticated roster preserved.

## Remaining acceptance

Switching Device Hub to the compact simulator window restored usable tap input. The dropdown was opened, scrolled to the older 19-day notice, allowed to settle after native overscroll, and closed; rows remained readable and the sidebar was restored. Screenshot: `notifications-fixed.png`. The final package also showed the refined upload controls and meeting-note statistics disclosure and recording surface. Populated connector and artifact acceptance is incomplete: the native connector request was captured returning HTTP 401, and the artifact catalog previously reported incomplete history. Native CP sessions are configured with a one-hour lifetime without renewal; expiry is a possible cause, not proven from the banner alone. No authentication policy was weakened. Physical iPhone and TestFlight acceptance remain separate.

Native artifact dashboard styling is deployed as `hivemind/harness-chat:sha-6db0a078f9b9-mobile-artifacts`, image ID `sha256:abac4954e4e6664b0400d093d4099aa71d716f3222647e1c97f89dfb1cbeca53`. The complete diff from base `3b70533e0afabc86c76cb1e85df8e6c01d20f3b4` is one artifact CSS file. Eight library tests, normal push checks, actual-image compilation checks and runner health passed. The cutover preserved sibling container identities. Rollback manifest: `/root/releases/mobile-artifact-6db0a078f9b9/rollback-image.json`. This proves deployment, not populated preview acceptance.
