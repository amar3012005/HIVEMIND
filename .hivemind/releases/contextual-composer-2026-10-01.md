# Contextual composer release

Frontend source: 5b09b86e (Da-vinci origin/main).
Worker version: 952bcf62-dce3-42c1-ac31-dace5fea5bf1.
Previous Worker version: febceb9c-a606-46cf-bc0a-dd09456ec048.

Outer frontend only; no native Harness source or runner change.
Uses two bounded authenticated memory reads, including Flashbacks. No model generation, direct connector scan, audit lookup, or Composio trigger subscriptions were added.

The leading query types through the existing composer paste handler into real editable text. User keyboard, pointer, or paste interaction stops automatic typing. Nothing is submitted. Three unboxed alternatives remain visible; selecting one replaces only an unchanged generated draft. A completed typing hint pulses three times, respecting reduced motion.

Verification: production build and artifact checks passed. Live authenticated new-session UI showed the full generated question in the editable composer with Send enabled and no submitted turn. Selecting an alternative replaced the generated question exactly without appending or sending. Source labels and dates remained visible. Screenshot: /tmp/hivemind-contextual-composer.jpg.

Known scope: templates use saved memory titles; new live app-event and shared hivemind_triggers integration remains future work. New translation keys currently use English fallbacks where locale translations are absent.
