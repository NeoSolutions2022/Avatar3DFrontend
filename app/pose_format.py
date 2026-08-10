from __future__ import annotations

import hashlib
import math
import re
import statistics
from collections import OrderedDict, defaultdict
from dataclasses import dataclass


HEADER_RE = re.compile(r"^# Frame: (.*?) - (.+) Keypoints\s*$")
JOINT_RE = re.compile(r"^([^:]+):\s+(.+?)\s*$")

BODY_TREE = (
    ("MidHip", "Neck", "torso"),
    ("Neck", "Nose", "neck_head"),
    ("Neck", "RShoulder", "half_shoulder_width"),
    ("RShoulder", "RElbow", "upper_arm"),
    ("RElbow", "RWrist", "forearm"),
    ("Neck", "LShoulder", "half_shoulder_width"),
    ("LShoulder", "LElbow", "upper_arm"),
    ("LElbow", "LWrist", "forearm"),
    ("MidHip", "RHip", "half_hip_width"),
    ("RHip", "RKnee", "thigh"),
    ("RKnee", "RAnkle", "shin"),
    ("MidHip", "LHip", "half_hip_width"),
    ("LHip", "LKnee", "thigh"),
    ("LKnee", "LAnkle", "shin"),
    ("Nose", "REye", "nose_eye"),
    ("REye", "REar", "eye_ear"),
    ("Nose", "LEye", "nose_eye"),
    ("LEye", "LEar", "eye_ear"),
    ("LAnkle", "LHeel", "ankle_heel"),
    ("LAnkle", "LBigToe", "ankle_toe"),
    ("LBigToe", "LSmallToe", "toe_width"),
    ("RAnkle", "RHeel", "ankle_heel"),
    ("RAnkle", "RBigToe", "ankle_toe"),
    ("RBigToe", "RSmallToe", "toe_width"),
)

# Sinais medianos extraidos do clipe de referencia que foi validado na Asuna.
CANONICAL_DIRECTIONS = {
    ("MidHip", "Neck"): 1.0,
    ("Neck", "Nose"): -1.0,
    ("Neck", "RShoulder"): -1.0,
    ("RShoulder", "RElbow"): -1.0,
    ("RElbow", "RWrist"): -1.0,
    ("Neck", "LShoulder"): 1.0,
    ("LShoulder", "LElbow"): -1.0,
    ("LElbow", "LWrist"): -1.0,
    ("MidHip", "RHip"): 1.0,
    ("RHip", "RKnee"): 1.0,
    ("RKnee", "RAnkle"): 1.0,
    ("MidHip", "LHip"): -1.0,
    ("LHip", "LKnee"): -1.0,
    ("LKnee", "LAnkle"): 1.0,
    ("Nose", "REye"): 1.0,
    ("REye", "REar"): 1.0,
    ("Nose", "LEye"): 1.0,
    ("LEye", "LEar"): 1.0,
    ("LAnkle", "LHeel"): 1.0,
    ("LAnkle", "LBigToe"): -1.0,
    ("LBigToe", "LSmallToe"): 1.0,
    ("RAnkle", "RHeel"): 1.0,
    ("RAnkle", "RBigToe"): -1.0,
    ("RBigToe", "RSmallToe"): 1.0,
}

# Comprimentos extraidos da frase de referencia validada visualmente na Asuna:
# "HOJE EU APRENDER LIBRAS ENTAO COMUNICACAO MELHORAR". Os arquivos recebidos
# podem conter poucos frames e, nesse caso, o maior comprimento 2D observado
# subestima principalmente o antebraco. Reconstruir Z com esse comprimento curto
# deixa o componente vertical grande demais e faz os bracos parecerem elevados.
REFERENCE_TARGET_LENGTHS = {
    "torso": 585.366,
    "half_shoulder_width": 208.402,
    "half_hip_width": 149.286,
    "neck_head": 239.120,
    "upper_arm": 388.204,
    "forearm": 345.984,
}
REFERENCE_SCALE_GROUPS = (
    "torso",
    "half_shoulder_width",
    "half_hip_width",
    "neck_head",
)
REFERENCE_ARM_GROUPS = ("upper_arm", "forearm")


class PoseValidationError(ValueError):
    pass


@dataclass
class Joint:
    x: float
    y: float
    z: float
    confidence: float


@dataclass
class Frame:
    source: str
    sections: OrderedDict[str, OrderedDict[str, Joint]]


@dataclass(frozen=True)
class NormalizedPose:
    content: str
    frame_count: int
    source_dimensions: int
    sha256: str
    low_confidence_points: int


def normalize_pose(
    text: str,
    *,
    filename: str = "upload.pose",
    margin: float = 1.02,
    max_frames: int = 10_000,
) -> NormalizedPose:
    if not 1.0 <= margin <= 1.25:
        raise PoseValidationError("normalization margin must be between 1.0 and 1.25")

    frames, source_dimensions = parse_pose(text, filename, max_frames)
    target_lengths = estimate_lengths(frames, margin)
    apply_reference_arm_proportions(target_lengths)
    directions = estimate_directions(frames, source_dimensions)
    reconstruct_depth(frames, target_lengths, directions, source_dimensions)
    content = serialize_pose(frames, filename, source_dimensions, target_lengths)
    encoded = content.encode("utf-8")
    low_confidence = sum(
        joint.confidence < 0.2
        for frame in frames
        for joints in frame.sections.values()
        for joint in joints.values()
    )
    return NormalizedPose(
        content=content,
        frame_count=len(frames),
        source_dimensions=source_dimensions,
        sha256=hashlib.sha256(encoded).hexdigest(),
        low_confidence_points=low_confidence,
    )


