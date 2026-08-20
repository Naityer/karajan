from app.core.module import ModuleManifest

MANIFEST = ModuleManifest(
    id="karajan.shared",
    title="Infraestructura",
    icon="Radio",
    capabilities=("tasks.read",),
    publishes=(),
    consumes=(),
    routes=(
        "/health",
        "/events",
        "/manifest",
        "/atlas-addon.json",
        "/handoff/packs",
        "/handoff/packs/{pack_id}",
        "/handoff/packs/{pack_id}/result",
    ),
    extra={"internal": True},
)
