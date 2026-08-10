from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="avatar3d-api-test-"))
PLATFORM_ROOT = Path(__file__).resolve().parents[1]
os.environ["AVATAR3D_DATA_DIR"] = str(TEST_DATA_DIR)
os.environ["AVATAR3D_FRONTEND_DIR"] = str(PLATFORM_ROOT / "frontend")
os.environ["AVATAR3D_WEBGL_DIR"] = str(PLATFORM_ROOT / "webgl")
os.environ["NEOTALK_API_KEY"] = "test-key"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.neotalk import NeoTalkResponse  # noqa: E402


def first_frame(text: str) -> str:
    result: list[str] = []
    body_headers = 0
    for line in text.splitlines():
        if line.startswith("# Frame:") and line.endswith("- Body Keypoints"):
            body_headers += 1
            if body_headers > 1:
                break
        if body_headers:
            result.append(line)
    return "\n".join(result) + "\n"


class PoseApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        source = (
            PLATFORM_ROOT / "webgl" / "StreamingAssets" / "cadeira_legacy_z.pose"
        ).read_text(encoding="utf-8-sig")
        cls.pose_text = first_frame(source)
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    def test_health_and_complete_pose_lifecycle(self) -> None:
        health = self.client.get("/api/v1/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["status"], "ok")

        created = self.client.post(
            "/api/v1/poses/text",
            json={"name": "api-test.pose", "fps": 25, "content": self.pose_text},
        )
        self.assertEqual(created.status_code, 201, created.text)
        payload = created.json()
        self.assertEqual(payload["frame_count"], 1)
        self.assertEqual(payload["fps"], 25)
        self.assertIn("/content", payload["content_url"])

        pose_id = payload["id"]
        content = self.client.get(f"/api/v1/poses/{pose_id}/content")
        self.assertEqual(content.status_code, 200)
        self.assertIn("# Avatar3D normalized source", content.text)

        listed = self.client.get("/api/v1/poses").json()
        self.assertTrue(any(item["id"] == pose_id for item in listed["items"]))

        deleted = self.client.delete(f"/api/v1/poses/{pose_id}")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get(f"/api/v1/poses/{pose_id}").status_code, 404)

    def test_rejects_invalid_pose(self) -> None:
        response = self.client.post(
            "/api/v1/poses/text",
            json={"name": "invalid.pose", "content": "not a pose"},
        )
        self.assertEqual(response.status_code, 422)

    def test_mvp_page_is_available(self) -> None:
        response = self.client.get("/mvp")
        self.assertEqual(response.status_code, 200)
        self.assertIn("NeoTalk Chat", response.text)

    @patch("app.main.neotalk_client.download_pose")
    @patch("app.main.neotalk_client.task_status")
    @patch("app.main.neotalk_client.submit_phrase")
    def test_mvp_phrase_to_pose_flow(
        self, submit_phrase, task_status, download_pose
    ) -> None:
        task_id = "12345abcde"
        submit_phrase.return_value = NeoTalkResponse(202, {"task_id": task_id})
        task_status.side_effect = [
            NeoTalkResponse(202, {}),
            NeoTalkResponse(
                200,
                {
                    "file_url": "https://storage.example/generated.pose",
                    "palavras_encontradas": ["cadeira.pose"],
                },
            ),
        ]
        download_pose.return_value = self.pose_text.encode("utf-8")

        created = self.client.post(
            "/api/v1/mvp/sign", json={"phrase": "  cadeira  "}
        )
        self.assertEqual(created.status_code, 202, created.text)
        self.assertEqual(created.json()["task_id"], task_id)

        pending = self.client.get(f"/api/v1/mvp/tasks/{task_id}")
        self.assertEqual(pending.status_code, 202, pending.text)

        ready = self.client.get(f"/api/v1/mvp/tasks/{task_id}")
        self.assertEqual(ready.status_code, 200, ready.text)
        payload = ready.json()
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["palavras_encontradas"], ["cadeira.pose"])
        self.assertIn("/content", payload["pose"]["content_url"])


if __name__ == "__main__":
    unittest.main()
