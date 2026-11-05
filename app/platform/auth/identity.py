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

from app.security import atlas_auth
from app.security import auth

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
        return RequestContext(
            actor="local",
            permissions=frozenset(
                {
                    "karajan:routing:override",
                    "karajan:review:approve",
                    "karajan:config:write",
                }
            ),
        )


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
            return LocalIdentityProvider().authenticate(karajan_token=karajan_token)
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
