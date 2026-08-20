-- Esquema Postgres para el modo SaaS (nota "Plan de mejora", §14-§15).
--
-- Cada tabla lleva tenant_id/workspace_id/project_id: un solo proceso sirve
-- muchos workspaces sobre la MISMA base, así que el aislamiento no lo da un
-- fichero SQLite separado (como en standalone/add-on) sino estas columnas —
-- toda consulta del adaptador filtra por las tres. Alcance de esta primera
-- pasada: TaskRepository, RoutingRepository, ConfigRepository completos;
-- ResourceRepository cubre el CRUD principal (ver postgres/resources.py).
--
-- `level`/`model`/`score`/`requires_review`/`subtask_count`/`est_cost` son
-- columnas desnormalizadas para agregación rápida en `metrics()` — el mismo
-- patrón que ya usa `app/database.py` (TaskStore, SQLite), cuyo propio
-- comentario ya señalaba esta migración: "full normalization of those is
-- deferred to the PostgreSQL migration (P2)". `classification_json`/
-- `delegation_json` guardan el `TaskRecord` completo (JSONB) como fuente de
-- verdad; las columnas denormalizadas son una proyección, no otro dato.

CREATE TABLE IF NOT EXISTS tasks (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    classification_json JSONB NOT NULL,
    delegation_json JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    level TEXT,
    model TEXT,
    score DOUBLE PRECISION,
    requires_review BOOLEAN NOT NULL DEFAULT FALSE,
    subtask_count INTEGER NOT NULL DEFAULT 0,
    est_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_created ON tasks (tenant_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_status ON tasks (tenant_id, workspace_id, status);
-- Búsqueda de texto completo sobre el prompt (equivalente Postgres a la FTS5
-- de SQLite): un índice GIN sobre un `tsvector` generado, no una tabla aparte.
CREATE INDEX IF NOT EXISTS idx_tasks_prompt_fts
    ON tasks USING GIN (to_tsvector('simple', prompt));

CREATE TABLE IF NOT EXISTS decisions (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    decision TEXT NOT NULL,
    score DOUBLE PRECISION,
    backend TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_decisions_ws_task ON decisions (tenant_id, workspace_id, task_id);

CREATE TABLE IF NOT EXISTS runs (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_index INTEGER NOT NULL,
    provider_name TEXT,
    routing_entity_id TEXT,
    routing_entity_name_snapshot TEXT,
    model_id TEXT,
    backend TEXT,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    estimated_cost_usd DOUBLE PRECISION,
    error TEXT,
    PRIMARY KEY (tenant_id, workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_runs_ws_task ON runs (tenant_id, workspace_id, task_id);
CREATE INDEX IF NOT EXISTS idx_runs_ws_provider ON runs (tenant_id, workspace_id, provider_name);

CREATE TABLE IF NOT EXISTS run_events (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    payload_json JSONB,
    PRIMARY KEY (tenant_id, workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_run_events_ws_run ON run_events (tenant_id, workspace_id, run_id);

CREATE TABLE IF NOT EXISTS artifacts (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,
    size_bytes BIGINT,
    content_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_ws_task ON artifacts (tenant_id, workspace_id, task_id);

CREATE TABLE IF NOT EXISTS metrics_history (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    total_tasks INTEGER NOT NULL,
    total_estimated_cost_usd DOUBLE PRECISION NOT NULL,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    avg_latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_history_ws_ts ON metrics_history (tenant_id, workspace_id, "timestamp");

CREATE TABLE IF NOT EXISTS routing_layout (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    layout_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS active_config (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    config_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS resources (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    item_json JSONB NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    repo_url TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_resources_ws_slug ON resources (tenant_id, workspace_id, slug);
CREATE INDEX IF NOT EXISTS idx_resources_ws_repo_url ON resources (tenant_id, workspace_id, repo_url);
CREATE INDEX IF NOT EXISTS idx_resources_search_fts
    ON resources USING GIN (to_tsvector('simple', item_json ->> 'name' || ' ' || COALESCE(item_json ->> 'summary', '')));

CREATE TABLE IF NOT EXISTS resource_preferences (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    preference_key TEXT NOT NULL,
    value_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, workspace_id, preference_key)
);
