"""Manifiesto de módulo: lo que un host necesita saber sin leer el código.

La nota "Plan de mejora" (§10 y §24) pide que cada módulo declare qué es, qué
capacidades necesita y qué eventos publica y consume, para que Atlas —o
cualquier otro host— pueda componer una interfaz con sus piezas sin conocer la
implementación de Karajan.

Este es el lado backend de ese contrato. El lado frontend (vistas y objetos UI)
lo declara cada módulo del dashboard y ambos se funden en el manifiesto global
que sirve `GET /manifest`.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class UIObjectDescriptor:
    """Metadatos de un objeto UI de grano fino (nota "Plan de mejora", §8/§23).

    Espejo *de datos* (sin la función `mount`, que solo existe en el lado
    JS — ver `KarajanRegistry` en `dashboard/static/src/core/registry.js`)
    de lo que el host necesita para decidir si puede montar el objeto y con
    qué scope, sin tener que cargar el bundle del dashboard para averiguarlo.
    """

    #: Identificador estable en el registry JS (`karajan.agent-performance`).
    id: str
    #: `"view" | "panel" | "widget" | "action"` — mismo vocabulario que el registry JS.
    type: str
    title: str
    description: str = ""
    #: Permisos que el objeto necesita para tener datos que mostrar.
    capabilities: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "type": self.type,
            "title": self.title,
            "description": self.description,
            "capabilities": list(self.capabilities),
        }


@dataclass(frozen=True)
class ModuleManifest:
    """Declaración de un módulo de Karajan."""

    #: Identificador estable, con el que el host lo referencia (`karajan.decision`).
    id: str
    #: Nombre visible, en el idioma de la interfaz.
    title: str
    #: Icono sugerido (nombre de lucide-react, el juego que usa Atlas).
    icon: str
    #: Permisos que el módulo necesita para operar (`routing.read`, `tasks.write`…).
    capabilities: tuple[str, ...] = ()
    #: Eventos de dominio que publica.
    publishes: tuple[str, ...] = ()
    #: Eventos de dominio a los que reacciona.
    consumes: tuple[str, ...] = ()
    #: Prefijos de ruta que sirve, para documentar la superficie del módulo.
    routes: tuple[str, ...] = ()
    #: Objetos UI de grano fino que este módulo expone (ver `UIObjectDescriptor`).
    objects: tuple[UIObjectDescriptor, ...] = ()
    version: int = 1
    extra: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "icon": self.icon,
            "capabilities": list(self.capabilities),
            "events": {"publishes": list(self.publishes), "consumes": list(self.consumes)},
            "routes": list(self.routes),
            "objects": [obj.to_dict() for obj in self.objects],
            **self.extra,
        }
