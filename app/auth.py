from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException

TOKEN_ENV_VAR = "KARAJAN_TOKEN"


def require_token(x_karajan_token: str | None = Header(default=None)) -> None:
    """Guard state-changing endpoints with a shared token.

    Auth is *disabled* when `KARAJAN_TOKEN` is unset, preserving the zero-config
    local experience. Set the env var to require an `X-KARAJAN-Token` header on
    every mutation (config changes, ingestion, delegation, approvals).
    """
    expected = os.environ.get(TOKEN_ENV_VAR, "")
    if not expected:
        return
    if not x_karajan_token or not hmac.compare_digest(x_karajan_token, expected):
        raise HTTPException(status_code=401, detail="invalid or missing X-KARAJAN-Token")
