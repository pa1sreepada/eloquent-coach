"""Local API access control (api_auth) and the LLM endpoint policy (llm_provider.check_url)."""
import os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(tempfile.mkdtemp())
os.environ["ELOQUENT_STATE_DIR"] = os.getcwd()
os.environ["ELOQUENT_API_TOKEN"] = TOKEN = "a1" * 32

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import api_auth
import llm_provider
from llm_provider import LlmError, check_url

app = FastAPI()
app.add_middleware(api_auth.ApiGuard)


@app.get("/")
def health():
    return {"ok": True}


@app.get("/data")
def data():
    return {"secret": 1}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    await sock.send_json({"hello": 1})
    await sock.close()


def test_http():
    good = TestClient(app, base_url="http://127.0.0.1:8000")
    auth = {"Authorization": f"Bearer {TOKEN}"}
    assert good.get("/").status_code == 200                       # health check is public
    assert good.get("/data").status_code == 401
    assert good.get("/data", headers={"Authorization": "Bearer " + "b1" * 32}).status_code == 401
    assert good.get("/data", headers=auth).json() == {"secret": 1}
    assert TestClient(app, base_url="http://localhost:8000").get("/data", headers=auth).status_code == 200
    # DNS rebinding: attacker.example resolving to 127.0.0.1 still sends its own Host header
    assert TestClient(app, base_url="http://attacker.example:8000").get("/data", headers=auth).status_code == 421


def test_token_file():
    os.environ.pop("ELOQUENT_API_TOKEN")
    try:
        api_auth.ensure_token()
        assert oct(api_auth.TOKEN_FILE.stat().st_mode & 0o777) == "0o600"
        file_token = api_auth.TOKEN_FILE.read_text()
        assert api_auth.token_ok(file_token) and not api_auth.token_ok(TOKEN) and not api_auth.token_ok("")
    finally:
        os.environ["ELOQUENT_API_TOKEN"] = TOKEN


def test_websocket():
    c = TestClient(app, base_url="http://127.0.0.1:8000")
    protocols = ["eloquent", f"token.{TOKEN}"]
    with c.websocket_connect("ws://127.0.0.1:8000/ws", subprotocols=protocols, headers={"Origin": "http://localhost:5173"}) as s:
        assert s.accepted_subprotocol == "eloquent"   # browsers drop the socket without it
        assert s.receive_json() == {"hello": 1}
    with c.websocket_connect("ws://127.0.0.1:8000/ws", subprotocols=protocols, headers={"Origin": "null"}) as s:   # packaged file://
        assert s.receive_json() == {"hello": 1}
    for kw in ({"subprotocols": ["eloquent"]},                                                  # no token
               {"subprotocols": protocols, "headers": {"Origin": "https://evil.example"}}):    # foreign page
        try:
            with c.websocket_connect("ws://127.0.0.1:8000/ws", **kw) as s:
                s.receive_json()
            raise AssertionError(f"accepted {kw}")
        except WebSocketDisconnect as err:
            assert err.code == 1008


def test_llm_urls():
    ok = lambda url, remote=False: check_url(url, remote)  # noqa: E731
    assert ok("http://127.0.0.1:11434/v1/") == "http://127.0.0.1:11434/v1"
    assert ok("http://localhost:1234/v1") and ok("http://[::1]:1234/v1")
    for url, remote in [("ftp://127.0.0.1/v1", True), ("http://user:pw@127.0.0.1:1234/v1", True),
                        ("http://0.0.0.0:11434/v1", True),         # bind address, not a server address
                        ("http://192.168.1.20:11434/v1", False),   # off this Mac needs opt-in
                        ("http://llm.example.com/v1", True),       # internet server needs https
                        ("http://127.0.0.1:1234/v1?x=1", False), ("not a url", True)]:
        try:
            ok(url, remote)
            raise AssertionError(url)
        except LlmError:
            pass
    assert ok("http://192.168.1.20:11434/v1", True) and ok("http://studio.local:1234/v1", True)
    assert ok("https://llm.example.com/v1", True)
    assert llm_provider.client_kwargs()["follow_redirects"] is False


if __name__ == "__main__":
    test_http(); test_token_file(); test_websocket(); test_llm_urls()
    print("api auth tests passed")
