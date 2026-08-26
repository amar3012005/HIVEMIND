import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "src/hivemind_employees/hyper/visual_artifact_renderer.py"
SPEC = importlib.util.spec_from_file_location("visual_artifact_renderer", MODULE_PATH)
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


def _presentation_spec():
    slide = {
        "eyebrow": "Evidence",
        "headline": "One consequential idea",
        "body": "A compact evidence-backed explanation.",
        "items": [
            {"label": "Signal", "value": "Unknown", "detail": "Measurement required.", "lane": "unknown"},
        ],
        "source_refs": ["Company brief"],
    }
    return {
        "contract": "visual-presentation.v1",
        "title": "Decision deck",
        "summary": "A concise decision presentation.",
        "visual_mode": "editorial",
        "accent": "lime",
        "slides": [
            {**slide, "composition": "hero"},
            {**slide, "composition": "comparison"},
            {**slide, "composition": "timeline"},
            {**slide, "composition": "decision"},
            {**slide, "composition": "matrix"},
        ],
    }


def test_governed_presentation_renderer_emits_navigable_responsive_slides():
    spec = renderer.normalize_presentation_spec(_presentation_spec())
    html = renderer.render_presentation(spec)
    assert html.startswith("<!doctype html>")
    assert html.count('class="slide ') == 5
    assert 'data-next' in html
    assert 'data-previous' in html
    assert '@media(max-width:680px)' in html
    assert '@media print' in html
    assert 'break-after:page' in html
    assert 'type="application/json"' in html
    assert 'data-mode="editorial"' in html
    assert 'composition-hero' in html
    assert 'composition-comparison' in html
    assert 'composition-timeline' in html
    assert "touchstart" in html


def test_renderer_normalizes_invalid_lanes_and_rejects_too_few_slides():
    spec = _presentation_spec()
    spec["slides"][0]["items"][0]["lane"] = "certain"
    assert renderer.normalize_presentation_spec(spec)["slides"][0]["items"][0]["lane"] == "unknown"
    spec["slides"] = spec["slides"][:4]
    try:
        renderer.normalize_presentation_spec(spec)
    except ValueError as error:
        assert str(error) == "presentation_requires_at_least_five_slides"
    else:
        raise AssertionError("too-short presentation was accepted")


def test_renderer_repairs_model_markup_unknown_values_and_repeated_compositions():
    spec = _presentation_spec()
    spec["title"] = "**Decision deck**"
    spec["slides"][0]["body"] = "<h1>Markup must not leak</h1><p>Clean copy.</p>"
    spec["slides"][0]["items"][0]["value"] = "N/A"
    for slide in spec["slides"]:
        slide["composition"] = "decision"
    normalized = renderer.normalize_presentation_spec(spec)
    assert normalized["title"] == "Decision deck"
    assert normalized["slides"][0]["body"] == "Markup must not leak Clean copy."
    assert normalized["slides"][0]["items"][0]["value"] == "Unknown"
    assert normalized["slides"][0]["composition"] == "hero"
    assert normalized["slides"][-1]["composition"] == "decision"
    assert len({slide["composition"] for slide in normalized["slides"]}) >= 3
