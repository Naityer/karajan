"""Analítica de producción: acierto con re-trabajo, flujo, eficiencia, matriz de skills y sugerencias."""

from datetime import datetime, timezone

from app.analytics import produccion as p

AHORA = datetime(2026, 10, 12, tzinfo=timezone.utc)


def tarea(tid, prompt, cuando, *, agente="codex", estado="completed", nivel="level_2_moderate", dominio="frontend",
          skills=(), entrada=None, decisiones=(), revision=None, latencia=1000, coste=0.001):
    runs = [] if agente is None else [{"provider_name": agente, "status": "completed" if estado == "completed" else "failed",
                                       "latency_ms": latencia, "estimated_cost_usd": coste, "error": None}]
    return {"task_id": tid, "prompt": prompt, "status": estado, "created_at": cuando, "entry_agent": entrada,
            "classified_by": "heuristic", "nivel": nivel, "dominios": [dominio], "intencion": "implement_feature",
            "recomendadas": list(skills), "ejecutadas": list(skills), "runs": runs, "decisiones": list(decisiones),
            "revision": revision or {}}


def test_retrabajo_por_mismos_ficheros_y_por_correccion():
    assert p.motivo_retrabajo("Ajusta el layout de mapa-espacio.tsx y layout.ts", "En mapa-espacio.tsx el layout.ts sigue mal") == "vuelve sobre los mismos ficheros o componentes"
    assert p.motivo_retrabajo("Haz que las tarjetas del mapa sean cápsulas compactas", "Las tarjetas del mapa siguen sin ser cápsulas, corrige eso") == "pide corregir lo mismo"
    largo = "quiero que cuando seleccione una carpeta en el diagrama del mapa se autoenfoque"
    assert p.motivo_retrabajo(largo, f"Como te dije: {largo}, hazlo más suave") == "cita el prompt anterior"
    assert p.motivo_retrabajo("Exporta el informe en PDF", "Crea un endpoint de usuarios") is None


def test_acierto_pondera_y_reparte_las_senales_que_faltan():
    ts = [
        tarea("a", "Haz que las tarjetas del mapa sean cápsulas compactas", "2026-10-10T10:00:00+00:00", decisiones=["sub_001:validator=X;verdict=approved;priority=P3"]),
        tarea("b", "Las tarjetas del mapa siguen sin ser cápsulas, corrige eso", "2026-10-10T11:00:00+00:00"),
        tarea("c", "Otro asunto distinto sin relación", "2026-10-12T11:00:00+00:00", estado="failed"),
    ]
    a = p.calcular_acierto(ts)
    # a: re-trabajo (0) · completada (0,2) · validación (0,2) → 0,4 / 0,9
    assert a["a"]["retrabajo"] == "pide corregir lo mismo" and a["a"]["repetida_por"] == "b"
    assert a["a"]["score"] == round(0.4 / 0.9, 3)
    assert a["b"]["score"] == 1.0
    assert a["c"]["score"] == round(0.5 / 0.7, 3)


def test_otro_agente_de_entrada_no_cuenta_como_retrabajo():
    ts = [
        tarea("a", "Haz que las tarjetas del mapa sean cápsulas compactas", "2026-10-10T10:00:00+00:00", entrada="claude"),
        tarea("b", "Las tarjetas del mapa siguen sin ser cápsulas, corrige eso", "2026-10-10T11:00:00+00:00", entrada="codex"),
    ]
    assert p.calcular_acierto(ts)["a"]["retrabajo"] is None


