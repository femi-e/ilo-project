"""Configuration for the sliding context benchmark."""

import os

# Paths (override with env vars: SESSION_DIR, MODEL_PATH)
SESSION_DIR = os.environ.get(
    "SESSION_DIR",
    os.path.expanduser("~/.pi/agent/sessions/example-session/"),
)
MODEL_PATH = os.environ.get("MODEL_PATH", "/path/to/model.gguf")
CUT_TURN = 10  # Split after this turn (pre: 1-10, post: 11+)
RUNS_PER_TEST = 2  # Number of runs per test (reduced from 3 for speed)
MAX_TOKENS = 800  # Max tokens for model response

# MTPLX server
BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "mtplx"

# Techniques to test (A-G)
TECHNIQUES = ["A", "B", "C", "D", "E", "F", "G"]

# Sampling parameters (our tuned values)
SAMPLING = {
    "temperature": 0.8,
    "top_p": 0.95,
    "top_k": 20,
    "presence_penalty": 0.3,
    "repeat_penalty": 1.0,
}
