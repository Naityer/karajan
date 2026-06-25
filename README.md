# KARAJAN AI Harness Router

KARAJAN is a local MVP for an AI task-routing harness. It receives a free-form prompt, classifies the work, computes a configurable complexity score, recommends a model strategy, simulates or prepares delegated subtasks, stores the full audit trail in SQLite, and exposes a compact console-style GUI.

The default profile is intentionally local and deterministic: it works with the simulated backend, so no external model provider, no API keys, and no network dependency are required after Python packages are installed. The app also includes provider catalog and configuration screens for later real/local model integrations.

## What It Does

- Classifies prompts by domain, intent, risk, complexity, and validation difficulty.
- Computes the final score in code using fixed weights.
- Maps complexity to levels 1-5 and recommends a model tier.
- Generates bounded subtasks for execution.
- Simulates model execution with deterministic latency and cost estimates.
- Persists every task, decision, subtask, and simulated execution in SQLite.
- Shows tasks, metrics, criteria, subtasks, routing decisions, provider state, and configuration in a dense web console.
- Lets you edit orchestration settings, criterion weights, thresholds, model tiers, cost tables, latency tables, and provider preferences from the GUI.

## Architecture

```text
User prompt
  -> FastAPI /classify-task
  -> classifier + KarajanConfig
  -> Pydantic validation
  -> SQLite audit log + decision log
  -> /delegate-task
  -> delegation backend
  -> dashboard + API metrics + provider/config views
```

Main components:

- `app/main.py`: FastAPI app, static GUI mount, and API/config/provider routes.
- `app/classifier.py`: classification heuristics, score calculation, levels, model policy, skills, and subtasks.
- `app/delegation.py`: delegated execution flow using the active configuration.
- `app/config.py`: default configuration loading for profiles, thresholds, orchestration, cost, and latency.
- `app/catalog.py`: provider catalog for simulated, CLI, and API-backed models.
- `app/credentials.py`: provider readiness and setup guidance.
- `app/monitoring.py`: decision log entries for classification and delegation.
- `app/models.py`: Pydantic contracts for requests, classifications, delegations, records, and metrics.
- `app/database.py`: SQLite persistence and metrics aggregation.
- `dashboard/static`: browser GUI served by FastAPI.
- `skills/karajan/SKILL.md`: operator-facing skill contract used from the model console.
- `skills/task-router/SKILL.md`: prompt/skill contract for future LLM-backed routing.
- `docs/ROLES.md`: role and capability contract for the decision diagram.
- `tests`: unit, persistence, and API tests.

## GUI

The web console is served from FastAPI at `/` and has three main views:

- **Monitor**: submit prompts, choose `Clasificar + Delegar` or `Solo clasificar`, inspect KPIs, task history, criteria, subtasks, recommended skills, and decision logs.
- **Decisión**: build the role diagram, assign models to entities, connect them to the `Agent`, and map levels `N1-N5` to the responsible execution nodes.
- **Configuración**: edit runtime configuration including backend mode, profile, orchestration limits, criterion weights, thresholds, cost table, and latency table.

The decision diagram is persisted to `data/routing_layout.json`, so the local hierarchy, level ownership, selected skills, zoom, and drawer width survive app restarts and can be audited alongside task runs.

Tasks blocked by `requires_human_review` can be approved from Monitor. Approval appends a `validate` decision and moves the task from `delegated` to `completed`.

Monitor also exposes an observability snapshot from `/observability`: system health, node metrics, execution flow, audit timeline, and model usage. Token counters are intentionally `0` until real providers report token usage; cost and latency are derived from delegated executions.

## Role Model

KARAJAN treats `Agent` as the structural authority. It can classify, plan, route, aggregate, recover, and delegate by default. `Worker` and `Backup` can own complexity levels, while `Guardian`, `Validator`, `Memory`, and `Monitor` support the hierarchy without claiming levels.

`Reallocator` is not a visual role. It is an optional advanced capability that can only be active inside an `Agent`; it allows dynamic repair or optimization of roles, task assignments, priorities, and connections. The full role contract is documented in `docs/ROLES.md`.

## Complexity Model

Each criterion is scored from `0` to `5`:

| Criterion | Weight |
| --- | ---: |
| `ambiguity` | 20% |
| `context_required` | 20% |
| `reasoning_depth` | 20% |
| `autonomy_required` | 15% |
| `operational_risk` | 15% |
| `validation_difficulty` | 10% |

Default level mapping:

