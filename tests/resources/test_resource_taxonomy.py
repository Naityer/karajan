from __future__ import annotations

from app.models import ResourceCreateRequest, ResourceGroupCreateRequest, ResourceItem, ResourceKind
from app.resource_library import ResourceStore
from app.resource_taxonomy import TAXONOMY_NODES, classify_resource, taxonomy_path


def _item(slug: str, *, summary: str = "") -> ResourceItem:
    return ResourceItem(slug=slug, name=slug, kind=ResourceKind.CAPABILITY, source="test", summary=summary)


def test_known_resources_are_grouped_by_job_not_storage_kind() -> None:
    assert classify_resource(_item("backend-builder")).name == "Implementación"
    assert classify_resource(_item("tanstack-charts")).name == "Interfaces y visualización"
    assert classify_resource(_item("skill-creator")).name == "Skills, plugins e integraciones"
    assert classify_resource(_item("promptfoo")).name == "Pruebas y evaluación"
    assert classify_resource(_item("pdf-inspector")).name == "Documentos y ofimática"
    root, leaf = taxonomy_path(_item("impeccable"))
    assert root.name == "Diseño de producto"
    assert leaf.name == "Diseño asistido"


def test_every_taxonomy_leaf_has_a_valid_family() -> None:
    ids = {node.id for node in TAXONOMY_NODES}
    roots = [node for node in TAXONOMY_NODES if node.parent_id is None]
    assert len(roots) == 5
    assert all(node.parent_id in ids for node in TAXONOMY_NODES if node.parent_id)


def test_migration_is_idempotent_and_preserves_custom_assignments(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    first = store.create(ResourceCreateRequest(slug="backend-builder", name="Backend Builder", kind="skill", source="test"))
    second = store.create(ResourceCreateRequest(slug="pdf", name="PDF", kind="skill", source="test"))
    custom = store.create_group(ResourceGroupCreateRequest(name="Favoritos", description="Selección manual"))
    store.assign_groups({first.id: custom.id})

    once = store.apply_resource_taxonomy()
    twice = store.apply_resource_taxonomy()
    assert [(group.id, group.resource_ids) for group in once] == [(group.id, group.resource_ids) for group in twice]
    by_name = {group.name: group for group in twice}
    assert first.id in by_name["Favoritos"].resource_ids
    assert second.id in by_name["Documentos y ofimática"].resource_ids
    assert store.get(second.id).metadata["decision_taxonomy"]["family"] == "Conocimiento y contenidos"

