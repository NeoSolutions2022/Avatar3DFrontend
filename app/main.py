from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import settings
from .pose_format import PoseValidationError, normalize_pose
from .storage import PoseRecord, PoseStorage


app = FastAPI(
    title="Avatar3D Pose API",
    version="1.0.0",
    description=(
        "Receives 2D or 3D .pose data, normalizes it for the Asuna avatar, "
        "and exposes it to the Unity WebGL player."
    ),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
)

storage = PoseStorage(settings)


class PoseTextRequest(BaseModel):
    name: str = Field(default="runtime.pose", min_length=1, max_length=180)
    content: str = Field(min_length=1)
    fps: float = Field(default=30.0, ge=1.0, le=120.0)


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if not settings.api_key:
        return
    if x_api_key is None or not secrets.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


def record_response(record: PoseRecord, request: Request) -> dict:
    result = record.to_dict()
    result["content_url"] = str(
        request.url_for("get_pose_content", pose_id=record.id)
    )
    result["player_url"] = str(request.base_url).rstrip("/") + f"/?poseId={record.id}"
    return result


def decode_pose(raw: bytes) -> str:
    if len(raw) > settings.max_pose_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"pose exceeds {settings.max_pose_bytes} bytes",
        )
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exception:
        raise HTTPException(status_code=400, detail="pose must be UTF-8 text") from exception


def persist_pose(*, name: str, fps: float, raw: bytes) -> PoseRecord:
    text = decode_pose(raw)
    try:
        normalized = normalize_pose(
            text,
            filename=Path(name).name,
            margin=settings.normalization_margin,
            max_frames=settings.max_pose_frames,
        )
    except PoseValidationError as exception:
        raise HTTPException(status_code=422, detail=str(exception)) from exception
    return storage.create(
        name=Path(name).name[:180] or "runtime.pose",
        fps=fps,
        original_content=raw,
        normalized_pose=normalized,
    )


@app.get("/api/v1/health", name="health")
def health() -> dict:
    manifest = settings.webgl_dir / "manifest.json"
    return {
        "status": "ok",
        "api_version": "1.0.0",
        "webgl_ready": manifest.is_file(),
    }


@app.post(
    "/api/v1/poses",
    status_code=201,
    dependencies=[Depends(require_api_key)],
)
async def upload_pose(
    request: Request,
    file: UploadFile = File(...),
    fps: float = Form(default=30.0, ge=1.0, le=120.0),
) -> dict:
    raw = await file.read(settings.max_pose_bytes + 1)
    record = persist_pose(name=file.filename or "upload.pose", fps=fps, raw=raw)
    return record_response(record, request)


@app.post(
    "/api/v1/poses/text",
    status_code=201,
    dependencies=[Depends(require_api_key)],
)
def upload_pose_text(payload: PoseTextRequest, request: Request) -> dict:
    raw = payload.content.encode("utf-8")
    record = persist_pose(name=payload.name, fps=payload.fps, raw=raw)
    return record_response(record, request)


@app.get("/api/v1/poses")
def list_poses(request: Request, limit: int = 100) -> dict:
    safe_limit = max(1, min(limit, 500))
    records = storage.list(safe_limit)
    return {
        "items": [record_response(record, request) for record in records],
        "count": len(records),
    }


@app.get("/api/v1/poses/{pose_id}")
def get_pose(pose_id: str, request: Request) -> dict:
    record = storage.get(pose_id)
    if record is None:
        raise HTTPException(status_code=404, detail="pose not found")
    return record_response(record, request)


@app.get("/api/v1/poses/{pose_id}/content", name="get_pose_content")
def get_pose_content(pose_id: str) -> FileResponse:
    record = storage.get(pose_id)
    path = storage.pose_path(pose_id)
    if record is None or not path.is_file():
        raise HTTPException(status_code=404, detail="pose not found")
    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        filename=f"{pose_id}.pose",
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.delete(
    "/api/v1/poses/{pose_id}",
    status_code=204,
    dependencies=[Depends(require_api_key)],
)
def delete_pose(pose_id: str) -> None:
    if not storage.delete(pose_id):
        raise HTTPException(status_code=404, detail="pose not found")


app.mount(
    "/static",
    StaticFiles(directory=settings.frontend_dir, check_dir=False),
    name="static",
)
app.mount(
    "/webgl",
    StaticFiles(directory=settings.webgl_dir, check_dir=False),
    name="webgl",
)


@app.get(
    "/",
    response_class=HTMLResponse,
    response_model=None,
    include_in_schema=False,
)
def index() -> FileResponse | JSONResponse:
    path = settings.frontend_dir / "index.html"
    if not path.is_file():
        return JSONResponse(
            status_code=503,
            content={"detail": "frontend assets are not installed"},
        )
    return FileResponse(path)
