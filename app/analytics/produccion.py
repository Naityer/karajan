"""Analítica de producción de Karajan: acierto, flujo, eficiencia, matriz de skills y «qué mejorar».

Funciones puras sobre diccionarios planos (ver `TareaAnalitica`), sin base de datos, para que el port de TypeScript
(`atlas/src/produccion.ts`) dé exactamente lo mismo: las fixtures de paridad las genera este módulo.

Acierto por tarea (0–1). Pesa sobre todo que NO haya re-trabajo, es decir, que en las 24 h siguientes no llegue otro prompt
que vuelva sobre lo mismo: que cite un fragmento del anterior, que nombre los mismos ficheros o componentes, o que pida una
corrección sobre lo mismo. Pesos: 0,5 sin re-trabajo, 0,2 completada sin error, 0,2 validación aprobada y 0,1 sin revisión
humana bloqueante. La señal que falta (una tarea sin validar, por ejemplo) no puntúa: su peso se reparte entre las demás.

Lo que el usuario revisa en la nota del baúl (cabecera de agente: nivel, skills usadas, agente…) manda sobre lo clasificado.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, TypedDict


class RunAnalitica(TypedDict, total=False):
    provider_name: str | None
    status: str
    latency_ms: int | None
    estimated_cost_usd: float | None
    error: str | None


class TareaAnalitica(TypedDict, total=False):
    task_id: str
    prompt: str
    status: str
    created_at: str
    entry_agent: str | None
    classified_by: str | None
    nivel: str | None
    dominios: list[str]
    intencion: str | None
    recomendadas: list[str]
    ejecutadas: list[str]
    runs: list[RunAnalitica]
    decisiones: list[str]
    revision: dict[str, list[str]]


PESOS = {"retrabajo": 0.5, "completada": 0.2, "validacion": 0.2, "revision": 0.1}
VENTANA_RETRABAJO_H = 24
NIVELES = ("N1", "N2", "N3", "N4", "N5")
CORRECCION = (
    "arregla", "corrige", "sigue sin", "sigue igual", "sigue apareciendo", "otra vez", "de nuevo", "no funciona", "no va ",
    "todavia", "aun no", "falla", "vuelve a", "revisa otra", "fix ", "still", "again", "broken", "doesn't work", "not working",
)
_PALABRA = re.compile(r"[a-z0-9]+")
_RUTA = re.compile(r"[a-z0-9_./-]+\.(?:tsx|ts|jsx|js|py|css|md|json|html|sql|yml|yaml)\b")
_COMPONENTE = re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b")

CATEGORIAS_SKILL = (
    ("interfaz", ("frontend", "ui", "ux", "design", "diseno", "taste", "visual", "css", "animation", "brand", "theme", "minimalist", "brutalist", "impeccable", "image-to-code", "imagegen")),
    ("backend", ("backend", "api", "mcp", "server", "database", "sql")),
    ("seguridad", ("security", "seguridad", "cti", "threat", "secret")),
    ("documentos", ("docx", "pdf", "pptx", "xlsx", "doc-", "markdown", "markitdown", "latex", "report", "comms", "slides", "poster")),
    ("datos", ("data", "pandas", "polars", "dask", "plot", "matplotlib", "seaborn", "statistic", "visualization", "scikit", "vaex")),
    ("investigacion", ("research", "paper", "literature", "citation", "review", "scholar", "hypothesis", "lookup", "search")),
    ("agentes", ("agent", "skill", "prompt", "karajan", "promptfoo", "dspy", "router", "pi-")),
    ("codigo", ("repo", "code", "ponytail", "aider", "graphify", "testing", "webapp")),
)


def _utc(texto: str) -> datetime:
    valor = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    return valor.replace(tzinfo=timezone.utc) if valor.tzinfo is None else valor.astimezone(timezone.utc)


def _r(valor: float, d: int = 3) -> float:
    return round(valor + 0.0, d)


def plano(texto: str) -> str:
    """Minúsculas sin tildes (el TS hace lo mismo con NFD)."""
    return "".join(c for c in unicodedata.normalize("NFD", texto.lower()) if not unicodedata.combining(c))


def nivel_corto(nivel: str | None) -> str | None:
    """`level_3_intermediate` → `N3`; `N2` se queda igual."""
    if not nivel:
        return None
    m = re.match(r"(?:level_|n)(\d)", nivel.lower())
    return f"N{m.group(1)}" if m else None


def categoria_skill(nombre: str, descripcion: str = "") -> str:
    texto = plano(f"{nombre} {descripcion[:200]}")
    for categoria, claves in CATEGORIAS_SKILL:
        if any(c in texto for c in claves):
            return categoria
    return "otras"


def _palabras(texto: str) -> list[str]:
    return _PALABRA.findall(plano(texto))


def _tejas(palabras: list[str], n: int = 8) -> set[str]:
    return {" ".join(palabras[i:i + n]) for i in range(len(palabras) - n + 1)}


def _referencias(texto: str) -> set[str]:
    """Ficheros y componentes que nombra un prompt."""
    return {m for m in _RUTA.findall(plano(texto))} | {m.lower() for m in _COMPONENTE.findall(texto)}


def _jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def motivo_retrabajo(anterior: str, siguiente: str) -> str | None:
    """Por qué `siguiente` vuelve sobre lo que pedía `anterior` (o None si no lo hace)."""
    pa, ps = _palabras(anterior), _palabras(siguiente)
    if _tejas(pa) & _tejas(ps):
        return "cita el prompt anterior"
    if _jaccard(_referencias(anterior), _referencias(siguiente)) >= 0.3:
        return "vuelve sobre los mismos ficheros o componentes"
    s = f" {plano(siguiente)} "
    contenido_a = {p for p in pa if len(p) >= 4}
    contenido_s = {p for p in ps if len(p) >= 4}
    if any(c in s for c in CORRECCION) and _jaccard(contenido_a, contenido_s) >= 0.2:
        return "pide corregir lo mismo"
    return None


def _nivel(t: Mapping[str, Any]) -> str:
    revisado = [nivel_corto(v) for v in (t.get("revision") or {}).get("nivel_tarea", [])]
    revisado = [v for v in revisado if v]
    return revisado[0] if revisado else (nivel_corto(t.get("nivel")) or "sin nivel")


def _agente(t: Mapping[str, Any]) -> str:
    revisado = (t.get("revision") or {}).get("agente") or []
    if revisado:
        return str(revisado[0])
    for run in t.get("runs") or []:
        if run.get("provider_name"):
            return str(run["provider_name"])
    return "sin delegar"


def _entrada(t: Mapping[str, Any]) -> str:
    revisado = (t.get("revision") or {}).get("agente_entrada") or []
    if revisado:
        return str(revisado[0])
    if t.get("entry_agent"):
        return str(t["entry_agent"])
    return "skill /karajan" if t.get("classified_by") == "model:/karajan" else "desconocido"


def _dominio(t: Mapping[str, Any]) -> str:
    revisado = (t.get("revision") or {}).get("dominio") or []
    dominios = revisado or t.get("dominios") or []
    return str(dominios[0]) if dominios else "general"


def _skills_usadas(t: Mapping[str, Any]) -> list[str]:
    revisado = (t.get("revision") or {}).get("skills_usadas") or []
    return sorted(set(revisado or t.get("ejecutadas") or []))


def calcular_acierto(tareas: list[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Score de acierto por `task_id`, con las señales que lo componen y el motivo del re-trabajo."""
    orden = sorted(tareas, key=lambda t: (t["created_at"], t["task_id"]))
    resultado: dict[str, dict[str, Any]] = {}
    for i, t in enumerate(orden):
        inicio = _utc(t["created_at"])
        motivo: str | None = None
        repetida_por: str | None = None
        for siguiente in orden[i + 1:]:
            if _utc(siguiente["created_at"]) - inicio > timedelta(hours=VENTANA_RETRABAJO_H):
                break
            if t.get("entry_agent") and siguiente.get("entry_agent") and t["entry_agent"] != siguiente["entry_agent"]:
                continue
            motivo = motivo_retrabajo(t.get("prompt", ""), siguiente.get("prompt", ""))
            if motivo:
                repetida_por = siguiente["task_id"]
                break
        senales: dict[str, float] = {"retrabajo": 0.0 if motivo else 1.0}
        runs = t.get("runs") or []
        if runs or t.get("status") in ("completed", "failed"):
            sin_error = t.get("status") == "completed" and not any(r.get("error") or r.get("status") == "failed" for r in runs)
            senales["completada"] = 1.0 if sin_error else 0.0
        veredictos = [d for d in t.get("decisiones") or [] if "verdict=" in d]
        if veredictos:
            senales["validacion"] = 0.0 if any("verdict=needs_revision" in d or "verdict=failed" in d or "verdict=rejected" in d for d in veredictos) else 1.0
        puertas = [d for d in t.get("decisiones") or [] if d.startswith("human_review_gate=")]
        if puertas:
            senales["revision"] = 0.0 if puertas[-1] == "human_review_gate=blocked" else 1.0
        peso = sum(PESOS[k] for k in senales)
        score = sum(PESOS[k] * v for k, v in senales.items()) / peso
        resultado[t["task_id"]] = {"score": _r(score), "senales": senales, "retrabajo": motivo, "repetida_por": repetida_por}
    return resultado


