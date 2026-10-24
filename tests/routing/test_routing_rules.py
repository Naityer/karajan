"""Domain rules of a routing profile: areas, rule matching, preset, persistence and dispatch."""

import json

from app import delegation, routing_rules
from app.delegation import delegate
from app.models import Backend, KarajanConfig, RoutingLayout, RoutingRule
from app.providers.registry import Resolution
from app.router import classify_prompt
from app.routing_layout import RoutingLayoutStore
from tests.conftest import StubProvider


def _layout_with_preset() -> RoutingLayout:
    profile = routing_rules.domain_preset_profile()
    return RoutingLayout.model_validate(
        {"profiles": [profile], "active_profile_id": profile["id"], "default_profile_id": profile["id"]}
    ).project_default_profile()


def test_detect_areas_splits_interfaces_backend_and_office() -> None:
    assert routing_rules.detect_areas("Diseña la interfaz del dashboard con componentes React") == ["frontend"]
    assert routing_rules.detect_areas("Crea un endpoint de la API y migra la base de datos") == ["backend"]
    assert routing_rules.detect_areas("Prepara el informe mensual en Excel") == ["oficina"]
    assert routing_rules.detect_areas("hola") == []


def test_rules_are_evaluated_in_order_and_skip_disabled_or_dangling() -> None:
    layout = _layout_with_preset()
    complex_ui = routing_rules.match_for_layout(layout, domains=["product"], intent="implement_feature", level=4,
                                                prompt="Rediseña la interfaz del panel con componentes nuevos")
    assert complex_ui is not None and complex_ui.entity.provider == "claude-cli"
    simple = routing_rules.match_for_layout(layout, domains=["general"], intent="classify_and_plan", level=1, prompt="Renombra una variable")
    assert simple is not None and simple.entity.provider == "ollama-qwen"
    backend = routing_rules.match_for_layout(layout, domains=["programming"], intent="implement_feature", level=3, prompt="Añade un endpoint REST")
    assert backend is not None and backend.rule.id == "backend-oficina" and backend.entity.provider == "codex"
    # a trivial UI tweak goes local, anything from moderate up goes to Claude; backend beats "simple"
    simple_ui = routing_rules.match_for_layout(layout, domains=["product"], intent="implement_feature", level=1, prompt="Cambia el color de un botón de la interfaz")
    assert simple_ui is not None and simple_ui.entity.provider == "ollama-qwen"
    simple_backend = routing_rules.match_for_layout(layout, domains=["programming"], intent="implement_feature", level=1, prompt="Añade un campo al endpoint")
    assert simple_backend is not None and simple_backend.entity.provider == "codex"
    assert routing_rules.rule_level("level_2_moderate", 1) == 2 and routing_rules.rule_level("level_1_simple", 3) == 3

    rules = [RoutingRule(id="off", entity_id="dominio-claude", enabled=False), RoutingRule(id="ghost", entity_id="missing")]
    assert routing_rules.match_rule(rules, layout.entities, domains=[], intent="x", level=3) is None


def test_old_files_without_rules_still_load_and_rules_survive_canvas_only_saves(tmp_path) -> None:
    store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    legacy = {"entities": [{"id": "a", "role": "worker", "provider": "codex"}]}
    (tmp_path / "routing_layout.json").write_text(json.dumps(legacy), encoding="utf-8")
    assert store.load().rules == []

    profile = routing_rules.domain_preset_profile()
    store.save(RoutingLayout.model_validate({"profiles": [profile], "active_profile_id": profile["id"], "default_profile_id": profile["id"]}))
    assert len(store.load().default_profile().rules) == 4

    # The native canvas rebuilds profiles without `rules`: they must be kept.
    canvas_only = {key: value for key, value in profile.items() if key != "rules"}
    canvas_only["entities"][0]["x"] = 999
    store.save(RoutingLayout.model_validate({"profiles": [canvas_only], "active_profile_id": profile["id"], "default_profile_id": profile["id"]}))
    saved = store.load()
    assert len(saved.default_profile().rules) == 4
    assert saved.default_profile().entities[0].x == 999
    assert (tmp_path / "routing_layout.json.bak").exists()


def test_dispatch_follows_the_profile_rule(monkeypatch) -> None:
    used: list[str] = []

    def by_entity(entity, tier):
        used.append(entity.provider)
        return Resolution(StubProvider(), Backend.CLI, tier.value, entity.provider)

    monkeypatch.setattr(delegation, "resolve_entity", by_entity)
    classification = classify_prompt("Crea un endpoint REST en la API para listar usuarios y valida con tests.")
    result, decisions = delegate(classification, KarajanConfig(backend=Backend.CLI), layout=_layout_with_preset())

    assert result.status.value == "completed"
    assert used and set(used) == {"codex"}
    rule_decisions = [d for d in decisions if d.decision.startswith("rule:")]
    assert len(rule_decisions) == len(classification.subtasks)
    assert all(ex.backend == Backend.CLI for ex in result.executions)


def test_forced_provider_ignores_rules(monkeypatch) -> None:
    monkeypatch.setattr(delegation, "resolve_entity", lambda entity, tier: (_ for _ in ()).throw(AssertionError("rules must not run")))
    classification = classify_prompt("Diseña la interfaz del dashboard")
    forced = Resolution(StubProvider(), Backend.CLI, "x", "forced")
    _, decisions = delegate(classification, KarajanConfig(backend=Backend.CLI), layout=_layout_with_preset(), preresolved=forced)
    assert not any(d.decision.startswith("rule:") for d in decisions)
