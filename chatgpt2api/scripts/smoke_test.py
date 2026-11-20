#!/usr/bin/env python3
"""Authenticated API contract smoke test; image generation is explicitly opt-in."""
import argparse
import base64
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def local_key():
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.startswith("CHATGPT2API_AUTH_KEY="):
            return line.partition("=")[2].strip().strip('"').strip("'")
    return None


def request(url, key, method="GET", payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + key)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=150 if payload is not None else 15) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--key", default=os.environ.get("CHATGPT2API_API_KEY") or local_key())
    parser.add_argument("--image", action="store_true", help="Generate a real image (uses upstream quota)")
    parser.add_argument("--model", default="gpt-image-2.6")
    parser.add_argument("--output", default="smoke-image.png")
    a = parser.parse_args()
    if not a.key or a.key == "REPLACE_WITH_RANDOM_SECRET":
        parser.error("No API key found. Run sh scripts/setup.sh or pass --key.")
    root = a.base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    try:
        models = request(root + "/v1/models", a.key)
        assert isinstance(models, dict) and isinstance(models.get("data"), list), "Unexpected /models schema"
        print("PASS: authenticated /v1/models; models =", len(models["data"]))
        try:
            request(root + "/v1/models", "intentionally-invalid-smoke-key")
            print("FAIL: invalid key unexpectedly accepted")
            return 1
        except urllib.error.HTTPError as exc:
            if exc.code not in (401, 403):
                print("FAIL: invalid key responded with HTTP", exc.code)
                return 1
            print("PASS: invalid API key rejected (HTTP %s)" % exc.code)
        if not a.image:
            print("SKIP: image generation (pass --image after adding an upstream account)")
            return 0
        result = request(root + "/v1/images/generations", a.key, "POST", {
            "model": a.model,
            "prompt": "A single small white cat on a blue background",
            "n": 1,
            "response_format": "b64_json",
        })
        encoded = (result.get("data") or [{}])[0].get("b64_json")
        if not encoded:
            print("FAIL: image response missing data[0].b64_json (possibly URL-only response)")
            return 1
        raw = base64.b64decode(encoded, validate=True)
        signature = (
            (raw.startswith(b"\x89PNG\r\n\x1a\n"), "png"),
            (raw.startswith(b"\xff\xd8\xff"), "jpg"),
            (raw.startswith(b"RIFF") and raw[8:12] == b"WEBP", "webp"),
        )
        filetype = next((ext for ok, ext in signature if ok), None)
        if not filetype or not 100 <= len(raw) <= 8*1024*1024:
            print("FAIL: unsupported image bytes or size")
            return 1
        out = Path(a.output).with_suffix("." + filetype)
        out.write_bytes(raw)
        print("PASS: real generated image", out, len(raw), "bytes")
        return 0
    except (urllib.error.URLError, AssertionError, ValueError, OSError) as exc:
        print("FAIL:", exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
