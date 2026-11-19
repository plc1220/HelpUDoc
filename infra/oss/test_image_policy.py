"""Regression-test the image policy without a Docker daemon."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
IMAGES = re.findall(r"^ +image: (\S+)$", (HERE / "compose.yaml").read_text(), re.MULTILINE)


class ImagePolicyTests(unittest.TestCase):
    def run_check(self, images):
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / "docker"
            docker.write_text('#!/bin/sh\n[ "$*" = "compose -f compose.yaml config --images" ] || exit 2\nprintf "%s\\n" "$MOCK_IMAGES"\n')
            docker.chmod(0o755)
            return subprocess.run(
                [str(HERE / "check-compose.sh")],
                env={**os.environ, "MOCK_IMAGES": "\n".join(images), "PATH": f"{directory}:{os.environ['PATH']}"},
                capture_output=True,
                text=True,
            )

    def test_accepts_checked_in_image_set(self):
        result = self.run_check(IMAGES)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_floating_and_minio_images(self):
        for image in (
            "docker.io/library/postgres:16-bookworm",
            "docker.io/library/redis:7.4-alpine",
            "docker.io/example/postgres:16.11-bookworm",
            "docker.io/minio/minio:1.2.3",
            "docker.io/amazon/aws-cli:latest",
        ):
            with self.subTest(image=image):
                result = self.run_check([*IMAGES, image])
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(image, result.stderr)


if __name__ == "__main__":
    unittest.main()
