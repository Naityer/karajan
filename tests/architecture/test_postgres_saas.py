"""Aislamiento multi-tenant del modo SaaS contra un Postgres real.

Nota "Plan de mejora", §14-§15: el modo SaaS solo tiene sentido si un
workspace nunca puede ver los datos de otro, aunque compartan la misma base.
Estos tests lo comprueban contra un Postgres de verdad —no un doble en
memoria— tanto a nivel de repositorio como a través del `TestClient` HTTP real
(autenticación, middleware de workspace y todo).

Se saltan enteros si no hay `KARAJAN_SAAS_DATABASE_URL` apuntando a un
Postgres alcanzable (igual que `test_dashboard_smoke.py` se salta sin
Playwright): no todos los entornos de desarrollo tienen Postgres a mano, y
"no ejecutado" debe ser visible, nunca un verde silencioso.

Para levantar uno local de usar y tirar:

    docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=karajan_test \\
        -p 55432:5432 postgres:15-alpine
    export KARAJAN_SAAS_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/karajan_test
    export KARAJAN_SAAS_JWT_SECRET=test-secret-at-least-32-bytes-long
"""

from __future__ import annotations

import os
import time

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg no está instalado")

DATABASE_URL = os.environ.get("KARAJAN_SAAS_DATABASE_URL")
if not DATABASE_URL:
    pytest.skip("KARAJAN_SAAS_DATABASE_URL no está configurada", allow_module_level=True)

try:
    _probe = psycopg.connect(DATABASE_URL, connect_timeout=2)
    _probe.close()
except Exception as exc:  # noqa: BLE001 - cualquier fallo de conexión → skip, no error
    pytest.skip(f"Postgres no alcanzable en {DATABASE_URL}: {exc}", allow_module_level=True)

os.environ.setdefault("KARAJAN_SAAS_JWT_SECRET", "test-only-secret-at-least-32-bytes-long!!")

from app.models import (  # noqa: E402
    KarajanConfig,
    ResourceCreateRequest,
    ResourceKind,
    RoutingLayout,
)
from app.platform.multitenancy import WorkspaceContext  # noqa: E402
from app.platform.persistence.postgres import (  # noqa: E402
    PostgresConfigRepository,
    PostgresResourceRepository,
    PostgresRoutingRepository,
    PostgresTaskRepository,
    ensure_schema,
    get_pool,
    reset_pool,
)


@pytest.fixture(scope="module", autouse=True)
def _schema():
    pool = get_pool(DATABASE_URL)
    ensure_schema(pool)
    yield
    reset_pool()


@pytest.fixture
def workspaces():
    """Dos workspaces con el mismo `workspace_id` pero tenants distintos — el
    caso que de verdad prueba el aislamiento (una columna sola, `tenant_id` o
    `workspace_id`, no bastaría)."""
    suffix = f"{time.time_ns()}"
    a = WorkspaceContext(f"tenant-a-{suffix}", "ws-shared", "default", "user-a")
    b = WorkspaceContext(f"tenant-b-{suffix}", "ws-shared", "default", "user-b")
    return a, b


@pytest.fixture
def pool():
    return get_pool(DATABASE_URL)


def test_config_repository_is_isolated_per_tenant(pool, workspaces):
    ws_a, ws_b = workspaces
    repo_a = PostgresConfigRepository(pool, ws_a)
    repo_b = PostgresConfigRepository(pool, ws_b)

    from app.models import Backend

    repo_a.save(KarajanConfig(backend=Backend.API))
    assert repo_a.load().backend == Backend.API
    assert repo_b.load().backend != Backend.API  # sigue siendo el default


def test_routing_repository_is_isolated_per_tenant(pool, workspaces):
    ws_a, ws_b = workspaces
    repo_a = PostgresRoutingRepository(pool, ws_a)
    repo_b = PostgresRoutingRepository(pool, ws_b)

    repo_a.save(RoutingLayout(entities=[{"id": "e1", "role": "child"}]))
    assert [e.id for e in repo_a.load().entities] == ["e1"]
    assert repo_b.load().entities == []


