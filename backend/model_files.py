"""ASR model file names and the app-owned models folder (no heavy imports; shared with scripts/)."""
import os

ASR_REPO = "handy-computer/parakeet-unified-en-0.6b-gguf"
ASR_FILE = "parakeet-unified-en-0.6b-Q8_0.gguf"
VAD_REPO = "handy-computer/silero-vad-v6.2-gguf"
VAD_FILE = "silero-vad-v6.2-F32.gguf"

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
