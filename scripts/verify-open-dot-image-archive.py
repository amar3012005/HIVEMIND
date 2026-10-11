#!/usr/bin/env python3
"""Validate a staged private Open Dot image archive against its CI receipt."""
import argparse
import hashlib
import json
import re
import stat
import tarfile
from pathlib import Path


def regular_file(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"not a regular file: {path}")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_archive(archive: Path, preloaded_ref: str, image_id: str) -> None:
    try:
        with tarfile.open(archive, mode="r:gz") as saved:
            manifests = [member for member in saved.getmembers() if member.name == "manifest.json"]
            if len(manifests) != 1 or not manifests[0].isfile():
                raise ValueError("Docker archive must contain one regular manifest.json")
            manifest_stream = saved.extractfile(manifests[0])
            if manifest_stream is None:
                raise ValueError("Docker archive manifest is unreadable")
            manifest = json.load(manifest_stream)
            if not isinstance(manifest, list) or len(manifest) != 1:
                raise ValueError("Docker archive must contain exactly one image")
            image = manifest[0]
            if not isinstance(image, dict) or image.get("RepoTags") != [preloaded_ref]:
                raise ValueError("Docker archive tag does not match receipt preloadedRef")
            config_name = image.get("Config")
            if not isinstance(config_name, str) or config_name.startswith("/") or ".." in Path(config_name).parts:
                raise ValueError("Docker archive has an invalid image config path")
            configs = [member for member in saved.getmembers() if member.name == config_name]
            if len(configs) != 1 or not configs[0].isfile():
                raise ValueError("Docker archive image config is missing or not regular")
            config_stream = saved.extractfile(configs[0])
            if config_stream is None:
                raise ValueError("Docker archive image config is unreadable")
            config_id = "sha256:" + hashlib.sha256(config_stream.read()).hexdigest()
            if config_id != image_id:
                raise ValueError("Docker archive image config ID does not match receipt")
    except (tarfile.TarError, OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid Docker image archive: {error}") from error


def verify(archive: Path, receipt_path: Path, registry_image: str, source_sha: str) -> tuple[str, str, str]:
    regular_file(receipt_path)
    if receipt_path.stat().st_size > 1024 * 1024:
        raise ValueError("image transfer receipt is too large")
    receipt = json.loads(receipt_path.read_bytes())
    if not isinstance(receipt, dict):
        raise ValueError("invalid image transfer receipt")
    if receipt.get("registryImage") != registry_image:
        raise ValueError("receipt registry image mismatch")
    if receipt.get("sourceSha") != source_sha:
        raise ValueError("receipt source SHA mismatch")
    image_id = receipt.get("imageId")
    preloaded_ref = receipt.get("preloadedRef")
    archive_sha = receipt.get("archiveSha256")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise ValueError("invalid receipt image ID")
    if preloaded_ref != f"hivemind/open-dot:transfer-{source_sha}":
        raise ValueError("receipt preloaded reference mismatch")
    if not isinstance(archive_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", archive_sha):
        raise ValueError("invalid receipt archive SHA256")
    regular_file(archive)
    actual = file_sha256(archive)
    if actual != archive_sha:
        raise ValueError("Open Dot image archive SHA256 mismatch")
    inspect_archive(archive, preloaded_ref, image_id)
    return preloaded_ref, image_id, archive_sha


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--registry-image", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        raise SystemExit("FATAL: invalid Open Dot source SHA")
    try:
        print("\t".join(verify(args.archive, args.receipt, args.registry_image, args.source_sha)))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"FATAL: invalid Open Dot image transfer: {error}") from error
