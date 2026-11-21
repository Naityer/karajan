"""Evolución de perfiles: solo propone, solo con evidencia y sin tocar el perfil por defecto."""



from app.domain.models import RoutingLayout, RoutingProfile
from app.routing import evolucion, perfil_base
from app.routing.evolucion import Muestra


def _layout(*extra: dict) -> RoutingLayout:
    base = perfil_base.base_profile()
    return RoutingLayout.model_validate(
        {"profiles": [base, *extra], "active_profile_id": base["id"], "default_profile_id": base["id"]}
    )


def _muestras(entidad: str, n: int, exitos: int, *, areas=("redaccion",), complejidad=1.2, perfil="base-2026-11-12") -> list[Muestra]:
    layout = _layout()
    e = next(x for x in layout.default_profile().entities if x.id == entidad)
    return [Muestra(perfil, (e.provider, e.model), complejidad, areas, i < exitos) for i in range(n)]


def test_wilson_acota_y_no_concluye_con_poco_dato() -> None:
    bajo, alto = evolucion.wilson(3, 3)
    assert 0 < bajo < 1 and alto == 1.0
    assert evolucion.wilson(0, 0) == (0.0, 1.0)


def test_sin_muestras_suficientes_no_hay_necesidad_ni_hijos() -> None:
    muestras = _muestras("base-luna", evolucion.MIN_MUESTRAS - 1, 0)
    assert evolucion.detectar_necesidades(_layout().default_profile(), muestras) == []
    assert evolucion.proponer_generacion(_layout(), muestras) == []


def test_un_fracaso_demostrado_muta_un_solo_gen_y_deja_linaje() -> None:
    layout = _layout()
    muestras = _muestras("base-luna", 20, 8)  # 40 % de éxito en redacción
    hijos = evolucion.proponer_generacion(layout, muestras, semilla=7)
    assert hijos, "debe proponer al menos una mutación"
    hijo = hijos[0]
    assert hijo.origin == "mutacion" and hijo.generation == 1 and hijo.parents == ["base-2026-11-12"]
    assert "redaccion" in hijo.mutation_note and "20 ejecuciones" in hijo.mutation_note
    padre = layout.default_profile()
    antes = next(e for e in padre.entities if e.id == "base-luna").aptitud.afinidad_dominio["redaccion"]
    despues = next(e for e in hijo.entities if e.id == "base-luna").aptitud.afinidad_dominio["redaccion"]
    assert despues < antes
    # el resto del genoma queda igual
    otros_padre = {e.id: e.aptitud for e in padre.entities if e.id != "base-luna"}
    otros_hijo = {e.id: e.aptitud for e in hijo.entities if e.id != "base-luna"}
    assert otros_padre == otros_hijo


def test_el_exito_sobresaliente_refuerza_la_afinidad() -> None:
    muestras = _muestras("base-terra", 60, 60, areas=("backend",), complejidad=3.0)
    hijo = evolucion.proponer_generacion(_layout(), muestras, semilla=1)[0]
    assert next(e for e in hijo.entities if e.id == "base-terra").aptitud.afinidad_dominio["backend"] > 0.95 or \
        next(e for e in hijo.entities if e.id == "base-terra").aptitud.afinidad_dominio["backend"] == 1.0


def test_un_fallo_por_banda_estrecha_el_rango() -> None:
    muestras = _muestras("base-haiku", 20, 5, areas=(), complejidad=2.2)  # banda 2.0–2.5 falla
    hijo = next(h for h in evolucion.proponer_generacion(_layout(), muestras) if "rango" in h.mutation_note)
    haiku = next(e for e in hijo.entities if e.id == "base-haiku").aptitud
    assert haiku.rango_complejidad[1] <= 2.0 and haiku.optimo <= haiku.rango_complejidad[1]


def test_determinista_por_semilla_y_nunca_toca_el_perfil_por_defecto() -> None:
    layout = _layout()
    muestras = _muestras("base-luna", 20, 8)
    a = evolucion.proponer_generacion(layout, muestras, semilla=3)
    b = evolucion.proponer_generacion(layout, muestras, semilla=3)
    assert [p.model_dump() for p in a] == [p.model_dump() for p in b]
    assert layout.default_profile_id == "base-2026-11-12" and len(layout.profiles) == 1
    assert all(p.id != layout.default_profile_id for p in a)


def test_el_cruce_hereda_la_ficha_del_padre_con_mejor_evidencia() -> None:
    padre_b = RoutingProfile.model_validate(perfil_base.base_profile("otro-perfil"))
    luna_b = next(e for e in padre_b.entities if e.id == "base-luna")
    luna_b.aptitud.afinidad_dominio["redaccion"] = 0.5
    layout = _layout(padre_b.model_dump())
    muestras = (_muestras("base-luna", 20, 8, perfil="base-2026-11-12")
                + _muestras("base-luna", 20, 19, perfil="otro-perfil"))
    cruce = next(h for h in evolucion.proponer_generacion(layout, muestras) if h.origin == "cruce")
    assert next(e for e in cruce.entities if e.id == "base-luna").aptitud.afinidad_dominio["redaccion"] == 0.5
    assert sorted(cruce.parents) == ["base-2026-11-12", "otro-perfil"]


def test_las_mutaciones_son_acotadas() -> None:
    rng = evolucion.Azar(0)
    muestras = _muestras("base-luna", 20, 0)
    necesidad = next(n for n in evolucion.detectar_necesidades(_layout().default_profile(), muestras) if n.tipo == "fracaso_dominio")
    for _ in range(30):
        hijo = evolucion.mutar(_layout().default_profile(), necesidad, rng, "x-g1")
        valor = next(e for e in hijo.entities if e.id == "base-luna").aptitud.afinidad_dominio["redaccion"]
        assert 0.0 <= valor <= 1.0