def test_produccion_filtra_por_perfil_y_prioriza_lo_revisado():
    ts = [
        tarea("a", "uno", "2026-10-10T10:00:00+00:00", agente="codex", skills=["frontend-builder"], entrada="claude",
              revision={"nivel_tarea": ["N3"], "skills_usadas": ["impeccable"]}),
        tarea("b", "dos", "2026-10-10T12:00:00+00:00", agente="simulated"),
        tarea("c", "tres", "2026-10-11T12:00:00+00:00", agente=None, estado="classified"),
    ]
    catalogo = [{"nombre": "impeccable", "descripcion": "polish UI", "instalada": True}, {"nombre": "docx", "descripcion": "", "instalada": True}]
    r = p.produccion(ts, catalogo=catalogo, agentes_perfil=["codex", "claude-cli"], dias=0, ahora=AHORA)
    assert r["kpis"]["tareas"] == 2 and r["kpis"]["delegadas"] == 1 and r["kpis"]["revisadas"] == 1
    assert {n["id"] for n in r["flujo"]["nodos"]} >= {"entrada:claude", "nivel:N3", "agente:codex", "agente:sin delegar"}
    assert r["flujo"]["desajustes_nivel"] == 1
    assert [a["agente"] for a in r["eficiencia"]["agentes"]] == ["codex"]
    filas = {f["skill"]: f for f in r["matriz"]["filas"]}
    assert filas["impeccable"]["usada"] and filas["impeccable"]["celdas"]["frontend"]["usos"] == 1
    assert filas["impeccable"]["categoria"] == "interfaz"
    assert not filas["frontend-builder"]["usada"] and filas["frontend-builder"]["recomendada"] == 1
    assert [s["skill"] for s in r["catalogo"]["sin_actividad"]] == ["docx"]
    todos = p.produccion(ts, catalogo=catalogo, agentes_perfil=None, dias=0, ahora=AHORA)
    assert todos["kpis"]["tareas"] == 3


def test_sugerencias_de_nivel_y_datos_antiguos():
    # La misma petición repetida tres veces en una mañana y fallida: re-trabajo y error.
    pide = "arregla el contador de pendientes del panel de control porque no suma bien los ficheros"
    ts = [tarea(f"t{i}", pide, f"2026-09-01T1{i}:00:00+00:00", agente="ollama-qwen", estado="failed", nivel="level_2_moderate") for i in range(3)]
    r = p.produccion(ts, catalogo=[], agentes_perfil=None, dias=0, ahora=AHORA, no_disponibles=["claude-cli"])
    ids = [s["id"] for s in r["sugerencias"]]
    assert ids[0] == "no-disponible:claude-cli"
    assert "nivel:ollama-qwen:N2" in ids and "datos-antiguos" in ids
    accion = next(s for s in r["sugerencias"] if s["id"] == "nivel:ollama-qwen:N2")["accion"]
    assert accion == {"tipo": "quitar_nivel", "agente": "ollama-qwen", "nivel": "N2"}


def test_percentil_por_rango_cercano():
    assert p._percentil([10, 20, 30, 40], 0.5) == 20
    assert p._percentil([10, 20, 30, 40], 0.9) == 40
    assert p._percentil([], 0.5) is None


def test_revisiones_del_baul_se_guardan_y_sustituyen(tmp_path):
    from app.database import TaskStore

    store = TaskStore(tmp_path / "t.db")
    store.save_reviews("tsk_1", {"nivel_tarea": ["N3"], "skills_usadas": ["impeccable", "frontend-builder"]}, "2026-10-12T00:00:00+00:00")
    assert store.list_reviews() == {"tsk_1": {"nivel_tarea": ["N3"], "skills_usadas": ["frontend-builder", "impeccable"]}}
    store.save_reviews("tsk_1", {"agente": ["codex"]}, "2026-10-13T00:00:00+00:00")
    assert store.list_reviews() == {"tsk_1": {"agente": ["codex"]}}


def test_endpoints_de_produccion_y_feedback(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    c = TestClient(app)
    for ruta in ("/analytics/flujo", "/analytics/eficiencia", "/analytics/matriz-skills", "/analytics/sugerencias", "/skills/catalogo"):
        r = c.get(ruta + "?perfil=todos")
        assert r.status_code == 200, ruta
    assert c.get("/analytics/flujo?perfil=otro").status_code == 422
    assert set(c.get("/analytics/flujo").json()) >= {"nodos", "enlaces", "kpis", "agentes_perfil"}
