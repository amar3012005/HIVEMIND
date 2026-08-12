"""Deterministic contact-grounding gate (2026-08-13).

Two live incidents shipped invented emails from different LLM call sites
(a debate round, a work-order worker) — each fixed at its own prompt, but
that's whack-a-mole: any new call site can leak the same way. This is the
one non-LLM-judged backstop: any email/phone asserted in the deliverable
must appear verbatim in the room's real gathered evidence, independent of
which call site produced the text and independent of the LLM verifier's
own judgment.
"""
from hivemind_employees.api_hyper_rooms import _unsupported_contact_claims


def test_fabricated_email_not_in_evidence_is_flagged():
    text = "Contact: María López (mlopez@bde.es) is the compliance officer."
    evidence = ["WEB: European Central Bank supervisory register (landing page, no named contacts)."]
    out = _unsupported_contact_claims(text, evidence)
    assert out, "a fabricated email with zero evidence backing must be flagged"


def test_email_verbatim_in_evidence_is_not_flagged():
    text = "Contact: real.person@bde.es confirmed via the ECB register."
    evidence = ["WEB: ECB register lists real.person@bde.es as the DPO contact."]
    assert _unsupported_contact_claims(text, evidence) == []


def test_no_contacts_in_text_is_a_noop():
    text = "The market is large and growing; no individual contact named here."
    assert _unsupported_contact_claims(text, []) == []


def test_fabricated_phone_not_in_evidence_is_flagged():
    text = "Call +493012345678 to reach the office directly."
    out = _unsupported_contact_claims(text, ["WEB: generic company landing page, no phone listed."])
    assert out


def test_phone_verbatim_in_evidence_is_not_flagged():
    text = "Reach them at +493012345678."
    evidence = ["CONNECTOR: contact record — phone +493012345678"]
    assert _unsupported_contact_claims(text, evidence) == []


def test_case_insensitive_email_match():
    text = "Reach out to Contact@Example.COM for details."
    evidence = ["WEB: official page lists contact@example.com as the inbox."]
    assert _unsupported_contact_claims(text, evidence) == []
