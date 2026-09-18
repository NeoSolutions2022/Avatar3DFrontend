from __future__ import annotations

import hashlib
import math
import re
from collections import OrderedDict
from dataclasses import dataclass


HEADER_RE = re.compile(r"^# Frame: (.*?) - (.+) Keypoints\s*$")
JOINT_RE = re.compile(r"^([^:]+):\s+(.+?)\s*$")

# A topologia e validada, mas nunca reconstruida ou redimensionada. O Unity e
# a unica fonte de verdade para interpretar coordenadas e fazer o retarget.
REQUIRED_BODY_JOINTS = {
    "MidHip", "Neck", "Nose", "RShoulder", "RElbow", "RWrist",
    "LShoulder", "LElbow", "LWrist", "RHip", "RKnee", "RAnkle",
    "LHip", "LKnee", "LAnkle", "REye", "REar", "LEye", "LEar",
    "LHeel", "LBigToe", "LSmallToe", "RHeel", "RBigToe", "RSmallToe",
}


class PoseValidationError(ValueError):
    pass


@dataclass(frozen=True)
class Joint:
    x: float
    y: float
    z: float
    confidence: float


@dataclass(frozen=True)
class Frame:
    source: str
    sections: OrderedDict[str, OrderedDict[str, Joint]]


@dataclass(frozen=True)
class ValidatedPose:
    content: str
    frame_count: int
    source_dimensions: int
    sha256: str
    low_confidence_points: int
    coordinates_transformed: bool = False


def validate_pose(
    text: str,
    *,
    filename: str = "upload.pose",
    max_frames: int = 10_000,
) -> ValidatedPose:
    """Valida um .pose e o devolve sem retarget intermediario.

    Nenhuma coordenada 2D/3D, eixo, escala, proporcao, confianca ou formatacao
    e alterada.
    """
    frames, source_dimensions = parse_pose(text, filename, max_frames)
    low_confidence = sum(
        joint.confidence < 0.2
        for frame in frames
        for joints in frame.sections.values()
        for joint in joints.values()
    )
    encoded = text.encode("utf-8")
    return ValidatedPose(
        content=text,
        frame_count=len(frames),
        source_dimensions=source_dimensions,
        sha256=hashlib.sha256(encoded).hexdigest(),
        low_confidence_points=low_confidence,
        coordinates_transformed=False,
    )


def parse_pose(text: str, filename: str, max_frames: int) -> tuple[list[Frame], int]:
    if not text or not text.strip():
        raise PoseValidationError("pose content is empty")

    frames: list[Frame] = []
    current_frame: Frame | None = None
    current_section: OrderedDict[str, Joint] | None = None
    dimensions: set[int] = set()

    # splitlines e usado apenas pela validacao. O texto original nao e serializado.
    for line_number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue

        header = HEADER_RE.match(line)
        if header:
            source, section_name = header.groups()
            if current_frame is None or current_frame.source != source:
                current_frame = Frame(source, OrderedDict())
                frames.append(current_frame)
                if len(frames) > max_frames:
                    raise PoseValidationError(f"pose exceeds {max_frames} frames")
            current_section = current_frame.sections.setdefault(
                section_name, OrderedDict()
            )
            continue

        if line.startswith("#"):
            continue
        match = JOINT_RE.match(line)
        if match is None or current_section is None:
            raise PoseValidationError(
                f"{filename}:{line_number}: joint outside a frame section"
            )

        joint_name, values_text = match.groups()
        try:
            values = [float(value) for value in values_text.split()]
        except ValueError as exception:
            raise PoseValidationError(
                f"{filename}:{line_number}: invalid numeric value"
            ) from exception

        if len(values) == 3:
            x, y, confidence = values
            z = 0.0
            dimensions.add(2)
        elif len(values) == 4:
            x, y, z, confidence = values
            dimensions.add(3)
        else:
            raise PoseValidationError(
                f"{filename}:{line_number}: expected X Y [Z] Confidence"
            )

        if not all(math.isfinite(value) for value in values):
            raise PoseValidationError(f"{filename}:{line_number}: non-finite value")
        if not 0.0 <= confidence <= 1.0:
            raise PoseValidationError(
                f"{filename}:{line_number}: confidence must be between 0 and 1"
            )
        current_section[joint_name] = Joint(x, y, z, confidence)

    if not frames:
        raise PoseValidationError("pose has no frames")
    if len(dimensions) != 1:
        raise PoseValidationError("pose mixes 2D and 3D joint rows")

    body_topology: tuple[str, ...] | None = None
    for index, frame in enumerate(frames):
        body = frame.sections.get("Body")
        if body is None:
            raise PoseValidationError(f"frame {index} is missing Body Keypoints")
        missing = sorted(REQUIRED_BODY_JOINTS.difference(body))
        if missing:
            raise PoseValidationError(
                f"frame {index} is missing body joints: {', '.join(missing)}"
            )
        current_topology = tuple(body)
        if body_topology is None:
            body_topology = current_topology
        elif current_topology != body_topology:
            raise PoseValidationError(f"body topology changes at frame {index}")

    return frames, dimensions.pop()
