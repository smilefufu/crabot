"""Exercise the build script's downloader without starting browser packaging."""
import ast
from contextlib import contextmanager
import hashlib
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request


def downloader():
    source = Path(__file__).resolve().parent.parent / 'build.py'
    definition = next(node for node in ast.parse(source.read_text(encoding='utf-8')).body
                      if isinstance(node, ast.FunctionDef) and node.name == 'download_linux_resource')
    scope = {'hashlib': hashlib, 'time': time, 'urllib': urllib}
    exec(compile(ast.Module(body=[definition], type_ignores=[]), str(source), 'exec'), scope)
    return scope['download_linux_resource']


@contextmanager
def server(statuses, body=b'locked resource'):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.server.requests += 1
            status = statuses[min(self.server.requests - 1, len(statuses) - 1)]
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    host = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    host.requests = 0
    thread = threading.Thread(target=host.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
    thread.start()
    try:
        with patch.dict(os.environ, {'NO_PROXY': '127.0.0.1', 'no_proxy': '127.0.0.1'}):
            yield host, f'http://127.0.0.1:{host.server_port}/resource'
    finally:
        host.shutdown()
        host.server_close()
        thread.join(2)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='crabot-build-download-')
        self.addCleanup(temporary.cleanup)
        self.archive = Path(temporary.name) / 'locked.deb'
        self.expected = hashlib.sha256(b'locked resource').hexdigest()
        self.download = downloader()

    def test_one_transient_503_retries_original_url_and_verifies_exact_bytes(self):
        with server([503, 200]) as (host, url):
            self.download(url, self.archive, self.expected, None)
            self.assertEqual(host.requests, 2)
            self.assertEqual(self.archive.read_bytes(), b'locked resource')

    def test_persistent_503_stops_after_one_retry(self):
        with server([503]) as (host, url):
            with self.assertRaises(urllib.error.HTTPError):
                self.download(url, self.archive, self.expected, None)
            self.assertEqual(host.requests, 2)
            self.assertFalse(self.archive.exists())

    def test_other_http_errors_do_not_retry(self):
        for status in [401, 403, 404, 500]:
            with self.subTest(status=status), server([status]) as (host, url):
                with self.assertRaises(urllib.error.HTTPError):
                    self.download(url, self.archive, self.expected, None)
                self.assertEqual(host.requests, 1)

    def test_checksum_failure_never_retries_or_accepts_other_bytes(self):
        with server([200], b'wrong bytes') as (host, url):
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                self.download(url, self.archive, self.expected, None)
            self.assertEqual(host.requests, 1)

    def test_certificate_and_local_io_errors_do_not_retry(self):
        error = ssl.SSLCertVerificationError('invalid certificate')
        with patch.object(urllib.request, 'urlopen', side_effect=error) as opened:
            with self.assertRaises(ssl.SSLCertVerificationError):
                self.download('https://invalid.test/resource', self.archive, self.expected, None)
            self.assertEqual(opened.call_count, 1)
        self.archive.mkdir()
        with server([200]) as (host, url):
            with self.assertRaises(OSError):
                self.download(url, self.archive, self.expected, None)
            self.assertEqual(host.requests, 1)

    def test_retry_cannot_renew_the_original_header_timeout_budget(self):
        error = urllib.error.HTTPError('https://invalid.test/resource', 503, 'unavailable', {}, None)
        clock = SimpleNamespace(monotonic=Mock(side_effect=[0, 119.5, 120.1]), sleep=Mock())
        with patch.dict(self.download.__globals__, {'time': clock}), patch.object(urllib.request, 'urlopen', side_effect=error) as opened:
            with self.assertRaises(urllib.error.HTTPError):
                self.download(error.url, self.archive, self.expected, None)
            self.assertEqual(opened.call_count, 1)
            self.assertEqual(opened.call_args.kwargs['timeout'], 0.5)
            clock.sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
