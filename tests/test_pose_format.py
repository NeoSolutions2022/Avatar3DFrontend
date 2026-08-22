from __future__ import annotations

import unittest
from pathlib import Path

from app.pose_format import PoseValidationError, parse_pose, validate_pose


PLATFORM_ROOT = Path(__file__).resolve().parents[1]
CHAIR_POSE = (
    PLATFORM_ROOT
    / "webgl"
    / "asuna"
    / "StreamingAssets"
    / "cadeira_legacy_z.pose"
)


def first_frames(text: str, count: int = 2) -> str:
    lines: list[str] = []
    body_headers = 0
    for line in text.splitlines():
        if line.startswith("# Frame:") and line.endswith("- Body Keypoints"):
            body_headers += 1
            if body_headers > count:
                break
        if body_headers:
            lines.append(line)
    return "\n".join(lines) + "\n"


def as_2d(text: str) -> str:
    result: list[str] = []
    for line in text.splitlines():
        if not line or line.startswith("#") or ":" not in line:
            result.append(line)
            continue
        name, values_text = line.split(":", 1)
        values = values_text.split()
        if len(values) == 4:
            result.append(f"{name}: {values[0]} {values[1]} {values[3]}")
        else:
            result.append(line)
    return "\n".join(result) + "\n"


class PoseFormatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sample = first_frames(CHAIR_POSE.read_text(encoding="utf-8-sig"))

    def test_preserves_real_3d_pose_byte_for_byte(self) -> None:
        original = self.sample.replace("\n", "\r\n").removesuffix("\r\n")
        validated = validate_pose(original, filename="chair.pose")
        _, dimensions = parse_pose(validated.content, "validated.pose", 10)

        self.assertEqual(dimensions, 3)
        self.assertEqual(validated.source_dimensions, 3)
        self.assertEqual(validated.frame_count, 2)
        self.assertFalse(validated.coordinates_transformed)
        self.assertEqual(validated.content, original)
        self.assertGreater(len(original), 1_000)

    def test_preserves_2d_pose_without_lifting_or_rescaling(self) -> None:
        original = as_2d(self.sample).replace("\n", "\r\n")
        validated = validate_pose(original, filename="flat.pose")
        _, dimensions = parse_pose(validated.content, "flat.pose", 10)

        self.assertEqual(validated.source_dimensions, 2)
        self.assertFalse(validated.coordinates_transformed)
        self.assertEqual(dimensions, 2)
        self.assertEqual(validated.content, original)

    def test_rejects_pose_without_body(self) -> None:
        invalid = "# Frame: 000001.jpg - Face Keypoints\nNose: 1 2 0.9\n"
        with self.assertRaisesRegex(PoseValidationError, "missing Body"):
            validate_pose(invalid)


if __name__ == "__main__":
    unittest.main()
