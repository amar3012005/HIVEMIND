# Mobile design and notification repair

Packaged frontend source: `1fb4aef70b8098d199c4464002a124e28166320b`.
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

Simulator tap automation intermittently reports capture/no-window failures or leaves the screen unchanged. Full independent scrolling and post-refinement page interaction checks are not yet established. Build success is not a substitute for those checks. Physical iPhone and TestFlight acceptance remain separate.

Native artifact dashboard styling is a separate runner release. Its CSS-only source is based on the current live runner revision, rather than replacing newer Runtime context changes.
