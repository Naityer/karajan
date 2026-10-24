"""Verificación del token de capacidad RS256 que Atlas manda en cada
invocación (`Authorization: Bearer ...`).

Antes de esto, este backend RECIBÍA el token y lo ignoraba por completo: no
había ningún código que leyera la cabecera `Authorization` ni verificara un
JWT, pese a que Atlas ya lo mandaba (ver `docs` de Atlas, nota "Seguridad",
sección "Tokens de capacidad"). `require_token` (`app/auth.py`) es un
mecanismo distinto y anterior — un secreto estático compartido
(`X-KARAJAN-Token`), no el JWT firmado por Atlas.

Verifica contra la clave PÚBLICA que Atlas publica en
`/.well-known/jwks.json` (RS256): sin ronda de red por petición gracias al
caché de `PyJWKClient`, y sin que este proceso necesite conocer ningún
secreto — solo la clave pública puede verificar, nunca firmar.

Opt-in vía `KARAJAN_REQUIRE_ATLAS_TOKEN=1`, mismo criterio de "zero-config
local" que ya usa `require_token`: sin la variable, no se exige nada, para
no romper a quien arranca Karajan suelto durante desarrollo (sin Atlas
delante, no hay token que mandar).
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

import jwt
from fastapi import Header, HTTPException

ENV_VAR = "KARAJAN_REQUIRE_ATLAS_TOKEN"
JWKS_URL_ENV = "ATLAS_JWKS_URL"
DEFAULT_JWKS_URL = "http://localhost:3000/api/.well-known/jwks.json"
ADDON_ID = "karajan"


@lru_cache(maxsize=1)
def _jwks_client() -> "jwt.PyJWKClient":
    url = os.environ.get(JWKS_URL_ENV, DEFAULT_JWKS_URL)
    return jwt.PyJWKClient(url, cache_keys=True)


def require_atlas_token(authorization: str | None = Header(default=None)) -> dict[str, Any] | None:
    """`None` si la verificación está desactivada (por defecto). Si está
    activada, verifica firma, emisor (`atlas`) y audiencia (`karajan`) y
    devuelve el payload — o lanza 401."""
    if os.environ.get(ENV_VAR, "") not in ("1", "true", "True"):
        return None
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Falta el token de capacidad de Atlas.")
    token = authorization.removeprefix("Bearer ")
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token, signing_key.key, algorithms=["RS256"], issuer="atlas", audience=ADDON_ID,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"Token de capacidad inválido: {exc}") from exc
    return payload
