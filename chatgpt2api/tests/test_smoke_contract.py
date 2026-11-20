"""Offline HTTP contract tests for the self-hosted ChatGPT2API smoke tester.

A loopback fake API verifies authentication and response handling only. It does not
prove the external ChatGPT upstream can generate images.
"""
import base64
from contextlib import redirect_stdout, redirect_stderr
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "smoke_test.py"
SPEC = importlib.util.spec_from_file_location("chatgpt2api_smoke_test", SCRIPT)
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)

# A minimal signature and enough bytes to exercise the transport/size contract.
MOCK_PNG = b"\x89PNG\r\n\x1a\n" + (b"\x00" * 112)


class MockGateway(BaseHTTPRequestHandler):
    image_requests = 0

    def log_message(self, *_args):
        pass

    def reply(self, status, body):
        payload = __import__("json").dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        return self.headers.get("Authorization") == "Bearer local-test-only-key"

    def do_GET(self):
        if self.path != "/v1/models":
            return self.reply(404, {"error": "missing"})
        if not self.authorized():
            return self.reply(401, {"error": "invalid key"})
        self.reply(200, {"object": "list", "data": [{"id": "gpt-image-2.6"}]})

    def do_POST(self):
        if not self.authorized():
            return self.reply(403, {"error": "invalid key"})
        if self.path != "/v1/images/generations":
            return self.reply(404, {"error": "missing"})
        size = int(self.headers.get("Content-Length", "0"))
        payload = __import__("json").loads(self.rfile.read(size))
        if payload.get("response_format") != "b64_json" or payload.get("n") != 1:
            return self.reply(400, {"error": "invalid image contract"})
        type(self).image_requests += 1
        self.reply(200, {"data": [{"b64_json": base64.b64encode(MOCK_PNG).decode("ascii")}]})


class SmokeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockGateway)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def invoke(self, *args):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", ["smoke_test.py", "--base-url", self.url,
                                       "--key", "local-test-only-key", *args]):
            with redirect_stdout(output), redirect_stderr(errors):
                code = smoke.main()
        return code, output.getvalue(), errors.getvalue()

    def test_models_and_invalid_key_checked_without_generation(self):
        before = MockGateway.image_requests
        code, message, _errors = self.invoke()
        self.assertEqual(code, 0)
        self.assertIn("PASS: authenticated /v1/models", message)
        self.assertIn("PASS: invalid API key rejected", message)
        self.assertIn("SKIP: image generation", message)
        self.assertEqual(MockGateway.image_requests, before)

    def test_image_contract_writes_generated_bytes(self):
        with tempfile.TemporaryDirectory() as dirname:
            filename = str(Path(dirname) / "smoke-image.png")
            code, message, _errors = self.invoke("--image", "--output", filename)
            self.assertEqual(code, 0)
            self.assertIn("PASS: real generated image", message)
            self.assertEqual(Path(filename).read_bytes(), MOCK_PNG)

    def test_bad_endpoint_fails_closed(self):
        with patch.object(sys, "argv", ["smoke_test.py", "--base-url", "http://127.0.0.1:1",
                                       "--key", "local-test-only-key"]):
            with redirect_stderr(io.StringIO()):
                code = smoke.main()
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
