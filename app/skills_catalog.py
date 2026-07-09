from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from app.models import SkillInfo, SkillInstallResult

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

# Skills que viven en este propio repo (bajo skills/<name>/SKILL.md) y se
# instalan copiando esos ficheros a ~/.claude/skills — no requieren red ni git.
# `command_file`, si existe, se copia también a ~/.claude/commands para que el
# slash-command quede disponible (p.ej. /karajan).
_LOCAL_SKILLS: tuple[dict, ...] = (
    {
        "name": "karajan",
        "description": (
            "Router/orquestador de tareas propio de este proyecto: clasifica el prompt, "
            "registra la decisión en el harness KARAJAN y delega según la arquitectura de Decisión."
        ),
        "applies_to": ["claude", "codex"],
        "source_dir": "skills/karajan",
        "command_file": "commands/karajan.md",
    },
    {
        "name": "task-router",
        "description": "Clasifica prompts por ámbito, complejidad y riesgo (sin registrar en el harness).",
        "applies_to": ["claude", "codex", "ollama"],
        "source_dir": "skills/task-router",
        "command_file": None,
    },
)

SKILLS_DIR = Path.home() / ".claude" / "skills"
COMMANDS_DIR = Path.home() / ".claude" / "commands"
_REPO_ROOT = Path(__file__).resolve().parent.parent


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
        for skill in (*_SKILLS, *_GITHUB_SKILLS, *_LOCAL_SKILLS)
    ]


def install_skill(name: str) -> SkillInstallResult:
    """Install a catalog-listed skill into ~/.claude/skills.

    Restricted to names present in the static catalog (never arbitrary specs).
    Three sources: `_SKILLS` are already bundled with the agent (nothing to
    do), `_GITHUB_SKILLS` are cloned from `repo_url`, `_LOCAL_SKILLS` are
    copied straight from this repo's own `skills/<name>/` (plus its matching
    `commands/<name>.md`, if any) — no network needed.
    """
    entry = next((s for s in (*_SKILLS, *_GITHUB_SKILLS, *_LOCAL_SKILLS) if s["name"] == name), None)
    if entry is None:
        return SkillInstallResult(ok=False, detail=f"Skill desconocida en el catálogo: {name}")

    target = SKILLS_DIR / name
    if target.is_dir():
        return SkillInstallResult(ok=True, detail=f"'{name}' ya está instalada.")

    source_dir = entry.get("source_dir")
    if source_dir:
        source = _REPO_ROOT / source_dir
        if not source.is_dir():
            return SkillInstallResult(ok=False, detail=f"No se encontró '{source_dir}' en el repo.")
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)
        command_file = entry.get("command_file")
        if command_file:
            command_source = _REPO_ROOT / command_file
            if command_source.is_file():
                COMMANDS_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copy2(command_source, COMMANDS_DIR / command_source.name)
        return SkillInstallResult(
            ok=True, detail=f"'{name}' instalada en {target}. Reinicia Claude Code para que aparezca."
        )

    repo_url = entry.get("repo_url")
    if not repo_url:
        return SkillInstallResult(ok=False, detail=f"'{name}' viene incluida con el agente; no requiere instalación.")

    if not shutil.which("git"):
        return SkillInstallResult(ok=False, detail="git no está disponible para clonar la skill.")

    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        clone = subprocess.run(
            ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", repo_url, tmp],
            capture_output=True, text=True, timeout=60, check=False,
        )
        if clone.returncode != 0:
            return SkillInstallResult(ok=False, detail=clone.stderr.strip() or f"git clone falló para '{name}'.")
        subprocess.run(
            ["git", "sparse-checkout", "set", name],
            cwd=tmp, capture_output=True, text=True, timeout=30, check=False,
        )
        source = Path(tmp) / name
        if not source.is_dir():
            return SkillInstallResult(ok=False, detail=f"No se encontró la carpeta '{name}' en {repo_url}.")
        shutil.copytree(source, target)
    return SkillInstallResult(ok=True, detail=f"'{name}' instalada correctamente.")
