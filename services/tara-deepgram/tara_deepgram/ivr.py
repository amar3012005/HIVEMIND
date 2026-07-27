"""IVR navigation — get past the phone tree to a human.

Campaign forensics showed the real ceiling on connect rate is not the pitch, it
is the switchboard: most B2B mains answer with "press 1 for…", and TARA had no
way to press anything, so those calls were dead on arrival while still burning
minutes (one ran 10m23s with an answering service).

This is deliberately DETERMINISTIC rather than an LLM tool call:
  * IVR menus are formulaic, so a regex reads them reliably;
  * an LLM round-trip costs 1-3s and phone trees time out and repeat;
  * pressing a wrong digit is worse than pressing none, so the matcher only
    fires on an explicit, scored keyword hit.

Pairs with dtmf.py, which synthesises the tones in-band because the carrier
exposes no send-DTMF API.
"""
from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Tuple

log = logging.getLogger("tara_dg.ivr")

# "press 1", "press one", "dial 2", "for sales, press 3", "press pound"
_WORD_DIGIT = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "pound": "#", "hash": "#", "star": "*", "asterisk": "*",
}
_PRESS_RE = re.compile(
    r"(?:press|dial|enter|select|choose)\s+(?:the\s+)?"
    r"(?:number\s+)?([0-9]|zero|one|two|three|four|five|six|seven|eight|nine|pound|hash|star|asterisk)\b",
    re.I,
)
# An option's label may precede the digit ("for sales, press 2") or follow it.
# Following forms vary a lot in the wild — "press 1 for sales", "press one to be
# connected to reception", "press 9 to reach an operator" — so match the
# introducer, not just "for".
_LABEL_AFTER_RE = re.compile(
    r"^\s*(?:for|to\s+be\s+connected\s+to|to\s+be\s+transferred\s+to|to\s+reach|"
    r"to\s+speak\s+(?:with|to)|to\s+contact)\s+(?:the\s+|an?\s+)?([^,.;]{3,60})",
    re.I,
)
# The backward window ENDS just before the "press" token, so this must not
# require it — match the trailing "for <label>" of e.g. "For new clients, press 2".
_LABEL_BEFORE_RE = re.compile(
    r"for\s+(?:the\s+|an?\s+)?([^,.;]{3,60}?)\s*[,.;]?\s*(?:please\s+)?$",
    re.I,
)

# What a cold outbound sales call actually wants, best target first. Reception or
# an operator beats a wrong department: a human can transfer, a voicemail cannot.
_GOAL_KEYWORDS: List[Tuple[int, Tuple[str, ...]]] = [
    (100, ("operator", "receptionist", "reception", "front desk", "speak to someone",
           "speak with someone", "representative", "assistant")),
    (80, ("new client", "new clients", "new matter", "new case", "prospective",
          "become a client", "consultation")),
    (60, ("sales", "business development", "partnerships", "vendor", "solicitation")),
    (40, ("general", "general inquiries", "all other", "other inquiries", "main menu")),
]
# Never choose these — they are dead ends for an outbound call.
_NEGATIVE = ("existing client", "current client", "billing", "payment", "fax",
             "directory", "voicemail", "leave a message", "emergency", "spanish",
             "hours and location", "directions")

# Any of these means we are talking to a machine, not a person.
_IVR_SIGNALS = ("press", "dial", "main menu", "for english", "para español",
                "if you know your party", "extension", "please hold", "your call is important")


def looks_like_ivr(text: str) -> bool:
    low = (text or "").lower()
    return any(s in low for s in _IVR_SIGNALS)


def _normalise_digit(token: str) -> str:
    token = token.strip().lower()
    return _WORD_DIGIT.get(token, token)


def parse_options(text: str) -> Dict[str, str]:
    """Map digit -> label for EVERY option in one IVR utterance.

    Menus routinely pack several options into one comma-joined sentence
    ("press 1 for billing, press 9 for the operator"), so scan all `press`
    matches and read each label from the window that belongs to it — forward to
    the next option, then backward if the label led instead.
    """
    text = text or ""
    matches = list(_PRESS_RE.finditer(text))
    options: Dict[str, str] = {}
    for idx, press in enumerate(matches):
        digit = _normalise_digit(press.group(1))
        nxt = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        prev_end = matches[idx - 1].end() if idx else 0
        label = ""
        after = _LABEL_AFTER_RE.search(text[press.end():nxt])
        if after:
            label = after.group(1)
        else:
            before = _LABEL_BEFORE_RE.search(text[prev_end:press.start()])
            if before:
                label = before.group(1)
        options.setdefault(digit, label.strip().lower())
    return options


def choose_digit(options: Dict[str, str]) -> Optional[str]:
    """Pick the digit most likely to reach a human who can transfer us.

    Returns None when nothing scores — pressing a guess is worse than waiting,
    because a wrong branch usually lands in voicemail with no way back.
    """
    best, best_score = None, 0
    for digit, label in options.items():
        if not label:
            continue
        if any(neg in label for neg in _NEGATIVE):
            continue
        for score, words in _GOAL_KEYWORDS:
            if any(w in label for w in words) and score > best_score:
                best, best_score = digit, score
    if best:
        return best
    # Unlabeled menu: 0 is the near-universal operator escape.
    if "0" in options:
        return "0"
    return None


class IvrNavigator:
    """Per-call IVR state. Bounded so a looping menu can't trap us."""

    MAX_PRESSES = 3

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.presses = 0
        self.seen: List[str] = []

    def on_caller_text(self, text: str) -> Optional[str]:
        """Return a digit string to send in-band, or None to stay silent."""
        if self.presses >= self.MAX_PRESSES or not looks_like_ivr(text):
            return None
        options = parse_options(text)
        if not options:
            return None
        digit = choose_digit(options)
        if not digit:
            log.info("ivr session=%s menu=%s -> no confident option", self.session_id, options)
            return None
        self.presses += 1
        self.seen.append(f"{digit}:{options.get(digit, '')}")
        log.info("ivr session=%s menu=%s -> pressing %s (%d/%d)",
                 self.session_id, options, digit, self.presses, self.MAX_PRESSES)
        return digit