def filtrar(tareas: Iterable[Mapping[str, Any]], *, agentes: Iterable[str] | None, dias: int, ahora: datetime) -> list[Mapping[str, Any]]:
    """Las del periodo (`dias=0`: todo) y, con `agentes`, solo las no delegadas o delegadas en un agente de esa lista."""
    corte = None if dias == 0 else ahora - timedelta(days=dias)
    permitidos = set(agentes) if agentes is not None else None
    salida = []
    for t in tareas:
        if corte and _utc(t["created_at"]) < corte:
            continue
        agente = _agente(t)
        if permitidos is not None and agente != "sin delegar" and agente not in permitidos:
            continue
        salida.append(t)
    return salida


def flujo(tareas: list[Mapping[str, Any]], acierto: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Entrada → nivel → agente → estado. Cada enlace lleva sus tareas (hasta 50) y su acierto medio."""
    enlaces: dict[tuple[str, str], dict[str, Any]] = {}
    nodos: dict[str, dict[str, Any]] = {}
    desajustes = 0
    for t in tareas:
        clasificado = nivel_corto(t.get("nivel")) or "sin nivel"
        nivel = _nivel(t)
        if nivel != clasificado:
            desajustes += 1
        capas = [("entrada", _entrada(t)), ("nivel", nivel), ("agente", _agente(t)), ("estado", str(t.get("status") or "?"))]
        for capa, nombre in capas:
            nid = f"{capa}:{nombre}"
            nodo = nodos.setdefault(nid, {"id": nid, "capa": capa, "nombre": nombre, "valor": 0})
            nodo["valor"] += 1
        for (ca, na), (cb, nb) in zip(capas, capas[1:]):
            clave = (f"{ca}:{na}", f"{cb}:{nb}")
            e = enlaces.setdefault(clave, {"origen": clave[0], "destino": clave[1], "valor": 0, "tareas": [], "_acierto": []})
            e["valor"] += 1
            if len(e["tareas"]) < 50:
                e["tareas"].append(t["task_id"])
            e["_acierto"].append(acierto[t["task_id"]]["score"])
    capas_orden = {"entrada": 0, "nivel": 1, "agente": 2, "estado": 3}
    lista_enlaces = []
    for e in enlaces.values():
        valores = e.pop("_acierto")
        e["acierto"] = _r(sum(valores) / len(valores))
        lista_enlaces.append(e)
    return {
        "nodos": sorted(nodos.values(), key=lambda n: (capas_orden[n["capa"]], -n["valor"], n["nombre"])),
        "enlaces": sorted(lista_enlaces, key=lambda e: (e["origen"], -e["valor"], e["destino"])),
        "total": len(tareas),
        "desajustes_nivel": desajustes,
        "revisadas": sum(1 for t in tareas if t.get("revision")),
    }


def _percentil(valores: list[float], p: float) -> float | None:
    """Rango más cercano (sin interpolar): el mismo valor en Python y en TS."""
    if not valores:
        return None
    orden = sorted(valores)
    indice = max(0, min(len(orden) - 1, int(-(-p * len(orden) // 1)) - 1))
    return orden[indice]


def _semana(texto: str) -> str:
    d = _utc(texto)
    lunes = (d - timedelta(days=d.weekday())).date()
    return lunes.isoformat()


def eficiencia(tareas: list[Mapping[str, Any]], acierto: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Coste y latencia por agente frente a su acierto; también por agente × nivel y semana a semana."""
    por_agente: dict[str, dict[str, Any]] = {}
    por_nivel: dict[tuple[str, str], list[float]] = {}
    por_semana: dict[tuple[str, str], list[float]] = {}
    for t in tareas:
        agente = _agente(t)
        if agente == "sin delegar":
            continue
        a = por_agente.setdefault(agente, {"latencias": [], "costes": [], "acierto": [], "retrabajo": 0, "tareas": 0})
        for run in t.get("runs") or []:
            if run.get("latency_ms") is not None:
                a["latencias"].append(float(run["latency_ms"]))
            a["costes"].append(float(run.get("estimated_cost_usd") or 0.0))
        score = acierto[t["task_id"]]["score"]
        a["acierto"].append(score)
        a["tareas"] += 1
        if acierto[t["task_id"]]["retrabajo"]:
            a["retrabajo"] += 1
        por_nivel.setdefault((agente, _nivel(t)), []).append(score)
        por_semana.setdefault((_semana(t["created_at"]), agente), []).append(score)
    agentes = []
    for nombre, a in por_agente.items():
        lat = a["latencias"]
        agentes.append({
            "agente": nombre,
            "tareas": a["tareas"],
            "runs": len(a["costes"]),
            "coste_medio": _r(sum(a["costes"]) / len(a["costes"]), 5) if a["costes"] else 0.0,
            "coste_total": _r(sum(a["costes"]), 5),
            "latencia_media": _r(sum(lat) / len(lat), 1) if lat else None,
            "p50": _percentil(lat, 0.5),
            "p90": _percentil(lat, 0.9),
            "acierto": _r(sum(a["acierto"]) / len(a["acierto"])),
            "retrabajo": _r(a["retrabajo"] / a["tareas"]),
        })
    return {
        "agentes": sorted(agentes, key=lambda x: (-x["tareas"], x["agente"])),
        "por_nivel": sorted(
            ({"agente": ag, "nivel": nv, "tareas": len(v), "acierto": _r(sum(v) / len(v))} for (ag, nv), v in por_nivel.items()),
            key=lambda x: (x["agente"], x["nivel"]),
        ),
        "serie": sorted(
            ({"semana": s, "agente": ag, "tareas": len(v), "acierto": _r(sum(v) / len(v))} for (s, ag), v in por_semana.items()),
            key=lambda x: (x["semana"], x["agente"]),
        ),
    }


def matriz_skills(tareas: list[Mapping[str, Any]], acierto: Mapping[str, Mapping[str, Any]], catalogo: list[Mapping[str, Any]]) -> dict[str, Any]:
    """Skill × categoría de tarea (dominio) con todas las skills del catálogo; `usada` permite cerrar la matriz a las usadas."""
    filas: dict[str, dict[str, Any]] = {}
    nombres: dict[str, str] = {}

    def fila(nombre: str, descripcion: str = "", instalada: bool = False) -> dict[str, Any]:
        clave = nombres.setdefault(nombre.casefold(), nombre)
        if clave not in filas:
            filas[clave] = {"skill": clave, "categoria": categoria_skill(clave, descripcion), "instalada": instalada, "usos": 0, "recomendada": 0, "celdas": {}, "agentes": {}, "_acierto": []}
        return filas[clave]

    for s in catalogo:
        fila(str(s["nombre"]), str(s.get("descripcion") or ""), bool(s.get("instalada")))
    categorias: set[str] = set()
    serie: dict[tuple[str, str], int] = {}
    for t in tareas:
        dominio = _dominio(t)
        agente = _agente(t)
        semana = _semana(t["created_at"])
        categorias.add(dominio)
        score = acierto[t["task_id"]]["score"]
        for nombre in sorted(set(t.get("recomendadas") or [])):
            fila(nombre)["recomendada"] += 1
        for nombre in _skills_usadas(t):
            f = fila(nombre)
            f["usos"] += 1
            f["_acierto"].append(score)
            celda = f["celdas"].setdefault(dominio, {"usos": 0, "_acierto": []})
            celda["usos"] += 1
            celda["_acierto"].append(score)
            f["agentes"][agente] = f["agentes"].get(agente, 0) + 1
            serie[(semana, f["skill"])] = serie.get((semana, f["skill"]), 0) + 1
    salida = []
    for f in filas.values():
        valores = f.pop("_acierto")
        f["acierto"] = _r(sum(valores) / len(valores)) if valores else None
        f["usada"] = f["usos"] > 0
        for celda in f["celdas"].values():
            v = celda.pop("_acierto")
            celda["acierto"] = _r(sum(v) / len(v))
        salida.append(f)
    return {
        "categorias": sorted(categorias),
        "filas": sorted(salida, key=lambda f: (-f["usos"], -f["recomendada"], f["skill"].casefold())),
        "usadas": sum(1 for f in salida if f["usada"]),
        "total": len(salida),
        "serie": [{"semana": s, "skill": k, "usos": n} for (s, k), n in sorted(serie.items())],
    }


_TIEMPO = ("timeout", "timed out", "tiempo")


def _cuantas(n: int, una: str, varias: str) -> str:
    return f"{n} {una if n == 1 else varias}"


def salud(tareas: list[Mapping[str, Any]], *, sin_nivel: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Salud del registro de tareas: agentes que fallan, revisiones pendientes, tareas sin delegar, límite de Claude y rotador."""
    salida: list[dict[str, Any]] = []
    for nombre in sorted(sin_nivel):
        salida.append({"id": f"sin-nivel:{nombre}", "severidad": "media", "texto": f"{nombre} está en el perfil sin niveles ni reglas: nunca recibe tareas.", "accion": None})
    por_agente: dict[str, list[int]] = {}
    for t in tareas:
        for r in t.get("runs") or []:
            fallo = r.get("status") == "failed" or bool(r.get("error"))
            tiempo = fallo and any(p in str(r.get("error") or "").lower() for p in _TIEMPO)
            c = por_agente.setdefault(str(r.get("provider_name") or "?"), [0, 0, 0])
            c[0] += 1
            c[1] += int(fallo)
            c[2] += int(tiempo)
    for agente in sorted(por_agente):
        n, f, to = por_agente[agente]
        if n >= 3 and f * 10 >= n * 3:
            extra = f" ({to} por tiempo agotado)" if to else ""
            salida.append({"id": f"fallos:{agente}", "severidad": "alta" if f * 2 >= n else "media", "texto": f"{agente} falló {f} de {n} ejecuciones{extra}: revisa su instalación, su sesión o su timeout.", "accion": None})
    decisiones = lambda t: t.get("decisiones") or []  # noqa: E731
    pendientes = sum(1 for t in tareas if "human_review_gate=blocked" in decisiones(t) and t.get("status") != "completed")
    if pendientes:
        salida.append({"id": "revision-pendiente", "severidad": "media", "texto": f"{_cuantas(pendientes, 'tarea espera', 'tareas esperan')} tu revisión (puerta humana bloqueada): apruébalas o recházalas desde el monitor.", "accion": None})
    solo = sum(1 for t in tareas if not t.get("runs") and t.get("status") == "classified")
    if solo >= 3:
        salida.append({"id": "solo-clasificadas", "severidad": "baja", "texto": f"{solo} tareas solo se clasificaron y nunca se delegaron: delégalas o archívalas.", "accion": None})
    limite = sum(1 for t in tareas if "limite_semanal:claude->codex" in decisiones(t))
    if limite:
        salida.append({"id": "limite-claude", "severidad": "baja", "texto": f"{_cuantas(limite, 'tarea pasó', 'tareas pasaron')} de Claude a Codex por el límite semanal de Claude.", "accion": None})
    repuestas = sorted({d[len("skill:repuesta:"):].split("->")[0] for t in tareas for d in decisiones(t) if d.startswith("skill:repuesta:")})
    if repuestas:
        salida.append({"id": "skills-repuestas", "severidad": "baja", "texto": f"El rotador repuso {_cuantas(len(repuestas), 'skill', 'skills')} para delegaciones; las que se sigan usando pasarán a núcleo solas.", "accion": None, "skills": repuestas[:30]})
    return salida


def sugerencias(
    efic: Mapping[str, Any],
    matriz: Mapping[str, Any],
    *,
    ultima: str | None,
    ahora: datetime,
    no_disponibles: Iterable[str] = (),
    tareas: Iterable[Mapping[str, Any]] = (),
    sin_nivel: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """«Qué mejorar»: reglas deterministas sobre la eficiencia, la matriz y el registro de tareas, de lo más urgente a lo menos."""
    salida: list[dict[str, Any]] = []
    for agente in sorted(no_disponibles):
        salida.append({"id": f"no-disponible:{agente}", "severidad": "alta", "texto": f"{agente} está en el perfil pero no está disponible: sus tareas irán al respaldo.", "accion": None})
    salida.extend(salud(list(tareas), sin_nivel=sin_nivel))
    for fila in efic.get("por_nivel", []):
        if fila["tareas"] >= 3 and fila["acierto"] < 0.6:
            salida.append({
                "id": f"nivel:{fila['agente']}:{fila['nivel']}", "severidad": "alta",
                "texto": f"{fila['agente']} acierta {fila['acierto']:.2f} en {fila['nivel']} ({fila['tareas']} tareas): delega ese nivel en otro agente.",
                "accion": {"tipo": "quitar_nivel", "agente": fila["agente"], "nivel": fila["nivel"]},
            })
    for a in efic.get("agentes", []):
        if a["tareas"] >= 4 and a["retrabajo"] >= 0.4:
            salida.append({
                "id": f"retrabajo:{a['agente']}", "severidad": "media",
                "texto": f"El {round(a['retrabajo'] * 100)} % de las tareas de {a['agente']} se repiten: revisa su nivel máximo o el prompt de entrada.",
                "accion": None,
            })
    nunca = [f["skill"] for f in matriz.get("filas", []) if f["recomendada"] >= 3 and not f["usada"]]
    for nombre in nunca[:5]:
        salida.append({"id": f"skill-sin-ejecutar:{nombre}", "severidad": "media", "texto": f"{nombre} se recomienda a menudo pero nunca se ejecuta: asígnala a un agente del perfil.", "accion": {"tipo": "asignar_skill", "skill": nombre}})
    sin_uso = [f["skill"] for f in matriz.get("filas", []) if f["instalada"] and not f["usada"] and not f["recomendada"]]
    if sin_uso:
        salida.append({"id": "skills-sin-uso", "severidad": "baja", "texto": f"{len(sin_uso)} skills instaladas no se han usado en el periodo: candidatas a retirar.", "accion": None, "skills": sin_uso[:30]})
    if ultima:
        dias = (ahora - _utc(ultima)).days
        if dias >= 14:
            salida.append({"id": "datos-antiguos", "severidad": "baja", "texto": f"El último dato tiene {dias} días: delega tareas para que las métricas reflejen el perfil actual.", "accion": None})
    orden = {"alta": 0, "media": 1, "baja": 2}
    return sorted(salida, key=lambda s: orden[s["severidad"]])


def catalogo_agrupado(matriz: Mapping[str, Any], top: int = 10) -> dict[str, Any]:
    """El catálogo de skills por grupos: instaladas, sin actividad, las más usadas y las recomendadas que faltan."""
    filas = list(matriz.get("filas", []))
    resumen = lambda f: {k: f[k] for k in ("skill", "categoria", "instalada", "usos", "recomendada", "acierto")}  # noqa: E731
    return {
        "instaladas": [resumen(f) for f in filas if f["instalada"]],
        "sin_actividad": [resumen(f) for f in filas if f["instalada"] and not f["usada"]],
        "top": [resumen(f) for f in filas if f["usada"]][:top],
        "recomendadas_no_instaladas": [resumen(f) for f in filas if f["recomendada"] and not f["instalada"]],
        "por_categoria": {c: sum(1 for f in filas if f["categoria"] == c) for c in sorted({f["categoria"] for f in filas})},
    }


def produccion(
    tareas: list[Mapping[str, Any]],
    *,
    catalogo: list[Mapping[str, Any]],
    agentes_perfil: Iterable[str] | None,
    dias: int,
    ahora: datetime,
    no_disponibles: Iterable[str] = (),
    sin_nivel: Iterable[str] = (),
) -> dict[str, Any]:
    """Todo junto: lo que sirven `/analytics/flujo`, `/eficiencia`, `/matriz-skills`, `/sugerencias` y `/skills/catalogo`."""
    seleccion = filtrar(tareas, agentes=agentes_perfil, dias=dias, ahora=ahora)
    # El re-trabajo mira el siguiente prompt aunque sea de otro agente o de fuera del periodo: se calcula sobre todas.
    acierto = calcular_acierto(tareas)
    efic = eficiencia(seleccion, acierto)
    matriz = matriz_skills(seleccion, acierto, catalogo)
    ultima = max((t["created_at"] for t in tareas), default=None)
    puntuadas = [acierto[t["task_id"]]["score"] for t in seleccion if _agente(t) != "sin delegar"]
    return {
        "dias": dias,
        "perfil": "activo" if agentes_perfil is not None else "todos",
        "agentes_perfil": sorted(agentes_perfil) if agentes_perfil is not None else None,
        "ultima": ultima,
        "kpis": {
            "tareas": len(seleccion),
            "delegadas": len(puntuadas),
            "acierto": _r(sum(puntuadas) / len(puntuadas)) if puntuadas else None,
            "retrabajo": _r(sum(1 for t in seleccion if acierto[t["task_id"]]["retrabajo"]) / len(seleccion)) if seleccion else None,
            "revisadas": sum(1 for t in seleccion if t.get("revision")),
        },
        "flujo": flujo(seleccion, acierto),
        "eficiencia": efic,
        "matriz": matriz,
        "sugerencias": sugerencias(efic, matriz, ultima=ultima, ahora=ahora, no_disponibles=no_disponibles, tareas=seleccion, sin_nivel=sin_nivel),
        "catalogo": catalogo_agrupado(matriz),
        "acierto": {t["task_id"]: acierto[t["task_id"]] for t in seleccion},
    }
