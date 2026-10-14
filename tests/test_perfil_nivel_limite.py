"""Perfil por nivel (los niveles de la entidad deciden quién ejecuta) y límite semanal de Claude."""

import json
from datetime import datetime, timedelta, timezone

from app import limites_plan, routing_rules
from app.models import RoutingLayout


def _layout() -> RoutingLayout:
    perfil = routing_rules.level_preset_profile()
    return RoutingLayout.model_validate({"profiles": [perfil], "active_profile_id": perfil["id"], "default_profile_id": perfil["id"]}).project_default_profile()


def test_preset_por_nivel_reparte_los_niveles():
    p = routing_rules.level_preset_profile()
    assert [e["provider"] for e in p["entities"]] == ["ollama-qwen", "codex", "claude-cli"]
    assert p["rules"] == [] and "50 %" in p["description"]
    layout = _layout()
    assert routing_rules.entity_for_level(layout, 1).provider == "ollama-qwen"
    assert routing_rules.entity_for_level(layout, 3).provider == "codex"
    assert routing_rules.entity_for_level(layout, 5).provider == "claude-cli"
    assert routing_rules.entity_for_level(layout, 9) is None
    assert routing_rules.entity_for_level(None, 3) is None


def test_la_descripcion_del_perfil_se_conserva():
    layout = RoutingLayout.model_validate({"profiles": [routing_rules.level_preset_profile()], "active_profile_id": "por-nivel"})
    assert layout.profiles[0].description.startswith("Delega según el nivel")


def test_limite_semanal(tmp_path, monkeypatch):
    fichero = tmp_path / "limites-plan.json"
    ahora = datetime.now(timezone.utc)
    fichero.write_text(json.dumps({"claude": {"semanal": 63}, "leido": ahora.isoformat()}), encoding="utf-8")
    assert limites_plan.claude_excedido(fichero=fichero) == 63
    monkeypatch.setenv("KARAJAN_LIMITE_CLAUDE", "70")
    assert limites_plan.claude_excedido(fichero=fichero) is None
    monkeypatch.delenv("KARAJAN_LIMITE_CLAUDE")
    fichero.write_text(json.dumps({"claude": {"semanal": 63}, "leido": (ahora - timedelta(hours=3)).isoformat()}), encoding="utf-8")
    assert limites_plan.claude_excedido(fichero=fichero) is None
    assert limites_plan.claude_excedido(fichero=tmp_path / "no-existe.json") is None
