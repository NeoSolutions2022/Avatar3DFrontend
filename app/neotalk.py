from __future__ import annotations

import json
import re
from contextlib import contextmanager
from dataclasses import dataclass
from http.cookiejar import CookieJar, DefaultCookiePolicy
from threading import Lock
from urllib.parse import quote, urlencode, urlparse

import httpx

from .config import Settings


TASK_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,100}$")


class _NoProviderCookies(DefaultCookiePolicy):
    def set_ok(self, cookie, request):
        return False


class NeoTalkApiError(RuntimeError):
    def __init__(self, detail: str, *, status_code: int = 502, stage: str = "unknown", upstream_status: int | None = None):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code
        self.stage = stage
        self.upstream_status = upstream_status


@dataclass(frozen=True)
class NeoTalkResponse:
    status_code: int
    payload: dict


class NeoTalkClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._http: httpx.Client | None = None
        self._lifespan_active = False
        self._lifecycle_lock = Lock()

    def _new_http_client(self) -> httpx.Client:
        return httpx.Client(
            timeout=httpx.Timeout(self.settings.neotalk_api_timeout_seconds, pool=5.0),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=30),
            cookies=CookieJar(policy=_NoProviderCookies()),
            headers={"Accept-Encoding": "identity"},
        )

    @contextmanager
    def lifespan(self):
        # Reserve ownership before constructing the transport (which may fail).
        with self._lifecycle_lock:
            if self._lifespan_active:
                raise RuntimeError("NeoTalk HTTP lifespan is already active")
            self._lifespan_active = True
        try:
            with self._new_http_client() as client:
                self._http = client
                yield
        finally:
            self._http = None
            with self._lifecycle_lock:
                self._lifespan_active = False

    @contextmanager
    def _transport(self):
        if self._http is not None:
            yield self._http
        else:
            # CLI/direct tests without ASGI startup still release their resources.
            with self._new_http_client() as client:
                yield client

    @staticmethod
    def _read_bounded(response: httpx.Response, limit: int) -> bytes:
        raw = bytearray()
        for chunk in response.iter_bytes(chunk_size=65536):
            raw.extend(chunk[:max(0, limit + 1 - len(raw))])
            if len(raw) > limit:
                break
        return bytes(raw)

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
        try:
            with self._transport() as client:
                for _ in range(6):
                    try:
                        parsed = urlparse(file_url)
                        port = parsed.port  # Reject malformed ports before opening a connection.
                        valid = parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and (port is None or port > 0)
                    except ValueError:
                        valid = False
                    if not valid:
                        raise NeoTalkApiError("pose service returned an invalid file URL", stage="download")
                    with client.stream("GET", file_url, headers={"Accept": "text/plain"}, follow_redirects=False) as response:
                        if response.is_redirect and response.headers.get("location"):
                            # Recheck TLS/credentials on every hop, including relative redirects.
                            file_url = str(response.url.join(response.headers["location"]))
                            continue
                        if response.status_code >= 300:
                            raise NeoTalkApiError(
                                f"pose file is unavailable (HTTP {response.status_code})",
                                stage="download", upstream_status=response.status_code,
                            )
                        raw = self._read_bounded(response, self.settings.max_pose_bytes)
                        break
                else:
                    raise NeoTalkApiError("pose file exceeded redirect limit", stage="download")
        except (httpx.HTTPError, httpx.InvalidURL) as exception:
            raise NeoTalkApiError("could not download the generated pose", stage="download") from exception

        if len(raw) > self.settings.max_pose_bytes:
            raise NeoTalkApiError("generated pose exceeds the configured size limit", stage="download")
        return raw

    def _json_request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> NeoTalkResponse:
        stage = "submit" if method == "POST" else "task_status"
        if not self.configured:
            raise NeoTalkApiError(
                "NeoTalk pose API is not configured", status_code=503, stage=stage
            )

        headers = {
            "Accept": "application/json",
            "x-api-key": self.settings.neotalk_api_key,
        }
        if content_type:
            headers["Content-Type"] = content_type

        url = self.settings.neotalk_api_base_url.rstrip("/") + path
        try:
            # Never put the API key on the shared transport or on file downloads.
            # API redirects are refused rather than forwarding credentials elsewhere.
            with self._transport() as client, client.stream(
                method, url, content=body, headers=headers, follow_redirects=False
            ) as response:
                status_code = response.status_code
                raw = self._read_bounded(response, 1_048_576)
                if status_code >= 300:
                    raise NeoTalkApiError(self._error_detail(raw, status_code), stage=stage, upstream_status=status_code)
        except (httpx.HTTPError, httpx.InvalidURL) as exception:
            raise NeoTalkApiError("NeoTalk pose API is unavailable", stage=stage) from exception

        if len(raw) > 1_048_576:
            raise NeoTalkApiError("NeoTalk pose API returned an oversized response", stage=stage)
        if not raw and status_code == 202:
            return NeoTalkResponse(status_code, {})
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exception:
            raise NeoTalkApiError("NeoTalk pose API returned invalid JSON", stage=stage) from exception
        if not isinstance(payload, dict):
            raise NeoTalkApiError("NeoTalk pose API returned an invalid response", stage=stage)
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
