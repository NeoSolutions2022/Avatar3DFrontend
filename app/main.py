from __future__ import annotations

import json
import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import settings
from .neotalk import NeoTalkApiError, NeoTalkClient
from .pose_format import PoseValidationError, normalize_pose
from .storage import PoseRecord, PoseStorage


app = FastAPI(
    title="Avatar3D Pose API",
    version="1.0.0",
    description=(
        "Receives 2D or 3D .pose data, normalizes it for the NeoTalk avatars, "
        "and exposes it to the Unity WebGL players."
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
neotalk_client = NeoTalkClient(settings)


class PoseTextRequest(BaseModel):
    name: str = Field(default="runtime.pose", min_length=1, max_length=180)
    content: str = Field(min_length=1)
    fps: float = Field(default=30.0, ge=1.0, le=120.0)


class MvpSignRequest(BaseModel):
    phrase: str = Field(min_length=1, max_length=500)


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if not settings.api_key:
        return
    if x_api_key is None or not secrets.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


def record_response(record: PoseRecord, request: Request) -> dict:
    result = record.to_dict()
    # Keep generated links safe behind TLS-terminating reverse proxies.
    result["content_url"] = request.url_for(
        "get_pose_content", pose_id=record.id
    ).path
    result["player_url"] = f"/?poseId={record.id}"
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


def mvp_error(exception: NeoTalkApiError) -> HTTPException:
    return HTTPException(status_code=exception.status_code, detail=exception.detail)


@app.get("/api/v1/health", name="health")
def health() -> dict:
    ready_avatars: list[str] = []
    catalog_path = settings.webgl_dir / "catalog.json"
    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        for avatar in catalog.get("avatars", []):
            avatar_id = str(avatar.get("id", "")).strip()
            manifest_relative = str(avatar.get("manifestUrl", "")).strip()
            manifest_path = settings.webgl_dir / manifest_relative
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            data_path = manifest_path.parent / manifest["dataUrl"]
            wasm_path = manifest_path.parent / manifest["codeUrl"]
            if (
                avatar_id
                and data_path.is_file()
                and data_path.stat().st_size > 1_000_000
                and wasm_path.is_file()
                and wasm_path.stat().st_size > 1_000_000
            ):
                ready_avatars.append(avatar_id)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        ready_avatars = []

    expected_avatars = {"asuna", "lia"}
    webgl_ready = expected_avatars.issubset(ready_avatars)
    return {
        "status": "ok",
        "api_version": "1.0.0",
        "webgl_ready": webgl_ready,
        "avatars": ready_avatars,
        "mvp_ready": neotalk_client.configured,
    }


@app.post("/api/v1/mvp/sign", status_code=202)
def mvp_sign(payload: MvpSignRequest) -> JSONResponse:
    phrase = " ".join(payload.phrase.split())
    if not phrase:
        raise HTTPException(status_code=422, detail="phrase is empty")
    try:
        upstream = neotalk_client.submit_phrase(phrase)
    except NeoTalkApiError as exception:
        raise mvp_error(exception) from exception

    task_id = upstream.payload.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise HTTPException(status_code=502, detail="pose API did not return a task id")
    return JSONResponse(
        status_code=202,
        content={"status": "queued", "task_id": task_id, "phrase": phrase},
    )


@app.get("/api/v1/mvp/tasks/{task_id}", response_model=None)
def mvp_task_status(task_id: str, request: Request) -> JSONResponse | dict:
    try:
        upstream = neotalk_client.task_status(task_id)
    except NeoTalkApiError as exception:
        raise mvp_error(exception) from exception

    if upstream.status_code == 202:
        return JSONResponse(
            status_code=202,
            content={"status": "processing", "task_id": task_id},
        )

    words = upstream.payload.get("palavras_encontradas", [])
    if not isinstance(words, list):
        words = []
    words = [str(word) for word in words]

    pose_name = f"mvp-{task_id}.pose"
    record = storage.get_by_name(pose_name)
    if record is None:
        file_url = upstream.payload.get("file_url")
        if not isinstance(file_url, str) or not file_url:
            raise HTTPException(
                status_code=502, detail="pose API did not return a pose file"
            )
        try:
            raw = neotalk_client.download_pose(file_url)
            record = persist_pose(
                name=pose_name,
                fps=settings.mvp_pose_fps,
                raw=raw,
            )
        except NeoTalkApiError as exception:
            raise mvp_error(exception) from exception
        except HTTPException as exception:
            raise HTTPException(
                status_code=502,
                detail=f"generated pose is invalid: {exception.detail}",
            ) from exception

    return {
        "status": "ready",
        "task_id": task_id,
        "palavras_encontradas": words,
        "pose": record_response(record, request),
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


@app.get(
    "/mvp",
    response_class=HTMLResponse,
    response_model=None,
    include_in_schema=False,
)
def mvp_index() -> FileResponse | JSONResponse:
    path = settings.frontend_dir / "mvp.html"
    if not path.is_file():
        return JSONResponse(
            status_code=503,
            content={"detail": "MVP frontend assets are not installed"},
        )
    return FileResponse(path)
