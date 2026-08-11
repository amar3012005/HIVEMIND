"""Bounded, provider-free Campaign Room policy load check.

Run directly from ``employees-service``. This exercises concurrent roster,
model, and debate-policy selection only; it cannot invoke an LLM or connector.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time

from hivemind_employees import api_hyper_rooms


PARTICIPANTS = [
    {"id": "strategist", "slug": "strategist", "_lane": "Strategist"},
    {"id": "creative", "slug": "creative", "_lane": "Communicator"},
    {"id": "reviewer", "slug": "reviewer", "_lane": "Skeptic"},
    {"id": "researcher", "slug": "researcher", "_lane": "Researcher"},
    {"id": "operator", "slug": "operator", "_lane": "Builder"},
]


async def run_check(iterations: int, concurrency: int) -> dict:
    semaphore = asyncio.Semaphore(concurrency)

    async def one(index: int) -> None:
        async with semaphore:
            roster = api_hyper_rooms._campaign_primary_roster(PARTICIPANTS)
            rounds = api_hyper_rooms._campaign_debate_rounds(
                {"risks": ["regulated"]} if index % 10 == 0 else {"goal": "awareness"},
            )
            models = api_hyper_rooms._campaign_models()
            assert len(roster) == 3
            assert rounds == (2 if index % 10 == 0 else 1)
            assert models[2] == "gpt-oss-120b"

    started = time.perf_counter()
    await asyncio.gather(*(one(index) for index in range(iterations)))
    elapsed = time.perf_counter() - started
    return {
        "iterations": iterations,
        "concurrency": concurrency,
        "provider_calls": 0,
        "elapsed_ms": round(elapsed * 1000, 2),
        "operations_per_second": round(iterations / elapsed, 2) if elapsed else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=32)
    args = parser.parse_args()
    iterations = max(1, min(args.iterations, 10_000))
    concurrency = max(1, min(args.concurrency, 64))
    print(json.dumps(asyncio.run(run_check(iterations, concurrency)), sort_keys=True))


if __name__ == "__main__":
    main()