def test_task_repository_is_isolated_per_tenant(pool, workspaces):
    from app.models import ClassificationResult, CriteriaScores, Subtask

    ws_a, ws_b = workspaces
    repo_a = PostgresTaskRepository(pool, ws_a)
    repo_b = PostgresTaskRepository(pool, ws_b)

    criteria = CriteriaScores(
        ambiguity=1, context_required=1, reasoning_depth=1,
        autonomy_required=1, operational_risk=1, validation_difficulty=1,
    )
    subtask = Subtask(id="s1", name="x", complexity=1, recommended_model="cheap_model", validation="ok")
    classification = ClassificationResult(
        task_id="tsk_isolation_test", original_prompt="aislamiento", domain=["software"],
        intent="implement_feature", criteria=criteria, complexity_score=1.0,
        complexity_level="level_1_simple", recommended_strategy="direct",
        recommended_model="cheap_model", recommended_skills=[], subtasks=[subtask],
        requires_human_review=False, reason="test", validation_plan="test",
    )
    repo_a.save_classification(classification)

    assert repo_a.get_task("tsk_isolation_test").task_id == "tsk_isolation_test"
    with pytest.raises(KeyError):
        repo_b.get_task("tsk_isolation_test")

    assert len(repo_a.list_tasks()) == 1
    assert len(repo_b.list_tasks()) == 0
    assert repo_a.metrics().total_tasks == 1
    assert repo_b.metrics().total_tasks == 0


def test_resource_repository_is_isolated_per_tenant(pool, workspaces):
    ws_a, ws_b = workspaces
    repo_a = PostgresResourceRepository(pool, ws_a)
    repo_b = PostgresResourceRepository(pool, ws_b)

    created = repo_a.create(
        ResourceCreateRequest(slug="iso-test", name="Iso Test", kind=ResourceKind.SKILL, source="manual")
    )
    assert repo_a.get(created.id).slug == "iso-test"
    with pytest.raises(KeyError):
        repo_b.get(created.id)
    assert len(repo_a.list_resources()) == 1
    assert len(repo_b.list_resources()) == 0


def test_saas_app_enforces_isolation_over_real_http(monkeypatch: pytest.MonkeyPatch):
    """El mismo aislamiento, pero a través del `TestClient` HTTP real: auth,
    middleware de workspace y los routers de `app/modules/*` de por medio —
    no solo llamando al repositorio directamente."""
    import jwt
    from fastapi.testclient import TestClient

    from app.distributions.saas import create_saas_app

    monkeypatch.setenv("KARAJAN_REQUIRE_ATLAS_TOKEN", "0")
    secret = os.environ["KARAJAN_SAAS_JWT_SECRET"]
    suffix = f"{time.time_ns()}"

    def token(tenant: str, workspace: str) -> str:
        return jwt.encode(
            {"sub": "user-1", "tenant": tenant, "workspace": workspace, "iss": "karajan-saas"},
            secret,
            algorithm="HS256",
        )

    client = TestClient(create_saas_app(DATABASE_URL))

    assert client.get("/config").status_code == 401
    assert client.get("/config", headers={"Authorization": "Bearer garbage"}).status_code == 401

    headers_a = {"Authorization": f"Bearer {token(f'tenant-http-a-{suffix}', 'ws-1')}"}
    headers_b = {"Authorization": f"Bearer {token(f'tenant-http-b-{suffix}', 'ws-1')}"}

    created = client.post("/classify-task", json={"prompt": "Aislamiento HTTP end-to-end"}, headers=headers_a)
    assert created.status_code == 200
    task_id = created.json()["task_id"]

    assert client.get(f"/tasks/{task_id}", headers=headers_a).status_code == 200
    assert client.get(f"/tasks/{task_id}", headers=headers_b).status_code == 404
    assert len(client.get("/tasks", headers=headers_b).json()) == 0