| Score | Level | Model policy |
| --- | --- | --- |
| `0.0-1.5` | `level_1_simple` | `cheap_model` |
| `1.6-2.5` | `level_2_moderate` | `cheap_or_medium_model` |
| `2.6-3.5` | `level_3_intermediate` | `medium_model` |
| `3.6-4.3` | `level_4_complex` | `strong_model` |
| `4.4-5.0` | `level_5_critical` | `strong_model_with_human_review` |

## Requirements

- Python 3.11 or newer recommended.
- Windows PowerShell examples are shown below.
- Dependencies are declared in `requirements.txt`.

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

## Run As A Local Desktop Window

Use this mode when you want KARAJAN to feel like a local application instead of opening it in a browser tab. It starts the FastAPI backend on a free localhost port and wraps the same GUI in a native desktop window.

From PowerShell:

```powershell
.\.venv\Scripts\python.exe .\desktop_app.py
```

Or double-click:

```text
KARAJAN Desktop.bat
```

This requires `pywebview`, included in `requirements.txt`. On Windows, `pywebview` uses the installed WebView2 runtime.

## Run Routing Trials

Use the trial runner to exercise the `/karajan` skill contract end to end without calling paid or long-running providers. It posts structured parent-router classifications to `/ingest`, delegates them through the harness, and writes an auditable JSON report.

```powershell
.\.venv\Scripts\python.exe .\tools\run_karajan_trials.py --api http://127.0.0.1:8001
```

Reports are written to:

```text
data/trial_reports/
```

For safe local audits, set the backend to `simulated` before running trials and restore the previous config afterward.

## Run The Browser GUI

```powershell
.\.venv\Scripts\uvicorn app.main:app --reload
```

Open:

```text
http://127.0.0.1:8000
```

The GUI lets you submit a prompt, run classification and delegation, inspect KPIs, review the audit log, and drill into criteria and subtasks.

If the default port is already busy, choose another port:

```powershell
.\.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8001
```

## API

### `POST /classify-task`

Request:

```json
{
  "prompt": "Revisa este Jenkinsfile y corrige el HTML report sin romper el pipeline de CI."
}
```

Response: a persisted task record containing the classification result.

### `POST /delegate-task`

Request:

```json
{
  "task_id": "tsk_example"
}
```

Response: the task record updated with simulated subtask executions.

### `GET /health`

Cheap liveness/readiness probe for production monitoring. Returns `status`
(`ok`/`degraded`), app `version`, active `backend` and `profile`, whether token
auth is enabled, a `db_ok` flag, and `total_tasks`. Counts are read with a single
`COUNT(*)`, so it stays cheap to poll.

### `GET /tasks`

Returns task records ordered by creation time, newest first. Supports
pagination for large audit logs:

- `limit` (1-500): maximum records to return.
- `offset` (>= 0): records to skip.

Omitting `limit` returns the full history (backward compatible).

### `GET /tasks/{task_id}`

Returns one task record, including classification and delegation data.

### `GET /metrics`

Returns aggregate GUI metrics:

- total tasks
- tasks by complexity level
- tasks by recommended model
- tasks by backend
- human-review count
- total simulated cost
- average complexity score

### `GET /metrics/prometheus`

The same KPIs as `/metrics`, rendered in the Prometheus text exposition format
(`text/plain; version=0.0.4`) so an external Prometheus/OTel scraper can collect
them. All series are prefixed `karajan_` (e.g. `karajan_tasks_total`,
`karajan_estimated_cost_usd_total`, `karajan_tasks_by_level{level="..."}`). A
`karajan_db_up` gauge reports task-store reachability at scrape time. No extra
dependency is required — the format is emitted directly.

### `GET /tasks/{task_id}/decisions`

Returns the append-only harness decision log for a task.

### `GET /config`

Returns the active `KarajanConfig`.

### `PUT /config`

Updates the active runtime configuration. This affects future
classifications/delegations during the current server process and is persisted
to `data/active_config.json`, so GUI edits survive a restart (the saved override
takes precedence over auto-detection on next startup).

### `GET /catalog`

Returns the static provider catalog.

### `GET /providers`

Detects provider readiness for configured local/API providers.

### `GET /providers/{name}/setup`

Returns setup guidance for one provider.

## Production Controls

These guardrails are evaluated by the harness, not by the operator's good intentions.

### Pre-execution human-review gate

When a task has `requires_human_review` (level 5, or `operational_risk >= 4`) and
`orchestration.require_human_review_gate` is on, delegation is **withheld before any
subtask runs**. The task is parked in `delegated` with zero executions and a
`human_review_gate=blocked` decision. Real backends spend nothing until a human calls
`POST /tasks/{task_id}/approve-review`, which then releases execution and records a
`human_review_gate=approved` decision.

### Cost guardrails

Set in `orchestration` (0 disables each cap):

