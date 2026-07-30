# Phase 11: Runtime invitation and dedicated entry

The completed company dashboard now introduces Runtime as an explicit product
activation rather than relying only on background onboarding activation.

- A one-time invitation appears five seconds after an onboarded company loads.
- `RUN` opens a multi-select operating-focus board.
- `WAKE ME UP` persists the selected focuses as a standing HQ instruction and
  schedules a `user_first_activation` wake.
- `/hivemind/app/employees/runtime` renders the permanent Company HQ room as the
  dedicated Runtime experience.
- Runtime is a first-class sidebar entry; the HQ room is no longer duplicated
  in the Company Rooms list.
- The comprehensive production handoff is maintained in `HQ-runtime/README.md`.
