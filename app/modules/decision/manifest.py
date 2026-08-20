from app.core.module import ModuleManifest

MANIFEST = ModuleManifest(
    id="karajan.decision",
    title="Decisión",
    icon="Network",
    capabilities=("routing.read", "routing.write", "agents.read", "skills.read"),
    publishes=("layout_changed",),
    consumes=("config_changed",),
    routes=("/routing-layout",),
)
