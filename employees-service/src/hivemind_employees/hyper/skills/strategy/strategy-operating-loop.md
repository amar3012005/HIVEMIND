---
when: An HQ strategy assignment must build ONE keystone strategy artifact progressively across attempts, never restarting from scratch and never regressing a field that already passed.
---
Treat strategy as an operating lifecycle that ACCUMULATES, not a document you rewrite each turn.

MONOTONIC RULE — the most important rule here. If `prior_attempt.<key>` is present in your inputs, it is YOUR OWN previous draft. Copy every field of it forward verbatim unless you are actively improving that field. Then spend this turn only on the fields named in `unmet_checks`. Never drop, blank, or shorten a field that was already populated. A retry that returns fewer populated fields than its own previous draft is a failed retry, even if what it returns is well written.

Work the ladder in order. Each rung consumes the rung above it, so a later rung is never guessable without the earlier one:

1. DIAGNOSIS — name the one structural fact about this market that makes the status quo untenable for the buyer. Rumelt's kernel: a strategy without a diagnosis is a wish.
2. WEDGE — the exact segment plus the buying TRIGGER you win on. A trigger is a dated, external forcing event (a regulation deadline, an audit, a funding round, a migration), not a preference. "AI for enterprises" is not a wedge; "German BaFin-regulated lenders in the 12 months before their DORA attestation" is.
3. POSITIONING — built strictly on the wedge, against the competitive alternative the buyer would actually pick instead (including "do nothing in a spreadsheet").
4. OFFER — what is bought, how value is framed, what makes the price feel small next to the trigger's cost.
5. CHANNELS — where this exact segment already gathers. Must contain both `organic` and `paid`, each with a one-line rationale tied to the wedge.
6. MOTIONS — the executable bridge: outreach email angles, TARA call profiles, campaign concepts. These are DERIVED from rungs 1-5, so they inherit the wedge's specificity.
7. MEASURES — the one metric that proves or kills the wedge, and the window to judge it in.

EVIDENCE VS JUDGEMENT — never confuse these, and never use the distinction as an excuse. Facts about the world (market size, named rivals, what a competitor charges) must be grounded in retained canon or live web findings, cited. Recommendations (positioning, channel mix, next motions, offer framing) are YOUR professional judgement derived from that evidence. "Not present in the supplied evidence" is NEVER a valid reason to omit a recommendation field — authoring a recommendation from thin evidence is the job. State low-confidence recommendations as assumptions to test, with the test named. Refusing to recommend is the one guaranteed failure.

Name real things. Real segments, real named rivals, real channels, real trigger dates. If a rival genuinely cannot be named, say so explicitly and name the category or incumbent behaviour you displace instead — never leave the field empty and never write a generic sentence about "competitors focusing on scale over compliance".

Return the COMPLETE artifact in one response with every field populated. Never defer a field to a later turn and never return a partial artifact with a gap note where a recommendation belongs.
