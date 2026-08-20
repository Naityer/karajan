from app.core.module import ModuleManifest

MANIFEST = ModuleManifest(
    id="karajan.configuration",
    title="Configuración",
    icon="Settings",
    capabilities=("config.read", "config.write"),
    publishes=("config_changed",),
    consumes=(),
    routes=(
        "/config",
        "/setup/apply-default",
        "/setup/apply-queue-config",
        "/setup/status",
        "/setup/complete",
        "/setup/tutorial",
    ),
)
