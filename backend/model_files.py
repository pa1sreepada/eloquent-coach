"""ASR model file names and the app-owned models folder (no heavy imports; shared with scripts/)."""
import os

ASR_REPO = "handy-computer/parakeet-unified-en-0.6b-gguf"
ASR_FILE = "parakeet-unified-en-0.6b-Q8_0.gguf"
VAD_REPO = "handy-computer/silero-vad-v6.2-gguf"
VAD_FILE = "silero-vad-v6.2-F32.gguf"

MODELS_DIR = os.environ.get("ELOQUENT_MODELS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
