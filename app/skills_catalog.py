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
        )
        for skill in _SKILLS
    ]
