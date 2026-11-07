#!/usr/bin/env python3
# managed-by: vgi-starters (edit upstream in shared/, then run tools/render.py)
"""A tiny, dependency-free paginated JSON API used by the tests.

``fetch_items`` (the example REST table function) is tested against this
server, so the suite stays deterministic and runs offline.

Endpoints
---------
``GET /items?page=<n>&page_size=<m>``
    Returns ``{"items": [...], "next_page": <n+1 or null>}`` over a fixed set
    of 25 items.
``GET /health``
    Returns ``{"status": "ok"}``.

Behaviour switches
------------------
* ``MOCK_API_TOKEN`` env var: if set, every ``/items`` request must send
  ``Authorization: Bearer <token>`` or it gets a 401.
* ``MOCK_API_FLAKY=1`` env var (or ``?flaky=1``): the first request for each
  page returns ``429`` with ``Retry-After: 0``, exercising the client's retry
  path.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
    python3 test/mock_api/server.py --port 8765
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CATEGORIES = ("hardware", "software", "service")

ITEMS = [
    {
        "id": i,
        "name": f"item-{i:02d}",
        "category": CATEGORIES[i % 3],
        "price": round(1.5 * i, 2),
    }
    for i in range(1, 26)
]

_flaky_seen: set[tuple[int, int]] = set()
_flaky_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    """Serve ``/items`` pages and ``/health``."""

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        """Log to stderr only, so stdout carries nothing except the ``PORT:`` line."""
        sys.stderr.write("mock_api: " + (format % args) + "\n")

    def _send(self, status: int, body: object, headers: dict[str, str] | None = None) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        """Handle GET requests."""
        url = urlparse(self.path)
        if url.path == "/health":
            self._send(200, {"status": "ok"})
            return
        if url.path != "/items":
            self._send(404, {"error": "not found"})
            return

        token = os.environ.get("MOCK_API_TOKEN")
        if token and self.headers.get("Authorization") != f"Bearer {token}":
            self._send(401, {"error": "missing or invalid bearer token"})
            return

        query = parse_qs(url.query)
        try:
            page = int(query.get("page", ["1"])[0])
            page_size = int(query.get("page_size", ["10"])[0])
        except ValueError:
            self._send(400, {"error": "page and page_size must be integers"})
            return
        if page < 1 or not 1 <= page_size <= 1000:
            self._send(400, {"error": "page must be >= 1 and page_size in [1, 1000]"})
            return

        if os.environ.get("MOCK_API_FLAKY") == "1" or query.get("flaky", ["0"])[0] == "1":
            with _flaky_lock:
                key = (page, page_size)
                if key not in _flaky_seen:
                    _flaky_seen.add(key)
                    self._send(429, {"error": "slow down"}, {"Retry-After": "0"})
                    return

        start = (page - 1) * page_size
        chunk = ITEMS[start : start + page_size]
        next_page = page + 1 if start + page_size < len(ITEMS) else None
        self._send(200, {"items": chunk, "next_page": next_page})


def main() -> None:
    """Start the server and print ``PORT:<n>`` once it is listening."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"PORT:{server.server_address[1]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
