"""API del módulo Decisión.

Sale de `app/main.py` sin cambiar de comportamiento: mismas rutas, mismos
modelos de respuesta y las mismas dos guardas de autenticación. Lo único que
cambia es de dónde saca el almacén — del runtime activo en vez de un global del
módulo `main`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app import catalog, events, routing_rules, runtime as runtime_module
from app.atlas_auth import require_atlas_token
from app.auth import require_token
from app.models import ComplexityLevel, RecommendedModel, RoutingEntity, RoutingLayout, RoutingProfile

router = APIRouter(tags=["decision"])

# Un tier de RecommendedModel (orden: cheap..strong_with_review) corresponde
# posicionalmente al mismo índice de ComplexityLevel (N1..N5) — mismo orden,
# mismo significado ("cuánto delega este proveedor"), solo que uno describe
# capacidad de modelo y el otro complejidad de tarea.
_TIER_TO_LEVEL = dict(zip(RecommendedModel, ComplexityLevel, strict=True))


def _catalog_entity_id(provider_name: str) -> str:
    return f"entity-provider-{provider_name}"


@router.get("/routing-layout", response_model=RoutingLayout)
def get_routing_layout() -> RoutingLayout:
    return runtime_module.current().routing.load()


@router.put("/routing-layout", response_model=RoutingLayout)
def update_routing_layout(
    layout: RoutingLayout,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> RoutingLayout:
    saved = runtime_module.current().routing.save(layout)
    events.publish("layout_changed")
    return saved


@router.post("/routing-layout/presets/nivel", response_model=RoutingLayout)
def apply_level_preset(
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> RoutingLayout:
    """Adds (or rebuilds) the «Local · Codex · Claude (por nivel)» profile and makes it the default one."""
    store = runtime_module.current().routing
    layout = store.load()
    preset = RoutingProfile.model_validate(routing_rules.level_preset_profile())
    profiles = [p for p in layout.profiles if p.id != preset.id] + [preset]
    saved = store.save(layout.model_copy(update={"profiles": profiles, "active_profile_id": preset.id, "default_profile_id": preset.id}))
    events.publish("layout_changed")
    return saved


@router.post("/routing-layout/catalog/{provider_name}", response_model=RoutingLayout)
def add_catalog_provider_to_routing_layout(
    provider_name: str,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> RoutingLayout:
    """Añade un proveedor del catálogo estático como entidad de enrutado.

    Es la contraparte de "marcar un proveedor" en el panel Agentes
    (`setCatalogProviderInDecision` en `dashboard/static/src/modules/flow.js`):
    a diferencia de añadir una entidad a mano en el diagrama (id aleatorio,
    `addEntityFromProvider` en el frontend), esta usa un id determinista
    (`entity-provider-<nombre>`) para poder ser idempotente — pedirlo dos
    veces dejar exactamente una entidad, no dos.
    """
    provider = catalog.get_provider(provider_name)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"proveedor de catálogo desconocido: {provider_name}")

    layout = runtime_module.current().routing.load()
    entity_id = _catalog_entity_id(provider_name)
    if any(entity.id == entity_id for entity in layout.entities):
        return layout  # ya está — idempotente, no duplica

    entity = RoutingEntity(
        id=entity_id,
        name=provider.label,
        role="child",
        role_tags=["worker", f"l{RoutingEntity.model_fields['tier'].default}"],
        provider=provider_name,
        levels=[_TIER_TO_LEVEL[tier].value for tier in provider.tiers],
    )
    layout.entities.append(entity)
    saved = runtime_module.current().routing.save(layout)
    events.publish("layout_changed")
    return saved


@router.delete("/routing-layout/catalog/{provider_name}", response_model=RoutingLayout)
def remove_catalog_provider_from_routing_layout(
    provider_name: str,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> RoutingLayout:
    layout = runtime_module.current().routing.load()
    remaining = [entity for entity in layout.entities if entity.provider != provider_name]
    if len(remaining) == len(layout.entities):
        return layout  # no había ninguna — idempotente
    layout.entities = remaining
    saved = runtime_module.current().routing.save(layout)
    events.publish("layout_changed")
    return saved
