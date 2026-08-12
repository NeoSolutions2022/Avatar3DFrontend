from __future__ import annotations

import math
import unittest
from pathlib import Path

from app.pose_format import (
    BODY_TREE,
    REFERENCE_TARGET_LENGTHS,
    PoseValidationError,
    apply_reference_arm_proportions,
    normalize_pose,
    parse_pose,
)


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

    def test_normalizes_real_3d_pose(self) -> None:
        normalized = normalize_pose(cls_text := self.sample, filename="chair.pose")
        frames, dimensions = parse_pose(normalized.content, "normalized.pose", 10)

        self.assertEqual(dimensions, 3)
        self.assertEqual(normalized.source_dimensions, 3)
        self.assertEqual(normalized.frame_count, 2)
        self.assertIn("# Avatar3D normalized source: chair.pose", normalized.content)
        self.assertGreater(len(cls_text), 1_000)

        lengths_by_group: dict[str, list[float]] = {}
        for frame in frames:
            body = frame.sections["Body"]
            for parent, child, group in BODY_TREE:
                a, b = body[parent], body[child]
                distance = math.dist((a.x, a.y, a.z), (b.x, b.y, b.z))
                lengths_by_group.setdefault(group, []).append(distance)
        for values in lengths_by_group.values():
            self.assertLess(max(values) - min(values), 2e-4)

    def test_lifts_2d_pose_to_canonical_3d(self) -> None:
        normalized = normalize_pose(as_2d(self.sample), filename="flat.pose")
        frames, dimensions = parse_pose(normalized.content, "normalized.pose", 10)
        body = frames[0].sections["Body"]

        self.assertEqual(normalized.source_dimensions, 2)
        self.assertEqual(dimensions, 3)
        self.assertTrue(any(abs(joint.z) > 1e-5 for joint in body.values()))

    def test_uses_reference_arm_proportions_for_short_clips(self) -> None:
        target_lengths = {
            "torso": REFERENCE_TARGET_LENGTHS["torso"],
            "half_shoulder_width": REFERENCE_TARGET_LENGTHS["half_shoulder_width"],
            "half_hip_width": REFERENCE_TARGET_LENGTHS["half_hip_width"],
            "neck_head": REFERENCE_TARGET_LENGTHS["neck_head"],
            "upper_arm": 320.0,
            "forearm": 190.0,
        }

        scale = apply_reference_arm_proportions(target_lengths)

        self.assertAlmostEqual(scale, 1.0)
        self.assertAlmostEqual(
            target_lengths["upper_arm"], REFERENCE_TARGET_LENGTHS["upper_arm"]
        )
        self.assertAlmostEqual(
            target_lengths["forearm"], REFERENCE_TARGET_LENGTHS["forearm"]
        )

    def test_never_shortens_a_larger_observed_arm(self) -> None:
        target_lengths = {
            "torso": REFERENCE_TARGET_LENGTHS["torso"],
            "half_shoulder_width": REFERENCE_TARGET_LENGTHS["half_shoulder_width"],
            "half_hip_width": REFERENCE_TARGET_LENGTHS["half_hip_width"],
            "neck_head": REFERENCE_TARGET_LENGTHS["neck_head"],
            "upper_arm": 420.0,
            "forearm": 380.0,
        }

        apply_reference_arm_proportions(target_lengths)

        self.assertEqual(target_lengths["upper_arm"], 420.0)
        self.assertEqual(target_lengths["forearm"], 380.0)

    def test_rejects_pose_without_body(self) -> None:
        invalid = "# Frame: 000001.jpg - Face Keypoints\nNose: 1 2 0.9\n"
        with self.assertRaisesRegex(PoseValidationError, "missing Body"):
            normalize_pose(invalid)


if __name__ == "__main__":
    unittest.main()
