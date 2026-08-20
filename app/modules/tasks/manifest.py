from app.core.module import ModuleManifest

MANIFEST = ModuleManifest(
    id="karajan.tasks",
    title="Tareas",
    icon="ListChecks",
    capabilities=("tasks.read", "tasks.write", "routing.read"),
    publishes=("task_changed",),
    consumes=("config_changed", "layout_changed"),
    routes=(
        "/classify-task",
        "/ingest",
        "/delegate-task",
        "/queue/status",
        "/tasks",
        "/tasks/{task_id}",
        "/tasks/{task_id}/decisions",
        "/tasks/{task_id}/runs",
        "/tasks/{task_id}/artifacts",
        "/tasks/{task_id}/approve-review",
        "/runs/{run_id}/events",
    ),
)
