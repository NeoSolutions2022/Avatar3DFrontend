from __future__ import annotations

import os
import math
from dataclasses import dataclass
from pathlib import Path


PLATFORM_ROOT = Path(__file__).resolve().parent.parent


def _as_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _elia_playback_speed(value: str) -> float | None:
    """Optional widget override; the current ELIA runtime accepts0.5..1.5."""
    return _bounded_optional_float(value, 0.5, 1.5)


def _elia_presentation_freedom(value: str) -> float | None:
    """Optional Ultra presentation freedom; requires a capable new ELIA build."""
    return _bounded_optional_float(value, 0.0, 1.0)


def _bounded_optional_float(value: str, minimum: float, maximum: float) -> float | None:
    if not value.strip():
        return None
    try:
        speed = float(value)
    except ValueError:
        return None
    return max(minimum, min(maximum, speed)) if math.isfinite(speed) else None


@dataclass(frozen=True)
class Settings:
    host: str = os.getenv("AVATAR3D_HOST", "0.0.0.0")
    port: int = int(os.getenv("AVATAR3D_PORT", "8080"))
    data_dir: Path = Path(
        os.getenv("AVATAR3D_DATA_DIR", str(PLATFORM_ROOT / "data"))
    )
    frontend_dir: Path = Path(
        os.getenv("AVATAR3D_FRONTEND_DIR", str(PLATFORM_ROOT / "frontend"))
    )
    webgl_dir: Path = Path(
        os.getenv("AVATAR3D_WEBGL_DIR", str(PLATFORM_ROOT / "webgl"))
    )
    cors_origins: tuple[str, ...] = tuple(
        value.strip()
        for value in os.getenv("AVATAR3D_CORS_ORIGINS", "*").split(",")
        if value.strip()
    )
    widget_origins: tuple[str, ...] = tuple(
        value.strip()
        for value in os.getenv(
            "AVATAR3D_WIDGET_ORIGINS",
            os.getenv("AVATAR3D_CORS_ORIGINS", "*"),
        ).split(",")
        if value.strip()
    )
    api_key: str = os.getenv("AVATAR3D_API_KEY", "")
    max_pose_bytes: int = int(os.getenv("AVATAR3D_MAX_POSE_BYTES", "20971520"))
    max_pose_frames: int = int(os.getenv("AVATAR3D_MAX_POSE_FRAMES", "10000"))
    keep_originals: bool = _as_bool(os.getenv("AVATAR3D_KEEP_ORIGINALS", "true"))
    log_level: str = os.getenv("AVATAR3D_LOG_LEVEL", "info")
    neotalk_api_base_url: str = os.getenv(
        "NEOTALK_API_BASE_URL",
        "https://infra-neotalk-api.k3p3ex.easypanel.host",
    )
    neotalk_api_key: str = os.getenv("NEOTALK_API_KEY", "")
    neotalk_api_timeout_seconds: float = float(
        os.getenv("NEOTALK_API_TIMEOUT_SECONDS", "30")
    )
    mvp_pose_fps: float = float(os.getenv("NEOTALK_MVP_POSE_FPS", "30"))
    elia_playback_speed: float | None = _elia_playback_speed(
        os.getenv("AVATAR3D_ELIA_PLAYBACK_SPEED", "")
    )
    elia_presentation_freedom: float | None = _elia_presentation_freedom(
        os.getenv("AVATAR3D_ELIA_PRESENTATION_FREEDOM", "")
    )


settings = Settings()
