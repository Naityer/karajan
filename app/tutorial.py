from __future__ import annotations

# One source of truth for "what does each tab do", shared by:
#   - the web app's "?" help modal (GET /setup/tutorial)
#   - the file written to disk at the end of setup (docs/TUTORIAL_NAVEGACION.md),
#     from both the first-run web overlay (POST /setup/complete) and the
#     terminal installer (scripts/setup_production.py)
# Kept deterministic/hand-written (not LLM-generated) so it never drifts from
# what the nav actually contains and needs no network call to produce.

NAV_SECTIONS: tuple[tuple[str, str], ...] = (
    (
        "Control humano",
        "La vista isométrica de la ciudad de agentes. Cada torre es un agente; haz clic en una "
        "para ver su detalle. Aquí lanzas misiones nuevas, revisas el ahorro delegado a workers "
        "y apruebas o rechazas decisiones que requieren tu confirmación.",
    ),
    (
        "Grafo",
        "Mapa de dependencias del propio repositorio KARAJAN (módulos de app/, tests/, tools/). "
        "Útil para orientarte en el código, no en el comportamiento en tiempo de ejecución.",
    ),
    (
        "Monitor",
        "Panel de observabilidad: métricas resumidas, salud del sistema, uso de skills por "
        "agente, y el seguimiento de cada tarea delegada (coste, latencia, tokens, estado). "
        "Es el sitio para auditar qué ha hecho el harness y por qué.",
    ),
    (
        "Decisión",
        "El diagrama de arquitectura: el Agent (padre de decisiones) y sus submodelos, con los "
        "niveles de complejidad que cada uno cubre. Aquí también ves la tarjeta de OpenClaw "
        "(estado de la integración) y las asociaciones de supervisión/validación entre nodos.",
    ),
    (
        "Agentes",
        "Catálogo de proveedores (locales y de API): estado de conexión, coste y comandos de "
        "login/verificación reales para cada uno.",
    ),
    (
        "Configuración",
        "Parámetros ajustables del harness — pesos de criterios, umbrales de nivel, política de "
        "revisión humana — en modo tradicional o mediante plantillas de prompting.",
    ),
)


def navigation_tutorial_markdown() -> str:
    lines = [
        "# KARAJAN — Tutorial de navegación",
        "",
        "Guía rápida de qué es cada pestaña de la aplicación.",
        "",
    ]
    for title, description in NAV_SECTIONS:
        lines.append(f"## {title}")
        lines.append("")
        lines.append(description)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
