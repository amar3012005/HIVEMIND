from __future__ import annotations

import re
from datetime import datetime, timezone

from dateutil import parser as date_parser


PATTERNS: dict[str, re.Pattern] = {
    "email": re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])"),
    "url": re.compile(r"https?://[^\s<>\]\[()]+", re.I),
    "ticket_id": re.compile(r"\b[A-Z][A-Z0-9]{1,15}-\d{1,10}\b"),
    "money": re.compile(r"(?<!\w)(?:€|\$|£|₹|USD|EUR|GBP|INR)\s?\d[\d.,]*(?:\s?(?:million|mio\.?|k|M))?(?!\w)", re.I),
    "percentage": re.compile(r"(?<!\w)\d+(?:[.,]\d+)?\s?%(?!\w)"),
    "date": re.compile(r"\b(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{2,4})|\d{4}-\d{2}-\d{2})\b"),
}

SIGNALS: list[tuple[str, re.Pattern, str]] = [
    ("decision", re.compile(r"\b(approved|decided|agreed|rejected|selected|beschlossen|genehmigt|vereinbart|aprobó|aprobado|decidió|acordó|rechazó|seleccionó)\b", re.I), "decision_verb"),
    ("task", re.compile(r"\b(will|must|should|need to|assigned to|responsible for|muss|soll|wird|übernimmt|debe|debería|tiene que|se encargará)\b", re.I), "commitment_or_assignment"),
    ("preference", re.compile(r"\b(prefer|likes?|dislikes?|rather|möchte|bevorzugt|gefällt|prefiere|le gusta|no le gusta)\b", re.I), "preference_verb"),
    ("event", re.compile(r"\b(on|at|during|meeting|launched|happened|am|um|während|startet|fand)\b", re.I), "event_or_time_marker"),
    ("uncertain", re.compile(r"\b(may|might|could|possibly|planned|subject to|pending|perhaps|vielleicht|könnte|vorbehaltlich|geplant|podría|podrían|quizá|quizás|tal vez|posiblemente|planeado|pendiente|sujeto a)\b", re.I), "uncertainty_or_condition"),
    ("uncertain", re.compile(r"\b(not|never|no longer|didn't|doesn't|nicht|kein|keine|niemals|no|nunca|ya no)\b", re.I), "negation"),
]


def extract_literals(text: str) -> list[dict]:
    output = []
    for label, pattern in PATTERNS.items():
        for match in pattern.finditer(text):
            output.append({"text": match.group(), "label": label, "score": None,
                           "start": match.start(), "end": match.end(), "extractor": "rule:literal-v1"})
    stopwords = {"the", "a", "an", "and", "but", "or", "he", "she", "it", "we", "they",
                 "der", "die", "das", "ein", "eine", "und", "aber", "er", "sie", "es",
                 "el", "la", "los", "las", "un", "una", "y", "pero", "él", "ella",
                 # Currency codes are already emitted as typed money literals;
                 # treating their uppercase spelling as an entity adds noise.
                 "eur", "usd", "gbp", "inr", "cad", "aud", "chf", "jpy"}
    # Only propose multi-token proper-name spans (or all-caps acronyms) from
    # casing alone. Single title-case words at sentence starts are usually
    # ordinary words ("On", "Budget", "Deployment"), not entities. GLiNER
    # can still return a single-token person/project mention with model evidence.
    for match in re.finditer(
        r"\b(?:[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){1,3}|[A-Z]{2,})\b",
        text, re.UNICODE,
    ):
        if len(match.group().strip()) > 1 and match.group().split()[0].casefold() not in stopwords:
            output.append({"text": match.group(), "label": "proper_name_candidate", "score": None,
                           "start": match.start(), "end": match.end(), "extractor": "rule:capitalized-span-v1"})
    return output


def sentence_spans(text: str):
    for match in re.finditer(r"[^.!?。！？\n]+(?:[.!?。！？]+|$)", text):
        start, end = match.span()
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if end - start >= 16:
            yield start, end


def extract_candidates(text: str) -> list[dict]:
    result = []
    for start, end in sentence_spans(text):
        sentence = text[start:end]
        signals = [reason for _, pattern, reason in SIGNALS if pattern.search(sentence)]
        kinds = [kind for kind, pattern, _ in SIGNALS if pattern.search(sentence)]
        if not signals:
            if len(sentence.split()) < 5 or not any(ch.isalpha() for ch in sentence):
                continue
            signals = ["declarative_statement_candidate"]
            kinds = ["fact"]
        # Uncertainty and negation override affirmative-looking classifications.
        kind = "uncertain" if "uncertain" in kinds else next((k for k in kinds if k != "uncertain"), "fact")
        result.append({"kind": kind, "text": sentence, "start": start, "end": end,
                       "signals": list(dict.fromkeys(signals)), "needs_review": True})
    return result


def parse_dates(text: str, timezone_name: str | None = None) -> list[dict]:
    output = []
    for match in PATTERNS["date"].finditer(text):
        try:
            parsed = date_parser.parse(match.group(), dayfirst=True, fuzzy=False)
            output.append({"text": match.group(), "iso": parsed.date().isoformat(),
                           "start": match.start(), "end": match.end(), "timezone": timezone_name})
        except (ValueError, OverflowError):
            continue
    return output
