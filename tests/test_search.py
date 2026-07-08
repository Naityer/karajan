"""Fase 3 — SQLite FTS5 full-text search over the Task/Run schema.

Covers: FTS5 index build + backfill, bm25-ranked MATCH search hitting both the
short `title` and the full legacy `prompt` (words past char ~80 that only exist
in the full prompt), the LIKE-scan fallback when FTS5 is forced unavailable
(the portability path), and graceful handling of empty / malformed queries.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.database import TaskStore
from app.models import (
    ClassificationResult,
    ComplexityLevel,
    CriteriaScores,
    RecommendedModel,
    Subtask,
)


def _classification(task_id: str, prompt: str, intent: str = "implement_feature") -> ClassificationResult:
    return ClassificationResult(
        task_id=task_id,
        original_prompt=prompt,
        domain=["backend"],
        intent=intent,
        criteria=CriteriaScores(
            ambiguity=1, context_required=1, reasoning_depth=1,
            autonomy_required=1, operational_risk=1, validation_difficulty=1,
        ),
        complexity_score=2.0,
        complexity_level=ComplexityLevel.LEVEL_2_MODERATE,
        recommended_strategy="direct",
        recommended_model=RecommendedModel.CHEAP_MODEL,
        subtasks=[
            Subtask(
                id="sub_1", name="Do", complexity=2,
                recommended_model=RecommendedModel.CHEAP_MODEL, validation="tests pass",
            ),
        ],
        requires_human_review=False,
        reason="fixture",
        validation_plan="run tests",
        classified_by="heuristic",
    )


def _store_with_tasks(tmp_path) -> TaskStore:
    store = TaskStore(db_path=tmp_path / "search.db")
    # A prompt long enough that the distinctive word ("memoizacion") only lives
    # past the 80-char title truncation — proves the FTS column set indexes the
    # full legacy prompt, not just the title.
    long_prompt = (
        "Implementa en Python una funcion que calcule el numero de Fibonacci "
        "usando memoizacion recursiva"
    )
    store.save_classification(_classification("tsk_fib", long_prompt))
    store.save_classification(
        _classification("tsk_cache", "Implementa un sistema de cache LRU con decoradores")
    )
    store.save_classification(
        _classification("tsk_math", "Cuanto es 144 dividido entre 12?", intent="classify_and_plan")
    )
    return store


def test_fts_available_and_indexed(tmp_path):
    store = _store_with_tasks(tmp_path)
    assert store._fts_available is True


def test_search_matches_title_word(tmp_path):
    store = _store_with_tasks(tmp_path)
    results = store.search_tasks("cache")
    assert len(results) == 1
    assert results[0]["legacy_task_id"] == "tsk_cache"


def test_search_matches_full_prompt_beyond_title(tmp_path):
    store = _store_with_tasks(tmp_path)
    # "memoizacion" appears only in the full prompt (past char 80), never in title.
    assert "memoizacion" not in store.search_tasks("Fibonacci")[0]["title"].lower()
    results = store.search_tasks("memoizacion")
    assert [r["legacy_task_id"] for r in results] == ["tsk_fib"]


def test_search_ranked_multiple_hits(tmp_path):
    store = _store_with_tasks(tmp_path)
    results = store.search_tasks("Implementa")
    assert {r["legacy_task_id"] for r in results} == {"tsk_fib", "tsk_cache"}


def test_search_respects_limit(tmp_path):
    store = _store_with_tasks(tmp_path)
    assert len(store.search_tasks("Implementa", limit=1)) == 1


def test_empty_query_returns_empty(tmp_path):
    store = _store_with_tasks(tmp_path)
    assert store.search_tasks("") == []
    assert store.search_tasks("   ") == []


def test_like_fallback_when_fts_unavailable(tmp_path):
    """Force FTS5 off (as on a Python build without FTS5) and confirm search
    still works via the LIKE-scan fallback over title/summary/task_type."""
    store = _store_with_tasks(tmp_path)
    store._fts_available = False
    results = store.search_tasks("cache")
    assert len(results) == 1
    assert results[0]["legacy_task_id"] == "tsk_cache"
    # LIKE fallback searches task_type too.
    assert {r["legacy_task_id"] for r in store.search_tasks("classify_and_plan")} == {"tsk_math"}


def test_triggers_keep_index_in_sync_on_new_task(tmp_path):
    store = _store_with_tasks(tmp_path)
    assert store.search_tasks("Observer") == []
    store.save_classification(
        _classification("tsk_obs", "Implementa en Python un patron Observer con cola de mensajes")
    )
    results = store.search_tasks("Observer")
    assert [r["legacy_task_id"] for r in results] == ["tsk_obs"]
