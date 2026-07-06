"""app/production_setup.py: the additive, idempotent hierarchy-merge helper
used by POST /setup/apply-queue-config."""

from app.models import RoutingEntity, RoutingLayout
from app.production_setup import ensure_queue_hierarchy_entities


def test_merge_adds_missing_baseline_entities() -> None:
    live = RoutingLayout(
        entities=[
            RoutingEntity(id="entity-agent-claude", role="parent", role_tags=["parent"], provider="claude-cli", tier=0),
            RoutingEntity(id="entity-backup-codex", role="backup", role_tags=["backup"], provider="codex", tier=0),
        ]
    )

    merged, added = ensure_queue_hierarchy_entities(live)

    assert len(merged.entities) > len(live.entities)
    assert set(added) == {entity.id for entity in merged.entities} - {"entity-agent-claude", "entity-backup-codex"}
    assert "entity-worker-glm" in added
    assert "entity-worker-kimi" in added
    assert "entity-worker-ornith" in added
    assert "entity-validator-cheap" in added


def test_merge_never_touches_existing_customizations() -> None:
    custom = RoutingEntity(
        id="entity-worker-qwen",
        name="Qwen (personalizado)",
        role="child",
        role_tags=["child", "monitor"],
        provider="ollama-qwen",
        tier=2,
        max_concurrent=5,
        levels=["level_1_simple"],
    )
    live = RoutingLayout(entities=[custom])

    merged, _ = ensure_queue_hierarchy_entities(live)

    kept = next(e for e in merged.entities if e.id == "entity-worker-qwen")
    assert kept.name == "Qwen (personalizado)"
    assert kept.max_concurrent == 5
    assert "monitor" in kept.role_tags
    assert kept.levels == ["level_1_simple"]


def test_merge_is_idempotent() -> None:
    live = RoutingLayout(entities=[])
    merged_once, added_once = ensure_queue_hierarchy_entities(live)
    merged_twice, added_twice = ensure_queue_hierarchy_entities(merged_once)

    assert added_once  # baseline hierarchy had entities to add
    assert added_twice == []
    assert len(merged_twice.entities) == len(merged_once.entities)
