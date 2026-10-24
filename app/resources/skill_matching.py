"""Bounded, local skill discovery and matching. SKILL.md bodies are never prompt context."""

from __future__ import annotations

import re
import shutil
import unicodedata
from dataclasses import dataclass
from pathlib import Path


ALIASES: dict[str, tuple[str, ...]] = {
    "repo-analyzer": ("repositorio", "repository", "codebase"),
    "frontend-builder": ("frontend", "interfaz", "dashboard", "react", "css"),
    "backend-builder": ("backend", "endpoint", "api", "base de datos"),
    "security-review": ("seguridad", "security", "vulnerabilidad", "credenciales", "secretos"),
    "webapp-testing": ("playwright", "prueba e2e", "pruebas de extremo a extremo"),
    "pdf": ("pdf",), "docx": ("docx", "word"), "pptx": ("pptx", "powerpoint"),
    "xlsx": ("xlsx", "excel", "hoja de calculo"),
    "skill-creator": ("crear una skill", "crea una skill", "modificar una skill"),
}
STOPWORDS = frozenset({
    "about", "agent", "agente", "agentes", "and", "con", "como", "create", "crear", "de", "del", "el", "en",
    "for", "from", "hacer", "la", "las", "los", "para", "por", "que", "skill", "skills", "the", "una", "uno",
    "use", "usar", "with", "workflow", "y",
})


@dataclass(frozen=True)
class AvailableSkill:
    name: str
    description: str
    installed_in: frozenset[str]
    stored_in: frozenset[str]


def _normalize(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c))


def _terms(value: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", _normalize(value)) if len(t) >= 3 and t not in STOPWORDS}


def discover_skills(home: Path | None = None) -> list[AvailableSkill]:
    """Read only frontmatter descriptions from active or rotator-stored skills."""
    home = home or Path.home()
    found: dict[str, dict] = {}
    for target, directory in (("claude", ".claude"), ("codex", ".codex"), ("agents", ".agents")):
        for stored, root in ((False, home / directory / "skills"), (True, home / ".karajan" / "skills-almacen" / target)):
            if not root.is_dir():
                continue
            for folder in root.iterdir():
                if not folder.is_dir() or folder.name.startswith((".", "_")) or folder.name.endswith(".disabled"):
                    continue
                skill_file = folder / "SKILL.md"
                if not skill_file.is_file():
                    continue
                key = folder.name.casefold()
                row = found.setdefault(key, {"name": folder.name, "description": "", "installed": set(), "stored": set()})
                row["stored" if stored else "installed"].add(target)
                if not row["description"]:
                    try:
                        header = skill_file.read_text(encoding="utf-8", errors="replace")[:4096]
                        match = re.search(r"^description:\s*(.+)$", header, re.MULTILINE)
                        row["description"] = match.group(1).strip().strip("\"'") if match else ""
                    except OSError:
                        pass
    return [AvailableSkill(v["name"], v["description"], frozenset(v["installed"]), frozenset(v["stored"])) for _, v in sorted(found.items())]


def select_skills(prompt: str, catalog: list[AvailableSkill], *, limit: int = 3) -> list[str]:
    """Favor explicit names and specific triggers; abstain on weak lexical overlap."""
    normalized = _normalize(prompt)
    query = _terms(prompt)
    scored: list[tuple[int, int, float, str]] = []
    for skill in catalog:
        name = skill.name
        slug = _normalize(name)
        explicit = re.search(rf"(?<![a-z0-9]){re.escape(slug)}(?![a-z0-9])", normalized)
        position = explicit.start() if explicit else len(normalized)
        if explicit:
            score = 100.0
        else:
            aliases = ALIASES.get(name, ())
            alias_hits = [a for a in aliases if re.search(rf"(?<![a-z0-9]){re.escape(_normalize(a))}(?![a-z0-9])", normalized)]
            for alias in alias_hits:
                hit = re.search(rf"(?<![a-z0-9]){re.escape(_normalize(alias))}(?![a-z0-9])", normalized)
                if hit:
                    position = min(position, hit.start())
            name_hits = query & _terms(name)
            description_hits = query & _terms(skill.description[:1000])
            score = (35.0 + min(10, len(alias_hits) * 2) if alias_hits else 0.0)
            score += len(name_hits) * 11.0 + len(description_hits) * 2.0
            if name.startswith("source-command-") and not alias_hits:
                score = 0.0  # command wrappers require an explicit request
        if score >= 15:
            phase = 0 if name == "repo-analyzer" else 2 if name == "security-review" else 1
            scored.append((phase, position, -score, name))
    scored.sort(key=lambda item: (item[0], item[1], item[2], item[3].casefold()))
    return [name for _, _, _, name in scored[:limit]]


def prepare_skills(names: list[str], provider: str, home: Path | None = None) -> list[str]:
    """Restore only selected skills for a CLI agent. A preparation is not usage."""
    target = {"codex": "codex", "claude-cli": "claude"}.get(provider)
    if target is None:
        return []
    home = home or Path.home()
    roots = {agent: home / directory / "skills" for agent, directory in
             (("codex", ".codex"), ("claude", ".claude"), ("agents", ".agents"))}
    archive = {agent: home / ".karajan" / "skills-almacen" / agent for agent in roots}
    prepared: list[str] = []
    for name in names:
        if name.startswith((".", "_")) or name.endswith(".disabled") or "/" in name or "\\" in name or ".." in name:
            continue
        destination = roots[target] / name
        if not (destination / "SKILL.md").is_file():
            source = next((root / name for root in [*archive.values(), *(p for key, p in roots.items() if key != target)]
                           if (root / name / "SKILL.md").is_file()), None)
            if source is None:
                continue
            try:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(source, destination, dirs_exist_ok=True)
            except OSError:
                continue
        if (destination / "SKILL.md").is_file():
            prepared.append(name)
    return prepared
