from __future__ import annotations

import os
import json
import hashlib
import logging
from threading import Lock
from pathlib import Path

from huggingface_hub import snapshot_download

_model = None
_lock = Lock()
_model_error: str | None = None
_model_attempted = False
_model_loading = False
_model_loaded_tensors = 0
_model_checkpoint_tensors = 0
MODEL_ID = os.getenv("HM_UNDERSTAND_MODEL_ID", "gliner-community/gliner_small-v2.5")
MODEL_REVISION = os.getenv("HM_UNDERSTAND_MODEL_REVISION", "f227d3cd637bd4e6757ae143935316d062393341")
_model_cpu_threads = 0
logger = logging.getLogger(__name__)


def configure_cpu_threads(torch_module, requested: str | int | None = None) -> int:
    """Keep intra/inter-op CPU parallelism within the container's small quota."""
    raw = requested if requested is not None else os.getenv("HM_UNDERSTAND_TORCH_THREADS", "2")
    try:
        threads = max(1, min(4, int(raw)))
    except (TypeError, ValueError):
        threads = 2
    torch_module.set_num_threads(threads)
    try:
        torch_module.set_num_interop_threads(1)
    except RuntimeError:
        # PyTorch only permits setting inter-op threads before parallel work;
        # retaining its current value is safer than failing model startup.
        pass
    return threads


def checkpoint_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as checkpoint_file:
        for chunk in iter(lambda: checkpoint_file.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_model():
    global _model, _model_error, _model_attempted, _model_loading, _model_loaded_tensors, _model_checkpoint_tensors, _model_cpu_threads
    if _model is not None:
        return _model
    if _model_attempted:
        return None
    with _lock:
        if _model is not None:
            return _model
        if _model_attempted:
            return None
        _model_attempted = True
        _model_loading = True
        try:
            from gliner import GLiNER
            from gliner.config import GLiNERConfig
            from safetensors import safe_open
            from transformers import AutoTokenizer
            import torch
            _model_cpu_threads = configure_cpu_threads(torch)
            local_path = snapshot_download(
                repo_id=MODEL_ID,
                revision=MODEL_REVISION,
                allow_patterns=["model.bf16.safetensors", "gliner_config.json", "config.json", "tokenizer.json",
                                "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "spm.model"],
            )
            manifest_path = Path(__file__).resolve().parents[1] / "models.lock.json"
            with manifest_path.open("r", encoding="utf-8") as manifest_file:
                manifest = json.load(manifest_file)
            checkpoint_path = Path(local_path) / "model.bf16.safetensors"
            expected_digest = manifest["entity_model"]["sha256"]
            if checkpoint_sha256(checkpoint_path) != expected_digest:
                raise ValueError("pinned GLiNER checkpoint SHA256 does not match models.lock.json")
            # GLiNER's hub mixin materializes the entire safetensors checkpoint
            # as a Python dict before copying it into the model. That doubles
            # peak RSS and OOMs an otherwise viable CPU container. Load each
            # tensor into its already-allocated parameter instead.
            config_path = Path(local_path) / "gliner_config.json"
            with config_path.open("r", encoding="utf-8") as config_file:
                config = GLiNERConfig(**json.load(config_file))
            tokenizer = AutoTokenizer.from_pretrained(local_path, cache_dir=os.getenv("HF_HOME"))
            model = GLiNER(config, tokenizer=tokenizer, encoder_from_pretrained=False,
                           cache_dir=os.getenv("HF_HOME"))
            if (config.class_token_index == -1 or config.vocab_size == -1) and not config.labels_encoder:
                model.resize_token_embeddings(add_tokens=["[FLERT]", config.ent_token, config.sep_token])
            targets = model.model.state_dict(keep_vars=True)
            loaded = set()
            with safe_open(str(checkpoint_path), framework="pt", device="cpu") as checkpoint:
                checkpoint_keys = checkpoint.keys()
                with __import__("torch").no_grad():
                    for name in checkpoint_keys:
                        target = targets.get(name)
                        if target is None:
                            continue
                        tensor = checkpoint.get_tensor(name)
                        if tuple(target.shape) != tuple(tensor.shape):
                            raise ValueError(f"checkpoint shape mismatch for {name}")
                        target.copy_(tensor)
                        loaded.add(name)
                        del tensor
            coverage = len(loaded) / max(1, len(checkpoint_keys))
            _model_loaded_tensors = len(loaded)
            _model_checkpoint_tensors = len(checkpoint_keys)
            if coverage < 0.95:
                raise ValueError(f"only loaded {len(loaded)}/{len(checkpoint_keys)} GLiNER checkpoint tensors")
            logger.info("Loaded %s/%s pinned GLiNER checkpoint tensors", len(loaded), len(checkpoint_keys))
            model.to("cpu")
            model.eval()
            _model = model
            _model_error = None
        except Exception as error:  # service remains useful for deterministic extractors
            _model_error = f"{type(error).__name__}: {error}"[:300]
        finally:
            _model_loading = False
    return _model


def model_status(*, load: bool = True) -> dict:
    if load:
        load_model()
    return {"id": MODEL_ID, "revision": MODEL_REVISION, "loaded": _model is not None and _model_error is None,
            "loaded_tensors": _model_loaded_tensors, "checkpoint_tensors": _model_checkpoint_tensors,
            "loading": _model_loading, "cpu_threads": _model_cpu_threads, "error": _model_error}


def extract_entities(text: str, labels: list[str]) -> list[dict]:
    model = load_model()
    if model is None:
        return []
    try:
        # Keep GLiNER's documented/default decision threshold. The earlier 0.05
        # setting returned many generic false positives (e.g. "incorporation"
        # labeled as a project); confidence is still exposed as a raw score.
        rows = model.predict_entities(text, labels, threshold=0.5)
    except TypeError:
        rows = model.predict_entities(text, labels)
    except Exception:
        logger.exception("GLiNER entity inference failed")
        raise
    return [{"text": row.get("text", ""), "label": row.get("label", "entity"),
             "score": round(float(row.get("score", 0)), 5),
             "start": int(row.get("start", -1)), "end": int(row.get("end", -1)),
             "extractor": "gliner"} for row in rows if row.get("text")]
