from app.domain.models import ResourceItem, ResourceKind
from app.resources.skills_catalog import list_skills
from app.resources.resource_library import ResourceStore, seed_resource_library
from app.resources.resource_installer import SkillRepositoryManager
from app.resources.skill_matching import AvailableSkill, select_skills
from app.resources.resource_taxonomy import classify_resource
from app.resources.resource_intelligence import ResourceRankingEngine


def test_modern_web_catalog_and_context():
    entries = [s for s in list_skills() if s.name == "modern-web-guidance"]
    assert len(entries) == 1
    assert entries[0].repo_url == "https://github.com/GoogleChrome/modern-web-guidance"
    catalog = [AvailableSkill(entries[0].name, entries[0].description, frozenset(), frozenset())]
    assert select_skills("Revisar modernización web y compatibilidad web", catalog) == [entries[0].name]
    assert select_skills("Auditar dependencias de una API Python", catalog) == []
    assert classify_resource(ResourceItem(slug=entries[0].name, name=entries[0].name, kind=ResourceKind.SKILL, source="test")).id == "rgrp_dev_interfaces"


def test_seed_preserves_state_and_installs_only_selected_skill(tmp_path):
    store = ResourceStore(tmp_path / "resources.db")
    seed_resource_library(store, tmp_path / "absent")
    item = store.get_by_slug("modern-web-guidance", ResourceKind.SKILL)
    store.set_visibility(item.id, ["private-agent"])
    seed_resource_library(store, tmp_path / "absent")
    item = store.get_by_slug(item.slug, ResourceKind.SKILL)
    assert item.visible_agent_ids == ["private-agent"]
    assert "browser-compatibility" in item.capabilities
    assert len([r for r in store.list_all_resources() if r.slug == item.slug]) == 1
    root = tmp_path / "repo"
    for name in ("modern-web-guidance", "other"):
        folder = root / "skills" / name
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(f"---\nname: {name}\n---\n", encoding="utf-8")
    target = tmp_path / "agents"
    result = SkillRepositoryManager(store, target_roots={"codex": target}).install_from_directory(item, root, targets=["codex"])
    assert result.status == "succeeded"
    assert (target / item.slug / "SKILL.md").is_file()
    assert not (target / "other").exists()


def test_library_recommends_web_specialist_only_for_web(tmp_path):
    store = ResourceStore(tmp_path / "resources.db")
    seed_resource_library(store, tmp_path / "absent")
    engine = ResourceRankingEngine()
    resources = store.list_all_resources()
    result = engine.recommend("Revisar modernización web y compatibilidad web", resources, limit=3)
    assert result.recommendations[0].resource.slug == "modern-web-guidance"
    backend = engine.recommend("Auditar dependencias y secretos de un backend Python", resources, limit=3)
    assert "modern-web-guidance" not in {r.resource.slug for r in backend.recommendations}
