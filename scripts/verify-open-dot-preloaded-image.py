#!/usr/bin/env python3
"""Validate a locally preloaded Open Dot cloud image before a scoped release."""
import argparse
import json
import re
import sys

ARTIFACT_LABEL = "com.singulance.open-dot.artifact"
SOURCE_LABEL = "org.opencontainers.image.revision"
EXPECTED_ARTIFACT = "singulance-open-dot-cloud"


def verify(image: object, expected_id: str, source_sha: str) -> str:
    if not isinstance(image, dict):
        raise ValueError("Docker image inspection must contain one image object")
    image_id = image.get("Id")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise ValueError("preloaded image has an invalid Docker image ID")
    if image_id != expected_id:
        raise ValueError("preloaded image ID does not match the pinned expected ID")
    if image.get("Os") != "linux" or image.get("Architecture") != "amd64":
        raise ValueError("preloaded Open Dot image is not linux/amd64")
    config = image.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    if not isinstance(labels, dict):
        raise ValueError("preloaded Open Dot image is missing artifact labels")
    if labels.get(ARTIFACT_LABEL) != EXPECTED_ARTIFACT:
        raise ValueError("preloaded image is not the Open Dot cloud artifact")
    if labels.get(SOURCE_LABEL) != source_sha:
        raise ValueError("preloaded Open Dot image source revision does not match")
    return image_id


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-id", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.expected_id):
        parser.error("--expected-id must be a pinned sha256 Docker image ID")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        parser.error("--source-sha must be a full 40-character commit")
    try:
        image = json.load(sys.stdin)
        print(verify(image, args.expected_id, args.source_sha))
    except (json.JSONDecodeError, ValueError) as error:
        print(f"FATAL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
