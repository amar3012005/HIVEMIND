from __future__ import annotations

import httpx
import re
from urllib.parse import urlparse

try:
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover
    BeautifulSoup = None

from agentscope_blaiq.contracts.evidence import Citation, EvidenceFinding, SourceRecord


def _normalize_url(url: str) -> str:
    normalized = (url or "").strip()
    if not normalized:
        raise ValueError("URL cannot be empty.")
    parsed = urlparse(normalized)
    if not parsed.scheme:
        normalized = f"https://{normalized}"
        parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("URL must use http:// or https://.")
    if not parsed.netloc:
        raise ValueError("URL host is missing.")
    return normalized


async def fetch_url_summary(url: str) -> tuple[SourceRecord, EvidenceFinding, Citation]:
    url = _normalize_url(url)
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
    if BeautifulSoup is not None:
        soup = BeautifulSoup(response.text, "html.parser")
        title = (soup.title.string or url).strip() if soup.title else url
        text = " ".join(soup.get_text(" ", strip=True).split())
    else:
        title_match = re.search(r"<title>(.*?)</title>", response.text, re.I | re.S)
        title = title_match.group(1).strip() if title_match else url
        text = " ".join(re.sub(r"<[^>]+>", " ", response.text).split())
    excerpt = text[:500]
    source = SourceRecord(source_id=url, source_type="web", title=title, location=url)
    finding = EvidenceFinding(
        finding_id=f"web:{abs(hash(url))}",
        title=title,
        summary=excerpt[:240],
        source_ids=[source.source_id],
        confidence=0.6,
    )
    citation = Citation(source_id=source.source_id, label=title, excerpt=excerpt[:180], url=url)
    return source, finding, citation
