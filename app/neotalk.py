from __future__ import annotations

import json
import re
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

from .config import Settings


TASK_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,100}$")


class NeoTalkApiError(RuntimeError):
    def __init__(self, detail: str, *, status_code: int = 502):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class NeoTalkResponse:
    status_code: int
    payload: dict


class NeoTalkClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def configured(self) -> bool:
        return bool(self.settings.neotalk_api_key)

    def submit_phrase(self, phrase: str) -> NeoTalkResponse:
        body = urlencode({"frase": phrase}).encode("utf-8")
        return self._json_request(
            "/sign-process-pose",
            method="POST",
            body=body,
            content_type="application/x-www-form-urlencoded",
        )

    def task_status(self, task_id: str) -> NeoTalkResponse:
        if not TASK_ID_RE.fullmatch(task_id):
            raise NeoTalkApiError("invalid task id", status_code=400)
        return self._json_request(f"/task-status-pose/{quote(task_id)}")

    def download_pose(self, file_url: str) -> bytes:
        parsed = urlparse(file_url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise NeoTalkApiError("pose service returned an invalid file URL")

        request = Request(file_url, headers={"Accept": "text/plain"})
        try:
            with urlopen(request, timeout=self.settings.neotalk_api_timeout_seconds) as response:
                raw = response.read(self.settings.max_pose_bytes + 1)
        except HTTPError as exception:
            raise NeoTalkApiError(
                f"pose file is unavailable (HTTP {exception.code})"
            ) from exception
        except (TimeoutError, URLError) as exception:
            raise NeoTalkApiError("could not download the generated pose") from exception

        if len(raw) > self.settings.max_pose_bytes:
            raise NeoTalkApiError("generated pose exceeds the configured size limit")
        return raw

    def _json_request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> NeoTalkResponse:
        if not self.configured:
            raise NeoTalkApiError(
                "NeoTalk pose API is not configured", status_code=503
            )

        headers = {
            "Accept": "application/json",
            "x-api-key": self.settings.neotalk_api_key,
        }
        if content_type:
            headers["Content-Type"] = content_type

        url = self.settings.neotalk_api_base_url.rstrip("/") + path
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.settings.neotalk_api_timeout_seconds) as response:
                status_code = response.status
                raw = response.read(1_048_577)
        except HTTPError as exception:
            raw = exception.read(1_048_577)
            detail = self._error_detail(raw, exception.code)
            raise NeoTalkApiError(detail) from exception
        except (TimeoutError, URLError) as exception:
            raise NeoTalkApiError("NeoTalk pose API is unavailable") from exception

        if len(raw) > 1_048_576:
            raise NeoTalkApiError("NeoTalk pose API returned an oversized response")
        if not raw and status_code == 202:
            return NeoTalkResponse(status_code, {})
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exception:
            raise NeoTalkApiError("NeoTalk pose API returned invalid JSON") from exception
        if not isinstance(payload, dict):
            raise NeoTalkApiError("NeoTalk pose API returned an invalid response")
        return NeoTalkResponse(status_code, payload)

    @staticmethod
    def _error_detail(raw: bytes, status_code: int) -> str:
        try:
            payload = json.loads(raw.decode("utf-8"))
            if isinstance(payload, dict) and payload.get("error"):
                return str(payload["error"])
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        return f"NeoTalk pose API failed with HTTP {status_code}"
