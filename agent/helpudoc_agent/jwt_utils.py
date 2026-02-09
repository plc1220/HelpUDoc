"""Minimal HS256 JWT helpers (no external deps).

Used for backend -> agent context propagation (e.g., mcp_policy).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_and_verify_hs256_jwt(token: str, secret: str) -> Optional[Dict[str, Any]]:
    """Return payload dict if valid, else None."""
    if not token or not secret:
        return None
    parts = token.split(".")
    if len(parts) != 3:
        return None
    header_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64).decode("utf-8"))
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except Exception:
        return None

    if not isinstance(header, dict) or header.get("alg") != "HS256":
        return None
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    expected_b64 = _b64url_encode(expected)
    if not hmac.compare_digest(expected_b64, sig_b64):
        return None

    exp = payload.get("exp")
    if exp is not None:
        try:
            if float(exp) < time.time():
                return None
        except Exception:
            return None

    return payload if isinstance(payload, dict) else None

