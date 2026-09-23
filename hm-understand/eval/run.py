from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from pathlib import Path
from urllib.request import Request, urlopen

FIXTURES = Path(__file__).parent / "fixtures" / "ner.jsonl"


def load_fixtures():
    return [json.loads(line) for line in FIXTURES.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser(description="Run the local hm-understand annotated smoke corpus.")
    parser.add_argument("--url", default="http://127.0.0.1:8090", help="hm-understand base URL")
    args = parser.parse_args()
    fixtures = load_fixtures()
    body = {"source": {"id": "hm-understand-ner-eval", "revision": "fixture-v1"},
            "blocks": [{"id": row["id"], "text": row["text"], "language": row["language"]} for row in fixtures]}
    request = Request(f"{args.url.rstrip('/')}/v1/analyze", data=json.dumps(body, ensure_ascii=False).encode(),
                      headers={"content-type": "application/json"}, method="POST")
    started = time.perf_counter()
    with urlopen(request, timeout=300) as response:
        result = json.loads(response.read())
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    by_id = {block["block_id"]: block for block in result.get("blocks", [])}
    counts = defaultdict(Counter)
    citation_checks = []
    outputs = []
    for fixture in fixtures:
        block = by_id.get(fixture["id"], {})
        text = fixture["text"]
        gold = {(value, label.lower()) for value, label in fixture["gold"]}
        predicted = {(row["text"], row["label"].lower()) for row in block.get("mentions", [])}
        true_positive = gold & predicted
        counts[fixture["language"]].update({"tp": len(true_positive), "fp": len(predicted - gold), "fn": len(gold - predicted)})
        for row in block.get("mentions", []):
            evidence = row["evidence"]
            citation_checks.append(text[evidence["start"]:evidence["end"]] == evidence["quote"] == row["text"])
        outputs.append({"id": fixture["id"], "language": block.get("language", {}).get("primary", "und"),
                        "predicted": sorted([list(pair) for pair in predicted]),
                        "gold": sorted([list(pair) for pair in gold]),
                        "candidate_kinds": [item["kind"] for item in block.get("candidates", [])]})

    def scores(counter):
        tp, fp, fn = counter["tp"], counter["fp"], counter["fn"]
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        return {"tp": tp, "fp": fp, "fn": fn, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}

    total = Counter()
    for values in counts.values():
        total.update(values)
    print(json.dumps({"pipeline_version": result.get("pipeline_version"), "model_versions": result.get("model_versions"),
                      "complete": result.get("complete"), "elapsed_ms": elapsed_ms,
                      "span_validity": {"valid": sum(citation_checks), "total": len(citation_checks)},
                      "entity_scores": {"micro": scores(total), "by_language": {k: scores(v) for k, v in sorted(counts.items())}},
                      "examples": outputs,
                      "notice": "Small smoke corpus only; scores are diagnostic, not production quality estimates."},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
