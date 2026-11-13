"""Access control for the local API: only the Eloquent Coach app may call it.

Binding to 127.0.0.1 keeps other machines out, but any web page in your browser (and any local
process) can still reach 127.0.0.1:8000. So every request must carry a per-launch secret:

* HTTP:       `Authorization: Bearer <token>`
* WebSocket:  subprotocols `["eloquent", "token.<token>"]` (browsers can't set headers on WebSockets);
              browser origins must also be the app's own.

The Electron app creates a fresh token at each launch, passes it to the backend as ELOQUENT_API_TOKEN
and writes it to ~/.eloquent-coach/api-token (owner-only) so a backend started by hand, and local dev
tools, can use it too. The Host header is checked as well, which defeats DNS rebinding.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import secrets

from secure_store import STATE_DIR

TOKEN_FILE = STATE_DIR / "api-token"
WS_PROTOCOL = "eloquent"
WS_TOKEN_PREFIX = "token."
PUBLIC_PATHS = {"/"}   # health check used while the backend starts; returns no data
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}
# The renderer's origin: the Vite dev server, or file:// (sent as "file://" or "null") when packaged.
APP_ORIGIN = re.compile(r"^(http://(localhost|127\.0\.0\.1)(:\d+)?|null|file://)$")
_MIN_TOKEN_LEN = 32
_file_cache: tuple[float, str] | None = None


def _file_token() -> str | None:
    global _file_cache
    try:
        mtime = TOKEN_FILE.stat().st_mtime
    except FileNotFoundError:
        return None
    if _file_cache is None or _file_cache[0] != mtime:
        _file_cache = (mtime, TOKEN_FILE.read_text().strip())
    return _file_cache[1]


def ensure_token() -> None:
    """A backend started without the app still gets a token (in the token file) instead of running open."""
    if os.environ.get("ELOQUENT_API_TOKEN") or _file_token():
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(secrets.token_hex(32))


def token_ok(candidate: str | None) -> bool:
    if not candidate or len(candidate) < _MIN_TOKEN_LEN or not candidate.isascii():
        return False
    for expected in (os.environ.get("ELOQUENT_API_TOKEN"), _file_token()):
        if expected and len(expected) >= _MIN_TOKEN_LEN and hmac.compare_digest(candidate.encode(), expected.encode()):
            return True
    return False


def host_ok(host_header: str) -> bool:
    host = host_header.strip().lower()
    if host.startswith("["):              # [::1]:8000
        host = host[1:host.find("]")] if "]" in host else host
    elif host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host in ALLOWED_HOSTS


class ApiGuard:
    """ASGI middleware covering HTTP and WebSocket routes."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if not host_ok(headers.get("host", "")):
            return await self._deny(scope, receive, send, 421, "Invalid Host header.")

        if scope["type"] == "http":
            if scope["method"] == "OPTIONS" or scope["path"] in PUBLIC_PATHS:
                return await self.app(scope, receive, send)
            auth = headers.get("authorization", "")
            if not (auth.startswith("Bearer ") and token_ok(auth[7:].strip())):
                return await self._deny(scope, receive, send, 401, "Missing or invalid API token.")
            return await self.app(scope, receive, send)

        origin = headers.get("origin")
        if origin is not None and not APP_ORIGIN.match(origin):
            return await self._deny(scope, receive, send, 403, "Origin not allowed.")
        offered = [p.strip() for p in headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
        token = next((p[len(WS_TOKEN_PREFIX):] for p in offered if p.startswith(WS_TOKEN_PREFIX)), None)
        if not token_ok(token):
            return await self._deny(scope, receive, send, 403, "Missing or invalid API token.")

        async def send_with_protocol(message):
            # A browser that offered subprotocols drops the connection unless the server picks one.
            if message["type"] == "websocket.accept" and WS_PROTOCOL in offered and not message.get("subprotocol"):
                message = {**message, "subprotocol": WS_PROTOCOL}
            await send(message)

        return await self.app(scope, receive, send_with_protocol)

    @staticmethod
    async def _deny(scope, receive, send, status: int, detail: str):
        if scope["type"] == "websocket":
            await receive()   # websocket.connect
            await send({"type": "websocket.close", "code": 1008, "reason": detail})
            return
        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
