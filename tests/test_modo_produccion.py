"""Modo producción en el servidor nativo: el mismo `modo.json` que el paquete de Atlas dev."""

import json

from app.configuration import modo


def _layout(client):
    layout = client.get("/routing-layout").json()
    layout["drawer_width"] = 333
    return layout


def test_sin_modo_json_el_nativo_queda_en_desarrollo(karajan_install) -> None:
    client = karajan_install.client
    assert client.put("/routing-layout", json=_layout(client)).status_code == 200


def test_en_produccion_las_mutaciones_exigen_una_tarea_aceptada(karajan_install, monkeypatch) -> None:
    (karajan_install.runtime.data_dir / "modo.json").write_text(json.dumps({"modo": "produccion"}), encoding="utf-8")
    estados = {"acep": "encolada", "bor": "borrador"}
    monkeypatch.setattr(modo, "estado_tarea_atlas", lambda tarea: estados.get(tarea))
    client = karajan_install.client

    assert client.put("/routing-layout", json=_layout(client)).status_code == 423
    assert client.put("/routing-layout", json=_layout(client), headers={"x-karajan-tarea": "bor"}).status_code == 423
    assert client.put("/config", json=client.get("/config").json()).status_code == 423
    assert client.post("/routing-layout/presets/nivel").status_code == 423

    respuesta = client.put("/routing-layout", json=_layout(client), headers={"x-karajan-tarea": "acep"})
    assert respuesta.status_code == 200
    assert respuesta.json()["drawer_width"] == 333
    # Leer y clasificar no cambian nada: siguen libres.
    assert client.get("/routing-layout").status_code == 200
    assert client.post("/classify-task", json={"prompt": "Arregla el login"}).status_code == 200


def test_el_modo_solo_cambia_editando_el_fichero(tmp_path) -> None:
    assert modo.leer_modo(None) == "desarrollo"
    assert modo.leer_modo(tmp_path) == "desarrollo"
    (tmp_path / "modo.json").write_text("roto", encoding="utf-8")
    assert modo.leer_modo(tmp_path) == "produccion"
    (tmp_path / "modo.json").write_text('{"modo": "produccion"}', encoding="utf-8")
    assert modo.leer_modo(tmp_path) == "produccion"
