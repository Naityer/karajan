"""Identidad: un solo puerto para los tres modos de ejecución.

Karajan ya tenía los dos mecanismos que hacen falta, pero sueltos y acoplados a
FastAPI (nota "Plan de mejora", §22):

- `app/auth.py` — secreto compartido `X-KARAJAN-Token`, el modo standalone.
- `app/atlas_auth.py` — JWT RS256 de capacidad firmado por Atlas, el modo
  add-on.

Aquí se convierten en implementaciones de `IdentityProvider`, y ambas producen
el mismo `RequestContext`. Así el código de los módulos deja de preguntar
"¿quién me está llamando y por qué vía?" y pasa a leer un contexto —actor,
tenant, workspace, proyecto, permisos— que en standalone está relleno con
valores locales y en SaaS vendrá del token del usuario.

Ninguna de las dos implementaciones cambia la política vigente: sin
`KARAJAN_TOKEN` y sin `KARAJAN_REQUIRE_ATLAS_TOKEN` la verificación sigue
desactivada, que es lo que hace que arrancar Karajan en local no pida nada.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Protocol

import jwt
from fastapi import HTTPException

from app import atlas_auth, auth

#: Identificadores del único inquilino que existe fuera de SaaS. Explícitos, en
#: vez de `None`, para que el día que haya varios el código que ya los propaga
#: no tenga que distinguir "sin tenant" de "tenant local".
LOCAL_TENANT = "local"
LOCAL_WORKSPACE = "default"
LOCAL_PROJECT = "default"


@dataclass(frozen=True)
class RequestContext:
    """Quién hace la petición y sobre qué datos puede operar."""

    actor: str
    tenant: str = LOCAL_TENANT
    workspace: str = LOCAL_WORKSPACE
    project: str = LOCAL_PROJECT
    permissions: frozenset[str] = field(default_factory=frozenset)
    #: Payload original del token, cuando lo hay (útil para auditoría).
    claims: dict[str, Any] | None = None

    def can(self, permission: str) -> bool:
        """Sin permisos declarados no se restringe nada: es el caso local."""
        return not self.permissions or permission in self.permissions


class IdentityProvider(Protocol):
    """Traduce las cabeceras de una petición a un `RequestContext`.

    Lanza `HTTPException` si la credencial es exigible y no es válida — la
    misma semántica que ya tienen `require_token` y `require_atlas_token`.
    """

    def authenticate(
        self,
        *,
        karajan_token: str | None = None,
        authorization: str | None = None,
    ) -> RequestContext: ...


class LocalIdentityProvider:
    """Standalone: un solo operador, con el secreto compartido opcional."""

    def authenticate(
        self,
        *,
        karajan_token: str | None = None,
        authorization: str | None = None,
    ) -> RequestContext:
        auth.require_token(karajan_token)
        return RequestContext(actor="local")


class AtlasCapabilityIdentityProvider:
    """Add-on: el token de capacidad RS256 que acuña Atlas.

    Los `scopes` del token son los permisos: es Atlas quien decide qué puede
    hacer esta instalación según la suscripción, y aquí solo se transportan.
    """

    def authenticate(
        self,
        *,
        karajan_token: str | None = None,
        authorization: str | None = None,
    ) -> RequestContext:
        auth.require_token(karajan_token)
        claims = atlas_auth.require_atlas_token(authorization)
        if claims is None:  # verificación desactivada → se comporta como local
            return RequestContext(actor="local")
        scopes = claims.get("scopes") or claims.get("scope") or []
        if isinstance(scopes, str):
            scopes = scopes.split()
        return RequestContext(
            actor=str(claims.get("sub") or "atlas"),
            tenant=str(claims.get("tenant") or LOCAL_TENANT),
            workspace=str(claims.get("workspace") or LOCAL_WORKSPACE),
            project=str(claims.get("project") or LOCAL_PROJECT),
            permissions=frozenset(str(scope) for scope in scopes),
            claims=claims,
        )


SAAS_JWT_SECRET_ENV_VAR = "KARAJAN_SAAS_JWT_SECRET"


class SaaSIdentityProvider:
    """Multi-tenant: JWT HS256 firmado por el propio backend SaaS.

    A diferencia de `LocalIdentityProvider`/`AtlasCapabilityIdentityProvider`
    (verificación opt-in — sin configurar, se comportan como local, que es lo
    que permite arrancar Karajan suelto sin fricción), este falla CERRADO: sin
    `KARAJAN_SAAS_JWT_SECRET` configurado, o sin un token válido con `tenant`/
    `workspace`/`sub`, ninguna petición pasa. Un SaaS multi-tenant sin
    autenticación por defecto no es "conveniente", es una fuga de datos entre
    inquilinos — el riesgo que `LocalIdentityProvider` no tiene (un solo
    operador) está presente en TODA petición aquí.
    """

    def __init__(self, secret: str | None = None) -> None:
        self._secret = secret

    def _resolve_secret(self) -> str:
        secret = self._secret or os.environ.get(SAAS_JWT_SECRET_ENV_VAR)
        if not secret:
            raise HTTPException(
                status_code=503,
                detail=f"SaaS mal configurado: falta {SAAS_JWT_SECRET_ENV_VAR}",
            )
        return secret

    def authenticate(
        self,
        *,
        karajan_token: str | None = None,
        authorization: str | None = None,
    ) -> RequestContext:
        secret = self._resolve_secret()
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="falta el token de sesión (Authorization: Bearer ...)")
        token = authorization.removeprefix("Bearer ")
        try:
            claims = jwt.decode(token, secret, algorithms=["HS256"], issuer="karajan-saas")
        except jwt.PyJWTError as exc:
            raise HTTPException(status_code=401, detail=f"token de sesión inválido: {exc}") from exc

        missing = [key for key in ("sub", "tenant", "workspace") if not claims.get(key)]
        if missing:
            raise HTTPException(status_code=401, detail=f"token de sesión incompleto: faltan {missing}")

        scopes = claims.get("scopes") or claims.get("scope") or []
        if isinstance(scopes, str):
            scopes = scopes.split()
        return RequestContext(
            actor=str(claims["sub"]),
            tenant=str(claims["tenant"]),
            workspace=str(claims["workspace"]),
            project=str(claims.get("project") or LOCAL_PROJECT),
            permissions=frozenset(str(scope) for scope in scopes),
            claims=claims,
        )
