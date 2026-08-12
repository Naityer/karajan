from __future__ import annotations

import os
import re
import shutil
import subprocess
import ctypes
from pathlib import Path
from typing import Callable

from app.models import NaityerPreflight, ResourceOperationResult
from app.resource_library import ResourceStore


_REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_NAITYER_ROOT = Path(
    os.environ.get("KARAJAN_NAITYER_ROOT", str(_REPO_ROOT.parent / "naityer_setup"))
)
NAITYER_COMPONENTS = frozenset({
    "aider", "anthropic_skills", "browser_use", "bun", "dify", "dspy", "ecc",
    "emilkowalski_skills", "graphify", "gstack", "headroom", "impeccable",
    "llamaindex", "ponytail", "promptfoo", "scientific_agent_skills", "taste_skill",
})
_PREFLIGHT_COMMANDS: dict[str, tuple[str, ...]] = {
    "aider": ("py.exe",), "browser_use": ("py.exe",), "dspy": ("py.exe",),
    "headroom": ("py.exe",), "llamaindex": ("py.exe",), "dify": ("docker.exe",),
    "ecc": ("pnpm.exe",), "gstack": ("git.exe", "bash.exe"),
    "ponytail": ("codex.exe",), "promptfoo": ("npm.cmd",),
    "anthropic_skills": ("git.exe",), "emilkowalski_skills": ("git.exe",),
    "graphify": ("git.exe",), "impeccable": ("git.exe",),
    "scientific_agent_skills": ("git.exe",), "taste_skill": ("git.exe",),
}
_SECRET_OUTPUT_RE = re.compile(
    r"(?i)(authorization\s*:\s*bearer\s+)[^\s]+|"
    r"((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s]+"
)


def _sanitize_output(value: str) -> str:
    return _SECRET_OUTPUT_RE.sub(lambda match: (match.group(1) or match.group(2) or "") + "[REDACTED]", value)


class NaityerAdapter:
    """Narrow adapter around Naityer's official dispatcher.

    It accepts only fixed component keys and never evaluates a script supplied
    by the caller. Mutating operations also require an explicit confirmation.
    """

    def __init__(
        self,
        store: ResourceStore,
        *,
        root: Path | str = DEFAULT_NAITYER_ROOT,
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        require_admin: bool = True,
    ) -> None:
        self.store = store
        self.root = Path(root)
        self.runner = runner
        self.require_admin = require_admin

    def preflight(self, component: str) -> NaityerPreflight:
        allowed = component in NAITYER_COMPONENTS
        launcher = self.root / "scripts" / "Invoke-Setup.ps1"
        script = self.root / "scripts" / "installers" / "complementos_ia" / f"{component}.ps1"
        config = self.root / "config" / "setup.json"
        powershell = shutil.which("pwsh.exe") or shutil.which("powershell.exe")
        checks = {
            "allowlisted": allowed,
            "launcher_exists": launcher.is_file(),
            "component_script_exists": allowed and script.is_file(),
            "config_exists": config.is_file(),
            "powershell_available": bool(powershell),
            "administrator": (not self.require_admin) or _is_administrator(),
        }
        try:
            disk_root = self.root if self.root.exists() else self.root.parent
            checks["disk_space"] = shutil.disk_usage(disk_root).free >= 250 * 1024 * 1024
        except OSError:
            checks["disk_space"] = False
        for command in _PREFLIGHT_COMMANDS.get(component, ()):
            checks[f"command:{command}"] = bool(shutil.which(command))
        ready = all(checks.values())
        missing = [name for name, ok in checks.items() if not ok]
        return NaityerPreflight(
            component=component,
            allowed=allowed,
            ready=ready,
            launcher_path=str(launcher) if launcher.is_file() else None,
            script_path=str(script) if allowed and script.is_file() else None,
            powershell_path=powershell,
            checks=checks,
            detail="Ready" if ready else f"Preflight failed: {', '.join(missing)}",
        )

    def execute(
        self,
        component: str,
        action: str,
        *,
        confirmed: bool = False,
        resource_id: str | None = None,
        timeout_s: int = 900,
    ) -> ResourceOperationResult:
        if action not in {"install", "uninstall"}:
            return self.store.record_operation(
                resource_id=resource_id, action=f"naityer:{action}", status="denied",
                detail="Unsupported Naityer action", targets=["naityer"], metadata={"component": component},
            )
        if not confirmed:
            return self.store.record_operation(
                resource_id=resource_id, action=f"naityer:{action}", status="denied",
                detail="Explicit confirmation is required", targets=["naityer"], metadata={"component": component},
            )
        preflight = self.preflight(component)
        if not preflight.ready:
            return self.store.record_operation(
                resource_id=resource_id, action=f"naityer:{action}", status="failed",
                detail=preflight.detail, targets=["naityer"], metadata={"component": component, "checks": preflight.checks},
            )

        argv = [
            str(preflight.powershell_path), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(preflight.launcher_path), "-ConfigPath", str(self.root / "config" / "setup.json"),
            "-Only", component,
        ]
        if action == "uninstall":
            argv.append("-Uninstall")
        try:
            completed = self.runner(
                argv,
                cwd=self.root,
                capture_output=True,
                text=True,
                timeout=max(30, min(timeout_s, 3600)),
                check=False,
                shell=False,
                stdin=subprocess.DEVNULL,
            )
            ok = completed.returncode == 0
            output = _sanitize_output((completed.stdout or completed.stderr or "").strip())[-4000:]
            return self.store.record_operation(
                resource_id=resource_id,
                action=f"naityer:{action}",
                status="succeeded" if ok else "failed",
                detail=output or ("Completed" if ok else f"Naityer exited with {completed.returncode}"),
                targets=["naityer"],
                metadata={"component": component, "returncode": completed.returncode},
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return self.store.record_operation(
                resource_id=resource_id, action=f"naityer:{action}", status="failed", detail=str(exc),
                targets=["naityer"], metadata={"component": component},
            )


def _is_administrator() -> bool:
    if os.name != "nt":
        return hasattr(os, "geteuid") and os.geteuid() == 0
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False
