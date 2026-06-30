from __future__ import annotations

from pathlib import Path

from app.models import SkillInfo

# Mirror of the agent-router skills configured in the user's Claude setup.
# `applies_to` lists the model families a skill is most relevant for.
_SKILLS: tuple[dict, ...] = (
    {"name": "repo-analyzer", "description": "Analiza repos, localiza código y dependencias.", "applies_to": ["claude", "codex"]},
    {"name": "cti-analyst", "description": "Inteligencia de amenazas: IOCs, TTPs, APTs, malware.", "applies_to": ["claude"]},
    {"name": "frontend-builder", "description": "UI, componentes, dashboards, visualización.", "applies_to": ["claude", "codex"]},
    {"name": "backend-builder", "description": "APIs, base de datos, auth, workers, lógica de servidor.", "applies_to": ["claude", "codex"]},
    {"name": "security-review", "description": "Secretos, permisos, despliegues, acciones irreversibles.", "applies_to": ["claude"]},
    {"name": "ponytail", "description": "Simplicidad, mínimo código seguro, YAGNI.", "applies_to": ["claude", "codex", "ollama"]},
    {"name": "promptfoo", "description": "Testing de prompts, evals y comparación de modelos.", "applies_to": ["claude"]},
    {"name": "aider", "description": "Pair-programming en terminal con edición multiarchivo.", "applies_to": ["claude", "ollama", "codex"]},
)

# Skills distribuidas desde repos GitHub (no vienen preinstaladas con el
# agente; se documentan aquí para poder asignarlas a un agente compatible
# desde el panel de Agentes). `repo_url` apunta al repositorio de origen.
_GITHUB_SKILLS: tuple[dict, ...] = (
    {"name": "docx", "description": "Crear, leer y editar documentos Word (.docx).", "applies_to": ["claude", "codex"], "repo_url": "https://github.com/anthropics/skills"},
    {"name": "pptx", "description": "Crear y editar presentaciones PowerPoint (.pptx).", "applies_to": ["claude", "codex"], "repo_url": "https://github.com/anthropics/skills"},
    {"name": "xlsx", "description": "Crear, leer y editar hojas de cálculo (.xlsx/.csv).", "applies_to": ["claude", "codex"], "repo_url": "https://github.com/anthropics/skills"},
    {"name": "pdf", "description": "Extraer, combinar, dividir y rellenar PDFs.", "applies_to": ["claude", "codex"], "repo_url": "https://github.com/anthropics/skills"},
    {"name": "mcp-builder", "description": "Construir servidores MCP para integrar APIs externas.", "applies_to": ["claude", "codex"], "repo_url": "https://github.com/anthropics/skills"},
    {"name": "skill-creator", "description": "Crear, editar y evaluar nuevas skills.", "applies_to": ["claude"], "repo_url": "https://github.com/anthropics/skills"},
    {"name": "webapp-testing", "description": "Probar apps web locales con Playwright.", "applies_to": ["claude", "codex"], "repo_url": "https://github.com/anthropics/skills"},
    {"name": "web-artifacts-builder", "description": "Artefactos web complejos (React, Tailwind, shadcn/ui).", "applies_to": ["claude", "codex"], "repo_url": "https://github.com/anthropics/skills"},
)

SKILLS_DIR = Path.home() / ".claude" / "skills"


def list_skills() -> list[SkillInfo]:
    """Return the skill catalog, marking which are installed in ~/.claude/skills.

    Installed skills are treated as the recommended defaults for non-experts.
    """
    return [
        SkillInfo(
            name=skill["name"],
            description=skill["description"],
            installed=(installed := (SKILLS_DIR / skill["name"]).is_dir()),
            recommended=installed,
            applies_to=skill["applies_to"],
            install_command=None if installed else f"claude skill install {skill['name']}",
            repo_url=skill.get("repo_url"),
        )
        for skill in (*_SKILLS, *_GITHUB_SKILLS)
    ]
