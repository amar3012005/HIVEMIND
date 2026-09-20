# Lifecycle announcements and popup delivery

## Objective

Make lifecycle and product updates reliable, useful, and operable without a
frontend release. A durable inbox notification is the source of truth; a popup
is a single-use presentation of that same event.

## Delivery model

1. Day 0 is emitted only after onboarding evidence is complete.
2. Day 1 is scheduled for 09:00 in the workspace owner's timezone on the next
   local calendar morning. Day 2 waits for a sealed Day 1 report, then targets
   the following local morning. Founder/credit gates remain authoritative at
   the Core boundary.
3. Platform operators create a typed announcement with copy, facts, Humation
   agent IDs, audience, placement, schedule, CTA, and inbox requirement.
4. Core evaluates audience server-side, writes the inbox receipt first, and
   persists per-user presentation/action state.
5. The app renders one eligible presentation globally across Brain, OS, Voice,
   rooms, and artifact pages. Dismissal or CTA action prevents a repeat after
   refresh; the durable notice remains readable from the notification inbox.

## Operator controls

`admin.hivemind.singulancelabs.com` provides drafts, edit, schedule, publish,
pause, archive, and new-version actions, with delivery, dismissal, and CTA
metrics. The admin form supports facts, approved routes/Cal.com CTAs, targeted
audiences, and Humation agent IDs. Reader announcements have an explicit web
artifact field: operators supply the stored web-artifact UUID plus optional
title/source metadata; Core validates the reference and the app loads the
tenant-scoped preview rather than a raw external page.

## Day-to-day operating procedure

1. Start a draft with a stable key such as `product.voice.september`.
2. Select placement: `toast` for a short bottom-left update, `dialog` for an
   important decision, `reader` for a stored crawl/report, or `banner` for a
   low-interruption notice.
3. Set the schedule, audience, facts, optional Humation agents, and approved
   CTA. Leave the durable inbox requirement on for user-facing updates.
4. Save the draft, inspect it in the operator list, and publish when ready.
5. Pause or archive to stop future eligibility. Use **New version** rather
   than republishing a dismissed announcement when an update must be seen
   again; dismissals/actions are intentionally durable per user and version.

## Verification and release

- Unit-test timezone/DST scheduling, no-repeat delivery, safe CTA validation,
  Day 0/Day 1 lifecycle contracts, and referral gates.
- Apply one additive Core migration for announcement and delivery records.
- Recreate only `hm-core`; deploy the existing Cloudflare frontend Worker.
- Verify health, an authenticated announcement canary, a persisted inbox row,
  one-time dismissal, Day 1 schedule, and the referral founder gate.
