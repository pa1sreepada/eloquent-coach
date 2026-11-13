"""ASR model file names and the app-owned models folder (no heavy imports; shared with scripts/)."""
import hashlib
import os
from functools import lru_cache

ASR_REPO = "handy-computer/parakeet-unified-en-0.6b-gguf"
ASR_FILE = "parakeet-unified-en-0.6b-Q8_0.gguf"
VAD_REPO = "handy-computer/silero-vad-v6.2-gguf"
VAD_FILE = "silero-vad-v6.2-F32.gguf"

# Pinned Hugging Face commits and the files' sha256, so a changed or tampered upload is never loaded
# (model files are parsed by native code). Update these together when moving to a new model release.
MODEL_REVISIONS = {
    ASR_REPO: "843b1b175ace04f5a89d379c79e2518c0d065b25",
    VAD_REPO: "a9b2d61c20ae4ddf3644edb34969e8185a485448",
}
MODEL_SHA256 = {
    ASR_FILE: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
    VAD_FILE: "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6",
}


@lru_cache(maxsize=8)
def _file_sha256(path: str, size: int, mtime: float) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify_model_file(path: str, name: str) -> str:
    """The path if the file's sha256 matches the pinned hash for `name`; raises ValueError otherwise."""
    st = os.stat(path)
    actual = _file_sha256(path, st.st_size, st.st_mtime)
    if actual != MODEL_SHA256[name]:
        raise ValueError(f"{path} does not match the expected {name} (sha256 {actual[:12]}…, "
                         f"expected {MODEL_SHA256[name][:12]}…). Delete it and let the app download it again.")
    return path

MODELS_DIR = os.environ.get("ELOQUENT_MODELS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


def use_system_trust_store() -> None:
    """Verify TLS against the OS trust store (macOS Keychain / Windows cert store / Linux CA bundle).

    Needed behind corporate TLS-inspecting proxies, whose root CA is in the OS store but not in
    Python's bundled certifi list. An explicit SSL_CERT_FILE / REQUESTS_CA_BUNDLE is respected.
    """
    if os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE"):
        return
    try:
        import truststore
        truststore.inject_into_ssl()
    except Exception:  # noqa: BLE001 - fall back to Python's default verification
        pass
