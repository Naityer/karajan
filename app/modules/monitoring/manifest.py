from app.core.module import ModuleManifest, UIObjectDescriptor

MANIFEST = ModuleManifest(
    id="karajan.monitoring",
    title="Estadísticas",
    icon="Activity",
    capabilities=("tasks.read",),
    publishes=(),
    consumes=("task_changed",),
    routes=(
        "/metrics",
        "/metrics/prometheus",
        "/agents/performance",
        "/analytics/skills",
        "/analytics/dashboard",
        "/search/tasks",
        "/observability",
        "/observability/history",
        "/analytics/predictions/status",
        "/predict/task",
    ),
    objects=(
        UIObjectDescriptor(
            id="karajan.agent-performance",
            type="widget",
            title="Rendimiento por agente",
            description="Tabla de coste, latencia y errores por agente, agregada sobre GET /agents/performance.",
            capabilities=("tasks.read",),
        ),
        UIObjectDescriptor(
            id="karajan.task-metrics",
            type="widget",
            title="Métricas de tareas",
            description="KPIs de volumen, complejidad y coste agregados, sobre GET /metrics.",
            capabilities=("tasks.read",),
        ),
    ),
)