def parse_pose(text: str, filename: str, max_frames: int) -> tuple[list[Frame], int]:
    if not text or not text.strip():
        raise PoseValidationError("pose content is empty")

    frames: list[Frame] = []
    current_frame: Frame | None = None
    current_section: OrderedDict[str, Joint] | None = None
    dimensions: set[int] = set()

    for line_number, raw_line in enumerate(text.replace("\r\n", "\n").splitlines(), 1):
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

    required_body = {name for edge in BODY_TREE for name in edge[:2]}
    body_topology: tuple[str, ...] | None = None
    for index, frame in enumerate(frames):
        body = frame.sections.get("Body")
        if body is None:
            raise PoseValidationError(f"frame {index} is missing Body Keypoints")
        missing = sorted(required_body.difference(body))
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


def estimate_lengths(frames: list[Frame], margin: float) -> dict[str, float]:
    projected: dict[str, list[float]] = defaultdict(list)
    for frame in frames:
        body = frame.sections["Body"]
        for parent, child, group in BODY_TREE:
            projected[group].append(
                math.hypot(body[child].x - body[parent].x, body[child].y - body[parent].y)
            )
    return {group: max(values) * margin for group, values in projected.items()}


def apply_reference_arm_proportions(target_lengths: dict[str, float]) -> float:
    """Use a escala corporal do clipe e imponha o minimo validado dos bracos.

    O maximo projetado continua sendo respeitado, portanto um gesto realmente
    estendido nunca e encurtado. A mediana de quatro medidas centrais torna a
    escala resistente a inclinacao, oclusao ou um ombro detectado com ruido.
    """
    scale_samples = [
        target_lengths[group] / REFERENCE_TARGET_LENGTHS[group]
        for group in REFERENCE_SCALE_GROUPS
        if target_lengths.get(group, 0.0) > 0.0
    ]
    reference_scale = statistics.median(scale_samples) if scale_samples else 1.0

    for group in REFERENCE_ARM_GROUPS:
        reference_length = REFERENCE_TARGET_LENGTHS[group] * reference_scale
        target_lengths[group] = max(target_lengths[group], reference_length)

    return reference_scale


def estimate_directions(
    frames: list[Frame], source_dimensions: int
) -> dict[tuple[str, str], float]:
    if source_dimensions == 2:
        return dict(CANONICAL_DIRECTIONS)

    deltas: dict[tuple[str, str], list[float]] = defaultdict(list)
    for frame in frames:
        body = frame.sections["Body"]
        for parent, child, _ in BODY_TREE:
            deltas[(parent, child)].append(body[child].z - body[parent].z)

    result = {}
    for edge, values in deltas.items():
        values.sort()
        median = values[len(values) // 2]
        result[edge] = (
            CANONICAL_DIRECTIONS[edge]
            if abs(median) < 1e-6
            else (-1.0 if median < 0.0 else 1.0)
        )
    return result


def reconstruct_depth(
    frames: list[Frame],
    target_lengths: dict[str, float],
    directions: dict[tuple[str, str], float],
    source_dimensions: int,
) -> None:
    for frame in frames:
        body = frame.sections["Body"]
        body["MidHip"].z = 0.0
        for parent, child, group in BODY_TREE:
            projected = math.hypot(
                body[child].x - body[parent].x,
                body[child].y - body[parent].y,
            )
            target = target_lengths[group]
            depth = math.sqrt(max(target * target - projected * projected, 0.0))
            body[child].z = body[parent].z + directions[(parent, child)] * depth

        for section_name, hand_root, body_wrist in (
            ("Left Hand", "Left Wrist", "LWrist"),
            ("Right Hand", "Right Wrist", "RWrist"),
        ):
            hand = frame.sections.get(section_name)
            if hand is None or hand_root not in hand:
                continue
            original_root_z = hand[hand_root].z
            wrist_z = body[body_wrist].z
            for joint in hand.values():
                local_z = joint.z - original_root_z if source_dimensions == 3 else 0.0
                joint.z = wrist_z + local_z

        face = frame.sections.get("Face")
        if face is not None:
            for joint in face.values():
                joint.z = 0.0


def serialize_pose(
    frames: list[Frame],
    filename: str,
    source_dimensions: int,
    target_lengths: dict[str, float],
) -> str:
    lines = [
        f"# Avatar3D normalized source: {filename}",
        f"# Source dimensions: {source_dimensions}D",
        "# Coordinates: image X/Y, canonical body Z, wrist-anchored hand Z, face Z=0",
        "# Global target lengths: " + ", ".join(
            f"{name}={value:.3f}" for name, value in sorted(target_lengths.items())
        ),
        "",
    ]
    for frame in frames:
        for section_name, joints in frame.sections.items():
            lines.append(f"# Frame: {frame.source} - {section_name} Keypoints")
            for name, joint in joints.items():
                lines.append(
                    f"{name}: {joint.x:.6f} {joint.y:.6f} "
                    f"{joint.z:.6f} {joint.confidence:.6f}"
                )
            lines.append("")
    return "\n".join(lines)
