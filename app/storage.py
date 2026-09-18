from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .pose_format import ValidatedPose


@dataclass(frozen=True)
class PoseRecord:
    id: str
    name: str
    created_at: str
    frame_count: int
    fps: float
    source_dimensions: int
    normalized: bool
    byte_count: int
    sha256: str
    low_confidence_points: int

    def to_dict(self) -> dict:
        return asdict(self)


class PoseStorage:
    def __init__(self, config: Settings):
        self.config = config
        self.root = config.data_dir
        self.poses_dir = self.root / "poses"
        self.originals_dir = self.root / "originals"
        self.database_path = self.root / "avatar3d.sqlite3"
        self.root.mkdir(parents=True, exist_ok=True)
        self.poses_dir.mkdir(parents=True, exist_ok=True)
        if config.keep_originals:
            self.originals_dir.mkdir(parents=True, exist_ok=True)
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize_database(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS poses (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    frame_count INTEGER NOT NULL,
                    fps REAL NOT NULL,
                    source_dimensions INTEGER NOT NULL,
                    normalized INTEGER NOT NULL,
                    byte_count INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    low_confidence_points INTEGER NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS poses_created_at_idx "
                "ON poses(created_at DESC)"
            )

    def create(
        self,
        *,
        name: str,
        fps: float,
        original_content: bytes,
        validated_pose: ValidatedPose,
    ) -> PoseRecord:
        pose_id = str(uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        # O arquivo reproduzido e sempre o payload original. O parser apenas
        # valida metadados; nenhuma copia recalibrada participa do playback.
        pose_bytes = original_content
        record = PoseRecord(
            id=pose_id,
            name=name,
            created_at=created_at,
            frame_count=validated_pose.frame_count,
            fps=fps,
            source_dimensions=validated_pose.source_dimensions,
            normalized=False,
            byte_count=len(pose_bytes),
            sha256=hashlib.sha256(pose_bytes).hexdigest(),
            low_confidence_points=validated_pose.low_confidence_points,
        )

        pose_path = self.pose_path(pose_id)
        pose_path.write_bytes(pose_bytes)
        if self.config.keep_originals:
            (self.originals_dir / f"{pose_id}.pose").write_bytes(original_content)

        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO poses (
                        id, name, created_at, frame_count, fps,
                        source_dimensions, normalized, byte_count, sha256,
                        low_confidence_points
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.name,
                        record.created_at,
                        record.frame_count,
                        record.fps,
                        record.source_dimensions,
                        int(record.normalized),
                        record.byte_count,
                        record.sha256,
                        record.low_confidence_points,
                    ),
                )
        except Exception:
            pose_path.unlink(missing_ok=True)
            if self.config.keep_originals:
                (self.originals_dir / f"{pose_id}.pose").unlink(missing_ok=True)
            raise
        return record

    def list(self, limit: int = 100) -> list[PoseRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM poses ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def get(self, pose_id: str) -> PoseRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM poses WHERE id = ?", (pose_id,)
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def get_by_name(self, name: str) -> PoseRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM poses WHERE name = ? ORDER BY created_at DESC LIMIT 1",
                (name,),
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def delete(self, pose_id: str) -> bool:
        with self._connect() as connection:
            result = connection.execute("DELETE FROM poses WHERE id = ?", (pose_id,))
        if result.rowcount == 0:
            return False
        self.pose_path(pose_id).unlink(missing_ok=True)
        (self.originals_dir / f"{pose_id}.pose").unlink(missing_ok=True)
        return True

    def pose_path(self, pose_id: str) -> Path:
        return self.poses_dir / f"{pose_id}.pose"

    def original_path(self, pose_id: str) -> Path:
        return self.originals_dir / f"{pose_id}.pose"

    def playback_path(self, pose_id: str) -> Path:
        """Prefere o payload original, inclusive para registros antigos."""
        original_path = self.original_path(pose_id)
        return original_path if original_path.is_file() else self.pose_path(pose_id)

    @staticmethod
    def _from_row(row: sqlite3.Row) -> PoseRecord:
        return PoseRecord(
            id=row["id"],
            name=row["name"],
            created_at=row["created_at"],
            frame_count=row["frame_count"],
            fps=row["fps"],
            source_dimensions=row["source_dimensions"],
            normalized=bool(row["normalized"]),
            byte_count=row["byte_count"],
            sha256=row["sha256"],
            low_confidence_points=row["low_confidence_points"],
        )
