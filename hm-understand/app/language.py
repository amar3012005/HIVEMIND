from __future__ import annotations

import re

try:
    import langid
except ImportError:  # pragma: no cover - runtime dependency is pinned in image
    langid = None


def load_model():
    return langid


def detect_language(text: str, supplied: str | None = None) -> dict:
    if supplied:
        return {"primary": supplied.lower(), "confidence": None, "alternatives": [], "source": "caller"}
    sample = re.sub(r"\s+", " ", text).strip()[:20_000]
    if len(sample) < 40:
        return {"primary": "und", "confidence": None, "alternatives": [], "source": "insufficient_text"}
    try:
        model = load_model()
        if model:
            ranked = model.rank(sample)
            alternatives = [{"language": label, "score": round(float(score), 5)} for label, score in ranked[:3]]
            return {"primary": alternatives[0]["language"], "confidence": None,
                    "alternatives": alternatives, "source": "langid-97; scores_are_log_likelihoods"}
    except Exception:
        pass
    return {"primary": "und", "confidence": None, "alternatives": [], "source": "model_unavailable"}
