"""Perfil base base-2026-11-12: puntuación continua por agente, no por escalones de nivel."""

from app.domain.models import RoutingLayout, RoutingProfile
from app.routing import perfil_base, puntuacion


def _perfil() -> RoutingProfile:
    return RoutingProfile.model_validate(perfil_base.base_profile())


def _criterios(**kw: float) -> dict[str, float]:
    base = {k: 1.0 for k in puntuacion.CRITERIOS}
    base.update(kw)
    return base


def _gana(score: float, areas: tuple[str, ...] = (), **criterios: float) -> str:
    perfil = _perfil()
    tarea = puntuacion.TareaPuntuable(score, _criterios(**criterios), areas)
    return puntuacion.ranking(perfil.entities, tarea, perfil.scoring)[0][0].id


def test_el_perfil_base_es_valido_con_una_entidad_por_modelo() -> None:
    perfil = _perfil()
    assert perfil.id == "base-2026-11-12" and perfil.origin == "base" and perfil.generation == 0
    ids = {e.id for e in perfil.entities}
    assert ids == {f"base-{n}" for n in ("haiku", "sonnet", "opus", "fable", "terra", "luna", "sol", "astra", "gemini", "local")}
    assert all(e.aptitud is not None and not e.aptitud.medido for e in perfil.entities)
    layout = RoutingLayout.model_validate({"profiles": [perfil.model_dump()], "active_profile_id": perfil.id, "default_profile_id": perfil.id})
    assert layout.default_profile().scoring is not None


def test_los_criterios_del_propietario_eligen_el_agente_esperado() -> None:
    assert _gana(1.0, ("backend",)) == "base-terra" or _gana(1.0, ("backend",)) == "base-haiku"
    assert _gana(1.2, ("redaccion",)) == "base-luna"
    assert _gana(2.8, ("oficina",)) == "base-terra"
    assert _gana(3.0, ("frontend", "grafico"), autonomy_required=4.0) == "base-sonnet"
    assert _gana(2.6, ("planificacion", "academico"), reasoning_depth=4.0, ambiguity=3.0) == "base-astra"


def test_el_reparto_es_continuo_y_no_por_escalones_de_nivel() -> None:
    # Misma tarea de interfaz: al subir la puntuación pasa de Haiku/Sonnet a Opus, sin saltos erráticos.
    orden = ["base-haiku", "base-sonnet", "base-opus", "base-fable"]
    elegidos = [_gana(s, ("frontend",), autonomy_required=3.0) for s in (1.0, 1.8, 2.4, 3.0, 4.0, 4.6)]
    posiciones = [orden.index(e) for e in elegidos if e in orden]
    assert posiciones == sorted(posiciones), elegidos
    assert elegidos[0] != elegidos[-1]
    # 2.4 y 3.0 caen en el mismo nivel «intermedio» y aun así se distinguen de 1.0
    assert elegidos[3] == "base-sonnet"


def test_opus_y_fable_se_vetan_en_tareas_largas() -> None:
    perfil = _perfil()
    corta = puntuacion.TareaPuntuable(4.5, _criterios(context_required=0.0), ("grafico",))
    larga = puntuacion.TareaPuntuable(4.5, _criterios(context_required=5.0), ("grafico",))
    ids_corta = {e.id for e, _ in puntuacion.ranking(perfil.entities, corta, perfil.scoring)}
    ids_larga = {e.id for e, _ in puntuacion.ranking(perfil.entities, larga, perfil.scoring)}
    assert puntuacion.duracion_estimada_min(corta, perfil.scoring) > 5  # incluso la «corta» pasa de 5 min a este score
    assert "base-opus" not in ids_corta and "base-fable" not in ids_larga
    assert "base-sonnet" in ids_larga


def test_ajuste_de_complejidad_decae_fuera_del_rango() -> None:
    haiku = next(e for e in _perfil().entities if e.id == "base-haiku")
    assert puntuacion.ajuste_complejidad(haiku, 1.0) == 1.0
    assert puntuacion.ajuste_complejidad(haiku, 2.0) < puntuacion.ajuste_complejidad(haiku, 1.5)
    assert puntuacion.ajuste_complejidad(haiku, 3.5) == 0.0


def test_el_reparto_real_usa_la_puntuacion_y_lo_registra(monkeypatch) -> None:
    from app.domain.models import Backend, KarajanConfig
    from app.execution import delegation
    from app.providers.registry import Resolution
    from app.routing.router import classify_prompt
    from tests.conftest import StubProvider

    usados: list[tuple[str, str]] = []

    def por_entidad(entity, tier):
        usados.append((entity.provider, entity.model))
        return Resolution(StubProvider(), Backend.CLI, entity.model or tier.value, entity.provider)

    monkeypatch.setattr(delegation, "resolve_entity", por_entidad)
    perfil = _perfil()
    layout = RoutingLayout.model_validate(
        {"profiles": [perfil.model_dump()], "active_profile_id": perfil.id, "default_profile_id": perfil.id}
    ).project_default_profile()
    clasificacion = classify_prompt("Crea un endpoint REST en la API para listar usuarios y valida con tests.")
    resultado, decisiones = delegation.delegate(clasificacion, KarajanConfig(backend=Backend.CLI), layout=layout)

    assert resultado.status.value == "completed"
    assert usados and all(modelo for _, modelo in usados)
    puntuadas = [d for d in decisiones if d.decision.startswith("score:")]
    assert len(puntuadas) == len(clasificacion.subtasks)
    assert all("/100" in d.reason for d in puntuadas)


def test_el_json_del_paquete_atlas_es_el_perfil_base_de_python() -> None:
    import json
    from pathlib import Path

    ruta = Path(__file__).resolve().parents[2] / "atlas" / "src" / "perfil-base.json"
    assert json.loads(ruta.read_text(encoding="utf-8")) == json.loads(json.dumps(perfil_base.base_profile())), (
        "regenera atlas/src/perfil-base.json desde app.routing.perfil_base.base_profile()"
    )
