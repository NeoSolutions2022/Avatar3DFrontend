from __future__ import annotations

import json
from pathlib import Path


LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/"
MIN_BINARY_SIZE = 1_000_000


def load_json(path: Path) -> dict:
    if not path.is_file():
        raise SystemExit(f"Arquivo ausente: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def validate_webgl_builds(webgl_root: Path = Path("webgl")) -> None:
    catalog = load_json(webgl_root / "catalog.json")
    avatars = catalog.get("avatars", [])
    if not avatars:
        raise SystemExit("catalog.json nao possui avatares")

    for avatar in avatars:
        avatar_id = avatar.get("id", "desconhecido")
        manifest_path = webgl_root / avatar["manifestUrl"]
        manifest = load_json(manifest_path)
        build_root = manifest_path.parent

        artifacts = {
            "loader": build_root / manifest["loaderUrl"],
            "data": build_root / manifest["dataUrl"],
            "framework": build_root / manifest["frameworkUrl"],
            "wasm": build_root / manifest["codeUrl"],
        }

        for kind, artifact_path in artifacts.items():
            if not artifact_path.is_file():
                raise SystemExit(f"[{avatar_id}] artefato ausente: {artifact_path}")

            size = artifact_path.stat().st_size
            print(f"[{avatar_id}] {kind}: {artifact_path} ({size} bytes)")

            if kind not in {"data", "wasm"}:
                continue
            if size < MIN_BINARY_SIZE:
                raise SystemExit(
                    f"[{avatar_id}] {kind} parece incompleto ou um ponteiro Git LFS"
                )
            with artifact_path.open("rb") as artifact:
                if artifact.read(64).startswith(LFS_POINTER_PREFIX):
                    raise SystemExit(
                        f"[{avatar_id}] {kind} ainda e um ponteiro Git LFS"
                    )

    print(f"WebGL validado para {len(avatars)} avatar(es).")


if __name__ == "__main__":
    validate_webgl_builds()
