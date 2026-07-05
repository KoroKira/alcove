import os
import json
import httpx
import jwt
from jwt.jwks_client import PyJWKClient
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

# ── App ───────────────────────────────────────────────────────────────────────

STATIC_DIR = os.getenv("STATIC_DIR")
ASSETS_DIR = os.getenv("ASSETS_DIR")
FRONTEND_URL = os.getenv("FRONTEND_URL")
# When true: auto-login as local@localhost, no Keycloak required, Vite proxy active
PAD_DEV_MODE = os.getenv("PAD_DEV_MODE", "false").lower() == "true"
DEV_FRONTEND_URL = os.getenv("DEV_FRONTEND_URL", "http://localhost:3003")

# Local folder where canvas pads are mirrored as .excalidraw files after each save
SYNC_DIR = os.path.expanduser(os.getenv("SYNC_DIR", ""))

# ── Pad defaults ──────────────────────────────────────────────────────────────

MAX_BACKUPS_PER_USER = 10
MIN_INTERVAL_MINUTES = 5
DEFAULT_PAD_NAME = "Untitled"
DEFAULT_TEMPLATE_NAME = "default"

with open("templates/default.json") as f:
    default_pad = json.load(f)

# ── Ollama ───────────────────────────────────────────────────────────────────

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_DEFAULT_MODEL = os.getenv("OLLAMA_DEFAULT_MODEL", "llama3.2")

# ── PostHog (analytics) ───────────────────────────────────────────────────────

POSTHOG_API_KEY = os.getenv("VITE_PUBLIC_POSTHOG_KEY")
POSTHOG_HOST = os.getenv("VITE_PUBLIC_POSTHOG_HOST")

# ── OIDC / Keycloak (production auth) ────────────────────────────────────────

OIDC_CLIENT_ID = os.getenv("OIDC_CLIENT_ID")
OIDC_CLIENT_SECRET = os.getenv("OIDC_CLIENT_SECRET")
OIDC_SERVER_URL = os.getenv("OIDC_SERVER_URL")
OIDC_REALM = os.getenv("OIDC_REALM")
OIDC_REDIRECT_URI = os.getenv("REDIRECT_URI")

_jwks_client: Optional[PyJWKClient] = None


def get_jwks_client() -> PyJWKClient:
    """Lazy singleton for the JWKS client used to verify OIDC tokens."""
    global _jwks_client
    if _jwks_client is None:
        jwks_url = f"{OIDC_SERVER_URL}/realms/{OIDC_REALM}/protocol/openid-connect/certs"
        _jwks_client = PyJWKClient(jwks_url)
    return _jwks_client


# ── Coder (optional — upstream workspace feature, unused in local mode) ────────

CODER_API_KEY = os.getenv("CODER_API_KEY")
CODER_URL = os.getenv("CODER_URL")
CODER_TEMPLATE_ID = os.getenv("CODER_TEMPLATE_ID")
CODER_DEFAULT_ORGANIZATION = os.getenv("CODER_DEFAULT_ORGANIZATION")
CODER_WORKSPACE_NAME = os.getenv("CODER_WORKSPACE_NAME", "ubuntu")
