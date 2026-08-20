from app.core.module import ModuleManifest

MANIFEST = ModuleManifest(
    id="karajan.inspiration",
    title="Inspiration",
    icon="Sparkles",
    capabilities=("resources.read", "resources.write"),
    publishes=("resource_changed",),
    consumes=(),
    routes=(
        "/resources",
        "/resources/{resource_id}",
        "/resources/index",
        "/resources/analyze",
        "/resources/recommend",
        "/resources/{resource_id}/reindex",
        "/resources/{resource_id}/reanalyze",
        "/resources/{resource_id}/visibility",
        "/resources/{resource_id}/operations",
        "/resource-groups",
        "/resource-groups/{group_id}",
        "/resource-groups/assignments",
        "/resources/discovery/sources",
        "/resources/discovery/feed",
        "/resources/refresh/settings",
        "/resources/refresh/run",
        "/resources/refresh/runs/{run_id}",
    ),
)
