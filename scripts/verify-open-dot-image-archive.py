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


def member_once(saved: tarfile.TarFile, name: str):
    matches = [member for member in saved.getmembers() if member.name == name]
    if len(matches) != 1 or not matches[0].isfile():
        raise ValueError(f"Docker archive member is missing or not regular: {name}")
    stream = saved.extractfile(matches[0])
    if stream is None:
        raise ValueError(f"Docker archive member is unreadable: {name}")
    return stream


def inspect_archive(archive: Path, preloaded_ref: str, receipt_config_id: str) -> str:
    """Return the image ID Docker will expose after load.

    Legacy docker-save archives identify images by config digest. OCI archives
    identify the loaded image by the manifest digest; bind that manifest to the
    same config and every layer before accepting the alternate identity.
    """
    try:
        with tarfile.open(archive, mode="r:gz") as saved:
            manifest_stream = member_once(saved, "manifest.json")
            manifest = json.load(manifest_stream)
            if not isinstance(manifest, list) or len(manifest) != 1:
                raise ValueError("Docker archive must contain exactly one image")
            image = manifest[0]
            if not isinstance(image, dict) or image.get("RepoTags") != [preloaded_ref]:
                raise ValueError("Docker archive tag does not match receipt preloadedRef")
            config_name = image.get("Config")
            if not isinstance(config_name, str) or config_name.startswith("/") or ".." in Path(config_name).parts:
                raise ValueError("Docker archive has an invalid image config path")
            config_stream = member_once(saved, config_name)
            config_bytes = config_stream.read()
            config_id = "sha256:" + hashlib.sha256(config_bytes).hexdigest()
            if config_id != receipt_config_id:
                raise ValueError("Docker archive image config ID does not match receipt")
            config = json.loads(config_bytes)
            if not isinstance(config, dict) or config.get("os") != "linux" or config.get("architecture") != "amd64":
                raise ValueError("Docker archive image config is not the expected linux/amd64 image")
            diff_ids = config.get("rootfs", {}).get("diff_ids") if isinstance(config, dict) else None
            legacy_layers = image.get("Layers")
            if not isinstance(diff_ids, list) or not isinstance(legacy_layers, list) or len(diff_ids) != len(legacy_layers):
                raise ValueError("Docker archive layer list does not match image config")
            for layer_name, diff_id in zip(legacy_layers, diff_ids):
                if not isinstance(layer_name, str) or not isinstance(diff_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", diff_id):
                    raise ValueError("Docker archive contains an invalid layer identity")
                if layer_name.startswith("/") or ".." in Path(layer_name).parts:
                    raise ValueError("Docker archive contains an invalid layer path")
                member_once(saved, layer_name).close()

            # Older Docker archives have no OCI index and load with the config
            # digest as .Id. Newer saves may include a single OCI manifest and
            # Docker 29 reports that manifest digest as the loaded .Id.
            names = {member.name for member in saved.getmembers()}
            if "index.json" not in names:
                return config_id
            index = json.load(member_once(saved, "index.json"))
            descriptors = index.get("manifests") if isinstance(index, dict) else None
            if not isinstance(descriptors, list) or len(descriptors) != 1:
                raise ValueError("Docker archive OCI index must contain exactly one image")
            descriptor = descriptors[0]
            digest = descriptor.get("digest") if isinstance(descriptor, dict) else None
            if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                raise ValueError("Docker archive OCI manifest digest is invalid")
            platform = descriptor.get("platform")
            if platform is not None and (
                not isinstance(platform, dict)
                or platform.get("os") != "linux"
                or platform.get("architecture") != "amd64"
            ):
                raise ValueError("Docker archive OCI manifest is not the expected linux/amd64 image")
            manifest_name = "blobs/sha256/" + digest.removeprefix("sha256:")
            oci_manifest_bytes = member_once(saved, manifest_name).read()
            if "sha256:" + hashlib.sha256(oci_manifest_bytes).hexdigest() != digest:
                raise ValueError("Docker archive OCI manifest digest mismatch")
            oci_manifest = json.loads(oci_manifest_bytes)
            oci_config = oci_manifest.get("config") if isinstance(oci_manifest, dict) else None
            oci_layers = oci_manifest.get("layers") if isinstance(oci_manifest, dict) else None
            if not isinstance(oci_config, dict) or oci_config.get("digest") != config_id:
                raise ValueError("Docker archive OCI manifest config does not match receipt")
            config_blob = member_once(saved, "blobs/sha256/" + config_id.removeprefix("sha256:")).read()
            if config_blob != config_bytes:
                raise ValueError("Docker archive OCI config blob does not match receipt")
            if not isinstance(oci_layers, list) or len(oci_layers) != len(diff_ids):
                raise ValueError("Docker archive OCI layer list does not match image config")
            for layer, legacy_layer, diff_id in zip(oci_layers, legacy_layers, diff_ids):
                layer_digest = layer.get("digest") if isinstance(layer, dict) else None
                media_type = layer.get("mediaType") if isinstance(layer, dict) else None
                if not isinstance(layer_digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", layer_digest):
                    raise ValueError("Docker archive OCI layer digest is invalid")
                if media_type != "application/vnd.oci.image.layer.v1.tar":
                    raise ValueError("Docker archive OCI layer format is unsupported")
                if layer_digest != diff_id or legacy_layer != "blobs/sha256/" + diff_id.removeprefix("sha256:"):
                    raise ValueError("Docker archive OCI layers do not match legacy layer identities")
                blob_name = "blobs/sha256/" + layer_digest.removeprefix("sha256:")
                member_once(saved, blob_name).close()
            return digest
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
    loaded_image_id = inspect_archive(archive, preloaded_ref, image_id)
    return preloaded_ref, loaded_image_id, archive_sha


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