- `max_cost_per_task_usd`: a hard per-task limit. If the estimated cost (same formula
  as real delegation) exceeds it, execution is withheld with a `cost_gate=blocked`
  decision — even after human approval.
- `max_daily_cost_usd`: blocks `POST /delegate-task` with HTTP `409` when today's
  spend plus the new estimate would exceed the budget, recording a
  `daily_budget=blocked` decision.

### Token auth on mutations

Set `KARAJAN_TOKEN` to require an `X-KARAJAN-Token` header on every state-changing
endpoint (`/classify-task`, `/ingest`, `/delegate-task`, `/approve-review`,
`/tasks/{id}/decisions`, `PUT /config`, `PUT /routing-layout`). Read-only endpoints
stay open for the dashboard. When the variable is unset, auth is disabled so the local
zero-config experience is unchanged.

```powershell
$env:KARAJAN_TOKEN = "choose-a-strong-token"
.\.venv\Scripts\uvicorn app.main:app
```

## Observability & Logging

KARAJAN emits structured (one-JSON-per-line) logs to stderr on the `karajan`
logger, so production deployments can ship them to any log pipeline without
parsing free-form text. Set the level with `KARAJAN_LOG_LEVEL` (default `INFO`).

Logged events include the previously-silent failure modes:

- `llm_classify_fallback` — the LLM classification path failed and the harness
  silently degraded to the heuristic. Emitted at `WARNING` with the backend and
  the underlying error, so the degradation is no longer invisible.
- `cost_gate_blocked` / `human_review_gate_blocked` — a task was withheld before
  execution by the per-task cost cap or the human-review gate.
- `daily_budget_blocked` — delegation was rejected because today's spend plus the
  new estimate would exceed `max_daily_cost_usd`.
- `config_updated`, `health_db_error`.

For in-app monitoring, `/observability` returns a live snapshot (system health,
node metrics, execution flow, audit timeline, model usage) and `/metrics`
returns aggregate KPIs computed in SQL from denormalized columns.

## Data

By default, SQLite data is stored at:

```text
data/task_logs.db
```

The database is created automatically on app startup. Delete this file only if you intentionally want to reset local task history.

SQLite runs in WAL mode (`journal_mode=WAL`, `synchronous=NORMAL`, a 5s
`busy_timeout`) so the dashboard can read while a delegation writes without
serializing behind a single lock. WAL produces transient `data/task_logs.db-wal`
and `-shm` sidecar files; they are ignored by git and safe to delete when the app
is stopped. This covers the concurrency needs of the local desktop/single-host
deployment; a PostgreSQL migration is only warranted for true multi-host,
multi-writer access.

## Tests

```powershell
.\.venv\Scripts\pytest -q
```

Current coverage focuses on:

- weighted complexity calculation
- score-to-level mapping
- model recommendation policy
- classification contract validity
- SQLite persistence
- FastAPI route behavior

## Extending With Real Models

The MVP defaults to a simulated backend so the harness can be validated without credentials or cost. Provider-related screens and endpoints are already present for later integrations.

To add a real provider:

1. Add or update a provider entry in `app/catalog.py`.
2. Add readiness/setup checks in `app/credentials.py`.
3. Extend delegation execution in `app/delegation.py`.
4. Read credentials from environment variables or verified local CLI state.
5. Store backend, model name, latency, cost, output, and errors in the existing delegation models.
6. Add tests using mocked model responses or mocked CLI probes.

The router should still calculate the final complexity score in code, even if an LLM proposes criterion values.

## Future Integrations

Good next steps after the MVP is validated:

- Promptfoo for classifier regression tests.
- DSPy for optimizing routing prompts and scoring examples.
- Dify for visual workflow orchestration.
- LlamaIndex for document/RAG-aware task context.
- PostgreSQL if the audit log needs concurrent multi-host, multi-writer access
  (single-host concurrency is already covered by SQLite WAL).
- Normalized `skills`/`backends` tables: today `/metrics` aggregates scalar KPIs
  in SQL but still does a light JSON pass for the array-derived `by_skill` /
  `by_backend` counts. Worth normalizing only if those break-downs become a hot
  path at scale.
- Dynamic role reallocation: `Reallocator` is currently a planning/diagram
  concept and an `Agent`-only capability label — there is no runtime engine that
  reassigns roles or tasks. Implement one only when a concrete failover/rebalance
  workflow needs it; until then it stays documented but inert by design.

## Notes

- The GUI is a functional tool surface, not a landing page.
- The attached ZIP prototype was used as visual reference only.
- No external LLM calls are required in the default simulated mode.
- Human review is required for critical tasks or high operational risk.
