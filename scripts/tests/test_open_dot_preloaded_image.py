import importlib.util
from pathlib import Path
import unittest


HELPER_PATH = Path(__file__).parents[1] / "verify-open-dot-preloaded-image.py"
SPEC = importlib.util.spec_from_file_location("verify_open_dot_preloaded", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


IMAGE_ID = "sha256:" + "a" * 64
SOURCE_SHA = "b" * 40


def image(**overrides):
    value = {
        "Id": IMAGE_ID,
        "Os": "linux",
        "Architecture": "amd64",
        "Config": {
            "Labels": {
                HELPER.ARTIFACT_LABEL: HELPER.EXPECTED_ARTIFACT,
                HELPER.SOURCE_LABEL: SOURCE_SHA,
            }
        },
    }
    value.update(overrides)
    return value


class VerifyOpenDotPreloadedImageTests(unittest.TestCase):
    def test_accepts_exact_cloud_image_identity(self):
        self.assertEqual(HELPER.verify(image(), IMAGE_ID, SOURCE_SHA), IMAGE_ID)

    def test_rejects_forged_expected_id(self):
        with self.assertRaisesRegex(ValueError, "ID does not match"):
            HELPER.verify(image(), "sha256:" + "c" * 64, SOURCE_SHA)

    def test_rejects_wrong_source_revision(self):
        with self.assertRaisesRegex(ValueError, "source revision"):
            HELPER.verify(image(), IMAGE_ID, "d" * 40)

    def test_rejects_wrong_artifact_role(self):
        candidate = image()
        candidate["Config"]["Labels"][HELPER.ARTIFACT_LABEL] = "singulance-open-dot-computer-worker"
        with self.assertRaisesRegex(ValueError, "not the Open Dot cloud artifact"):
            HELPER.verify(candidate, IMAGE_ID, SOURCE_SHA)

    def test_rejects_wrong_platform(self):
        with self.assertRaisesRegex(ValueError, "linux/amd64"):
            HELPER.verify(image(Architecture="arm64"), IMAGE_ID, SOURCE_SHA)

    def test_rejects_missing_artifact_labels(self):
        with self.assertRaisesRegex(ValueError, "missing artifact labels"):
            HELPER.verify(image(Config={"Labels": None}), IMAGE_ID, SOURCE_SHA)

    def test_native_release_branch_has_no_archive_load_or_registry_pull(self):
        release = (Path(__file__).parents[1] / "release-canonical.sh").read_text()
        start = release.index('if [ "$OPEN_DOT_IMAGE_NATIVE" = 1 ]; then', release.index('if [ "$s" = open-dot ]; then'))
        end = release.index('elif [ "$OPEN_DOT_IMAGE_PRELOADED" = 1 ]; then', start)
        native_branch = release[start:end]
        self.assertNotIn("docker pull", native_branch)
        self.assertNotIn("docker load", native_branch)
        self.assertIn("verify-open-dot-preloaded-image.py", native_branch)
        self.assertIn('OPEN_DOT_DEPLOY_IMAGE="$OPEN_DOT_IMAGE_ID"', native_branch)
        self.assertIn('printf \'  %s:\\n    image: %s\\n    labels:\\n\' "$OPEN_DOT_COMPOSE_SERVICE" "$OPEN_DOT_DEPLOY_IMAGE"', release)
        self.assertIn("com.singulance.open-dot.docker-image-id", release)
        self.assertIn("com.singulance.open-dot.docker-image-id", (Path(__file__).parents[1] / "verify-deployed.sh").read_text())
        self.assertIn('[ "$s" != open-dot ] || PULL_ARGS+=(--pull never)', release)


if __name__ == "__main__":
    unittest.main()
