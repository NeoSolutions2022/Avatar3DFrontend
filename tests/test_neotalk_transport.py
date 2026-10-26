"""Actual loopback HTTP/1.1 plus controlled HTTPS failure/security checks."""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookiejar import CookieJar
from unittest.mock import patch

import httpx
import pytest

from app.config import Settings
from app.neotalk import NeoTalkApiError, NeoTalkClient, _NoProviderCookies


@contextmanager
def server():
    class Server(ThreadingHTTPServer):
        daemon_threads = True
        connections = 0
        active = 0
        peak = 0
        requests = []
        lock = threading.Lock()

        def get_request(self):
            result = super().get_request()
            with self.lock:
                self.connections += 1
            return result

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_args):
            pass

        def do_POST(self):
            self.do_GET()

        def do_GET(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            with self.server.lock:
                self.server.requests.append((self.path, dict(self.headers), body))
                self.server.active += 1
                self.server.peak = max(self.server.peak, self.server.active)
            time.sleep(.01)
            status, raw = 200, json.dumps({'task_id': 'fixed', 'status': 'complete'}).encode()
            if self.path.endswith('/badjson'):
                raw = b'not json'
            elif self.path.endswith('/empty'):
                status, raw = 202, b''
            elif self.path.endswith('/oversized'):
                raw = b'x' * 1_048_577
            elif self.path.endswith('/failed'):
                status, raw = 502, b'{"error":"provider unavailable"}'
            elif self.path.endswith('/redirect'):
                status, raw = 302, b''
            self.send_response(status)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Content-Type', 'application/json')
            self.send_header('Set-Cookie', 'provider_session=must-not-replay')
            if status == 302:
                self.send_header('Location', 'https://other.invalid/private')
            self.end_headers()
            try:
                self.wfile.write(raw)
            except OSError:
                pass
            finally:
                with self.server.lock:
                    self.server.active -= 1

    instance = Server(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=instance.serve_forever, daemon=True)
    worker.start()
    try:
        yield instance, f'http://127.0.0.1:{instance.server_port}'
    finally:
        instance.shutdown()
        instance.server_close()
        worker.join(timeout=5)


def client_for(url):
    return NeoTalkClient(replace(Settings(), neotalk_api_base_url=url,
                                 neotalk_api_key='synthetic-test-key', neotalk_api_timeout_seconds=3))


def test_actual_pool_reuses_tcp_without_carrying_provider_cookies():
    with server() as (origin, url):
        client = client_for(url)
        with client.lifespan():
            for i in range(12):
                assert client.task_status('job-' + str(i)).status_code == 200
            assert origin.connections == 1
            assert len(origin.requests) == 12
            assert all(headers.get('x-api-key') == 'synthetic-test-key' for _, headers, _ in origin.requests)
            assert all(not any(key.lower() == 'cookie' for key in headers) for _, headers, _ in origin.requests)
        assert client._http is None


def test_no_lifespan_fallback_closes_each_transport():
    with server() as (origin, url):
        client = client_for(url)
        transports = []
        create = client._new_http_client

        def tracked():
            item = create()
            transports.append(item)
            return item

        with patch.object(client, '_new_http_client', tracked):
            for i in range(4):
                client.task_status(str(i))
        assert origin.connections == 4
        assert all(item.is_closed for item in transports)


def test_submit_bytes_unchanged_and_authentication_is_per_request():
    with server() as (origin, url):
        client = client_for(url)
        with client.lifespan():
            client.submit_phrase('EU QUERER PERGUNTAR_DÚVIDA')
            client.settings = replace(client.settings, neotalk_api_key='second-synthetic-key')
            client.task_status('fixed')
        first, second = origin.requests
        assert first[2] == b'frase=EU+QUERER+PERGUNTAR_D%C3%9AVIDA'
        assert first[1]['x-api-key'] == 'synthetic-test-key'
        assert second[1]['x-api-key'] == 'second-synthetic-key'


def test_concurrent_calls_are_complete_and_connection_budget_is_bounded():
    with server() as (origin, url):
        client = client_for(url)
        with client.lifespan(), ThreadPoolExecutor(max_workers=20) as workers:
            results = list(workers.map(client.task_status, ['job-' + str(i) for i in range(40)]))
        assert len(results) == len(origin.requests) == 40
        assert all(item.status_code == 200 for item in results)
        assert origin.peak <= 8
        # Count over a lifetime can exceed the concurrent limit due to retirement.


@pytest.mark.parametrize('task,expected', [('badjson', 'invalid JSON'), ('oversized', 'oversized'),
                                         ('failed', 'provider unavailable'), ('redirect', 'HTTP 302')])
def test_status_failures_stay_bounded_and_stage_specific(task, expected):
    with server() as (_origin, url):
        client = client_for(url)
        with client.lifespan(), pytest.raises(NeoTalkApiError, match=expected) as error:
            client.task_status(task)
        assert error.value.stage == 'task_status'
        assert error.value.status_code == 502


def test_empty_pending_response_and_recovery_after_error():
    with server() as (_origin, url):
        client = client_for(url)
        with client.lifespan():
            assert client.task_status('empty').payload == {}
            with pytest.raises(NeoTalkApiError):
                client.task_status('failed')
            assert client.task_status('good').status_code == 200


def test_lifespan_rejects_second_owner_and_closes_on_failure():
    client = client_for('https://api.invalid')
    transport = None
    with pytest.raises(ValueError, match='test stop'):
        with client.lifespan():
            transport = client._http
            with pytest.raises(RuntimeError, match='already active'):
                with client.lifespan():
                    pass
            assert client._http is transport and not transport.is_closed
            raise ValueError('test stop')
    assert transport.is_closed and client._http is None
    with patch.object(client, '_new_http_client', side_effect=RuntimeError('startup failed')):
        with pytest.raises(RuntimeError, match='startup failed'):
            with client.lifespan():
                pass
    with client.lifespan():
        assert client._http is not None


def test_https_download_has_no_api_key_or_cookie_and_preserves_original_bytes():
    client = client_for('https://api.invalid')
    seen = []
    raw = b'\xef\xbb\xbf# Frame: original\r\n0.125 -0.25 0.5\r\n'

    def handle(request):
        seen.append(request)
        if request.url.host == 'api.invalid':
            return httpx.Response(200, json={'task_id': 'fixed'}, headers={'Set-Cookie': 's=private'})
        return httpx.Response(200, content=raw)

    with patch.object(client, '_new_http_client', lambda: httpx.Client(
        transport=httpx.MockTransport(handle), cookies=CookieJar(policy=_NoProviderCookies())
    )):
        with client.lifespan():
            client.task_status('fixed')
            assert client.download_pose('https://files.invalid/source.pose') == raw
    assert seen[0].headers['x-api-key'] == 'synthetic-test-key'
    assert 'x-api-key' not in seen[1].headers and 'cookie' not in seen[1].headers


@pytest.mark.parametrize('location,allowed', [('https://cdn.invalid/source.pose', True),
                                             ('http://cdn.invalid/source.pose', False),
                                             ('https://user:password@cdn.invalid/source.pose', False)])
def test_download_redirect_rechecks_tls_and_never_forwards_api_credentials(location, allowed):
    client = client_for('https://api.invalid')
    seen = []
    def handle(request):
        seen.append(request)
        if request.url.host == 'files.invalid':
            return httpx.Response(302, headers={'Location': location})
        return httpx.Response(200, content=b'exact source')
    with patch.object(client, '_new_http_client', lambda: httpx.Client(transport=httpx.MockTransport(handle))):
        with client.lifespan():
            if allowed:
                assert client.download_pose('https://files.invalid/source.pose') == b'exact source'
            else:
                with pytest.raises(NeoTalkApiError, match='invalid file URL'):
                    client.download_pose('https://files.invalid/source.pose')
    assert len(seen) == (2 if allowed else 1)
    assert all('x-api-key' not in request.headers for request in seen)


def test_asgi_lifespan_owns_and_closes_the_actual_pool():
    from fastapi.testclient import TestClient
    from app.main import app, neotalk_client
    assert neotalk_client._http is None
    with TestClient(app) as browser:
        transport = neotalk_client._http
        assert transport is not None and not transport.is_closed
        assert browser.get('/api/v1/health').status_code == 200
    assert transport.is_closed and neotalk_client._http is None


def test_download_limits_timeouts_and_url_credentials():
    client = client_for('https://api.invalid')
    client.settings = replace(client.settings, max_pose_bytes=8)
    with patch.object(client, '_new_http_client', lambda: httpx.Client(
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, content=b'x' * 9))
    )):
        with client.lifespan(), pytest.raises(NeoTalkApiError, match='size limit') as error:
            client.download_pose('https://files.invalid/pose')
        assert error.value.stage == 'download'
    for url in ['http://files.invalid/pose', 'https://user:password@files.invalid/pose']:
        with pytest.raises(NeoTalkApiError, match='invalid file URL'):
            client.download_pose(url)
    def timeout(_request):
        raise httpx.ReadTimeout('synthetic timeout')
    with patch.object(client, '_new_http_client', lambda: httpx.Client(transport=httpx.MockTransport(timeout))):
        with client.lifespan(), pytest.raises(NeoTalkApiError) as error:
            client.task_status('fixed')
        assert error.value.stage == 'task_status' and error.value.status_code == 502
