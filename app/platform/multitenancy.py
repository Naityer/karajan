"""`WorkspaceContext`: la frontera de aislamiento del modo SaaS.

Nota "Plan de mejora", §14: en standalone y add-on, un `KarajanRuntime` =
una instalación = un directorio de datos — el aislamiento lo da el sistema de
ficheros. En SaaS, un solo proceso sirve muchos workspaces sobre la MISMA base
Postgres, así que el aislamiento tiene que imponerlo cada consulta.

`WorkspaceContext` es deliberadamente más pequeño que `RequestContext`
(`app/platform/auth/identity.py`): los repositorios de
`app/platform/persistence/postgres/` solo necesitan saber DÓNDE viven los
datos (tenant/workspace/project), no CÓMO se autenticó quien pregunta
(permisos, claims del token). Separar los dos evita que el código de
persistencia tenga que importar nada de autenticación.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WorkspaceContext:
    """A qué inquilino/workspace/proyecto pertenecen los datos de esta petición."""

    tenant_id: str
    workspace_id: str
    project_id: str
    actor_id: str

    @classmethod
    def from_request_context(cls, request_context) -> "WorkspaceContext":
        """Construida desde el `RequestContext` que ya produce cualquier
        `IdentityProvider` — así el código de la API no repite el mapeo."""
        return cls(
            tenant_id=request_context.tenant,
            workspace_id=request_context.workspace,
            project_id=request_context.project,
            actor_id=request_context.actor,
        )
