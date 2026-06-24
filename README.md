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
- `skills/task-router/SKILL.md`: prompt/skill contract for future LLM-backed routing.
- `tests`: unit, persistence, and API tests.

## GUI

The web console is served from FastAPI at `/` and has four main views:

- **Monitor**: submit prompts, choose `Clasificar + Delegar` or `Solo clasificar`, inspect KPIs, task history, criteria, subtasks, recommended skills, and decision logs.
- **Decisión**: visualize the parent router and level-to-model delegation map; edit provider preferences per model tier.
- **Modelos**: inspect available simulated, local CLI, and cloud/API providers; view setup instructions and readiness state.
- **Flujo**: edit runtime configuration including backend mode, profile, orchestration limits, criterion weights, thresholds, cost table, and latency table.

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

## Run The GUI

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

### `GET /tasks`

Returns all task records ordered by creation time, newest first.

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

### `GET /tasks/{task_id}/decisions`

Returns the append-only harness decision log for a task.

### `GET /config`

Returns the active `KarajanConfig`.

### `PUT /config`

Updates the active runtime configuration. This affects future classifications/delegations during the current server process.

### `GET /catalog`

Returns the static provider catalog.

### `GET /providers`

Detects provider readiness for configured local/API providers.

### `GET /providers/{name}/setup`

Returns setup guidance for one provider.

## Data

By default, SQLite data is stored at:

```text
data/task_logs.db
```

The database is created automatically on app startup. Delete this file only if you intentionally want to reset local task history.

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
- PostgreSQL if the audit log needs concurrent multi-user access.

## Notes

- The GUI is a functional tool surface, not a landing page.
- The attached ZIP prototype was used as visual reference only.
- No external LLM calls are required in the default simulated mode.
- Human review is required for critical tasks or high operational risk.
