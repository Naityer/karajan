from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any

from app.models import (
    OpenClawChannelInfo,
    OpenClawDaemonStatus,
    OpenClawInstallRequest,
    OpenClawOperationResult,
    OpenClawPluginInfo,
    OpenClawSetupCommand,
    OpenClawSkillInfo,
    OpenClawStatus,
    OpenClawUpdateRequest,
    KarajanConfig,
)


DEFAULT_SETUP_SECTIONS = ("workspace", "model", "web", "channels", "plugins", "skills", "health")


@dataclass(frozen=True)
class CommandResult:
    ok: bool
    stdout: str = ""
    stderr: str = ""
    returncode: int = 0


class OpenClawClient:
    """Small CLI adapter so Karajan can use OpenClaw without vendoring it."""

    def __init__(self, config: KarajanConfig) -> None:
        self.config = config.openclaw

    def status(self) -> OpenClawStatus:
        cli_path = self._resolve_cli()
        if not self.config.enabled:
            return OpenClawStatus(
                enabled=False,
                cli_path=self.config.cli_path,
                cli_available=bool(cli_path),
                ready=False,
                detail="OpenClaw integration is disabled.",
                setup_commands=self.setup_commands(),
            )
        if not cli_path:
            return OpenClawStatus(
                enabled=True,
                cli_path=self.config.cli_path,
                cli_available=False,
                ready=False,
                detail="openclaw CLI was not found in PATH.",
                setup_commands=self.setup_commands(),
            )

        result = self._run(["gateway", "status", "--json"], timeout_s=12)
        payload, parse_error = _parse_json_object(result.stdout)
        version = _string(payload, "version") or _string(payload, "openclawVersion")
        gateway_status = _string(payload, "status") or _string(payload, "runtime") or _string(payload, "state")
        ready = result.ok and parse_error is None
        detail = "OpenClaw gateway responded." if ready else result.stderr or parse_error or "OpenClaw gateway status failed."
        return OpenClawStatus(
            enabled=True,
            cli_path=cli_path,
            cli_available=True,
            ready=ready,
            gateway_url=self.config.gateway_url,
            version=version,
            gateway_status=gateway_status,
            detail=_redact(detail),
            raw=payload or {},
            setup_commands=self.setup_commands(),
        )

    def skills(self) -> list[OpenClawSkillInfo]:
        if not self.config.enabled or not self._resolve_cli():
            return []
        result = self._run(["skills", "list", "--json"], timeout_s=20)
        payload, _ = _parse_json(result.stdout)
        return _normalize_skills(payload)

    def channels(self) -> list[OpenClawChannelInfo]:
        if not self.config.enabled or not self._resolve_cli():
            return []
        result = self._run(["gateway", "status", "--json"], timeout_s=12)
        payload, _ = _parse_json(result.stdout)
        return _normalize_channels(payload)

    def channel_catalog(self) -> list[OpenClawChannelInfo]:
        """Every channel type OpenClaw supports, not just the configured ones —
        lets the activation panel show "add WhatsApp" even before it's set up."""
        if not self.config.enabled or not self._resolve_cli():
            return []
        result = self._run(["channels", "list", "--json", "--all"], timeout_s=12)
        payload, _ = _parse_json(result.stdout)
        if isinstance(payload, list):
            payload = {"channels": payload}
        return _normalize_channels(payload)

    def daemon_status(self) -> OpenClawDaemonStatus:
        if not self.config.enabled or not self._resolve_cli():
            return OpenClawDaemonStatus(installed=False, running=False, detail="openclaw CLI was not found in PATH.")
        result = self._run(["daemon", "status", "--json"], timeout_s=10)
        payload, parse_error = _parse_json_object(result.stdout)
        installed = bool(payload.get("installed", result.ok))
        running = bool(payload.get("running") or payload.get("active"))
        detail = _string(payload, "detail") or result.stdout.strip() or result.stderr.strip() or parse_error or ""
        return OpenClawDaemonStatus(installed=installed, running=running, detail=_redact(detail))

    def plugins(self) -> list[OpenClawPluginInfo]:
        if not self.config.enabled or not self._resolve_cli():
            return []
        result = self._run(["plugins", "list", "--json"], timeout_s=15)
        payload, _ = _parse_json(result.stdout)
        return _normalize_plugins(payload)

    def install_plugin(self, spec: str, acknowledge_clawhub_risk: bool) -> OpenClawOperationResult:
        command = f"{self._display_cli()} plugins install {spec}"
        if not acknowledge_clawhub_risk:
            return OpenClawOperationResult(
                ok=False,
                command=command,
                detail="Debes confirmar que entiendes el riesgo de instalar un plugin de ClawHub.",
            )
        args = ["plugins", "install", spec, "--acknowledge-clawhub-risk"]
        return self._operation(args, timeout_s=90)

    def install_skill(self, request: OpenClawInstallRequest) -> OpenClawOperationResult:
        args = ["skills", "install", request.spec]
        if request.agent:
            args.extend(["--agent", request.agent])
        if request.global_install:
            args.append("--global")
        if request.force:
            args.append("--force")
        if request.acknowledge_clawhub_risk:
            args.append("--acknowledge-clawhub-risk")
        return self._operation(args, timeout_s=90)

    def update_skill(self, request: OpenClawUpdateRequest) -> OpenClawOperationResult:
        args = ["skills", "update"]
        if request.spec:
            args.append(request.spec)
        elif request.all:
            args.append("--all")
        else:
            return OpenClawOperationResult(ok=False, command="openclaw skills update", detail="Provide spec or all=true.")
        if request.agent:
            args.extend(["--agent", request.agent])
        if request.global_install:
            args.append("--global")
        if request.acknowledge_clawhub_risk:
            args.append("--acknowledge-clawhub-risk")
        return self._operation(args, timeout_s=90)

    def setup_commands(self) -> list[OpenClawSetupCommand]:
        return [
            OpenClawSetupCommand(
                section=section,
                command=f"{self._display_cli()} configure --section {section}",
                description=_setup_description(section),
            )
            for section in DEFAULT_SETUP_SECTIONS
        ]

    def _operation(self, args: list[str], timeout_s: int) -> OpenClawOperationResult:
        if not self.config.enabled:
            return OpenClawOperationResult(ok=False, command=f"{self._display_cli()} {' '.join(args)}", detail="OpenClaw integration is disabled.")
        if not self._resolve_cli():
            return OpenClawOperationResult(ok=False, command=f"{self._display_cli()} {' '.join(args)}", detail="openclaw CLI was not found in PATH.")
        result = self._run(args, timeout_s=timeout_s)
        return OpenClawOperationResult(
            ok=result.ok,
            command=f"{self._display_cli()} {' '.join(args)}",
            detail=_redact(result.stdout.strip() or result.stderr.strip() or ("ok" if result.ok else "command failed")),
            returncode=result.returncode,
        )

    def _run(self, args: list[str], timeout_s: int) -> CommandResult:
        cli_path = self._resolve_cli()
        if not cli_path:
            return CommandResult(ok=False, stderr="openclaw CLI was not found in PATH.", returncode=127)
        env = os.environ.copy()
        if self.config.auth_token_env and self.config.auth_token_env in os.environ:
            env[self.config.auth_token_env] = os.environ[self.config.auth_token_env]
        try:
            completed = subprocess.run(
                [cli_path, *args],
                capture_output=True,
                text=True,
                timeout=timeout_s,
                env=env,
                check=False,
            )
        except FileNotFoundError:
            return CommandResult(ok=False, stderr="openclaw CLI was not found in PATH.", returncode=127)
        except subprocess.TimeoutExpired as exc:
            return CommandResult(ok=False, stdout=exc.stdout or "", stderr="OpenClaw command timed out.", returncode=124)
        return CommandResult(
            ok=completed.returncode == 0,
            stdout=completed.stdout or "",
            stderr=_redact(completed.stderr or ""),
            returncode=completed.returncode,
        )

    def _resolve_cli(self) -> str | None:
        return shutil.which(self.config.cli_path)

    def _display_cli(self) -> str:
        return self.config.cli_path or "openclaw"


def _parse_json(raw: str) -> tuple[Any, str | None]:
    if not raw.strip():
        return None, "OpenClaw returned an empty response."
    try:
        return json.loads(raw), None
    except json.JSONDecodeError as exc:
        return None, f"OpenClaw returned invalid JSON: {exc.msg}"


def _parse_json_object(raw: str) -> tuple[dict[str, Any], str | None]:
    payload, error = _parse_json(raw)
    if isinstance(payload, dict):
        return payload, None
    return {}, error or "OpenClaw returned JSON that was not an object."


def _normalize_skills(payload: Any) -> list[OpenClawSkillInfo]:
    candidates = payload
    if isinstance(payload, dict):
        candidates = payload.get("skills") or payload.get("items") or payload.get("results") or []
    if not isinstance(candidates, list):
        return []
    skills: list[OpenClawSkillInfo] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        name = _string(item, "name") or _string(item, "id") or _string(item, "slug")
        if not name:
            continue
        skills.append(
            OpenClawSkillInfo(
                name=name,
                description=_string(item, "description") or _string(item, "summary") or "",
                installed=bool(item.get("installed", True)),
                source=_string(item, "source") or _string(item, "origin") or "openclaw",
                agent=_string(item, "agent") or _string(item, "agentId"),
                spec=_string(item, "spec") or _string(item, "ref"),
            )
        )
    return skills


def _normalize_channels(payload: Any) -> list[OpenClawChannelInfo]:
    if not isinstance(payload, dict):
        return []
    channel_payload = payload.get("channels") or payload.get("channelStatus") or payload.get("capabilities") or []
    if isinstance(channel_payload, dict):
        items = [{"id": key, **(value if isinstance(value, dict) else {"status": value})} for key, value in channel_payload.items()]
    elif isinstance(channel_payload, list):
        items = channel_payload
    else:
        return []
    channels: list[OpenClawChannelInfo] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        channel_id = _string(item, "id") or _string(item, "channel") or _string(item, "name")
        if not channel_id:
            continue
        status = _string(item, "status") or _string(item, "state") or "unknown"
        channels.append(
            OpenClawChannelInfo(
                id=channel_id,
                label=_string(item, "label") or channel_id,
                status=status,
                ready=status.lower() in {"ok", "ready", "running", "connected", "enabled"},
                detail=_redact(_string(item, "detail") or _string(item, "message") or ""),
            )
        )
    return channels


def _normalize_plugins(payload: Any) -> list[OpenClawPluginInfo]:
    candidates = payload
    if isinstance(payload, dict):
        candidates = payload.get("plugins") or payload.get("items") or []
    if not isinstance(candidates, list):
        return []
    plugins: list[OpenClawPluginInfo] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        name = _string(item, "name") or _string(item, "id")
        if not name:
            continue
        plugins.append(
            OpenClawPluginInfo(
                name=name,
                description=_string(item, "description") or "",
                installed=bool(item.get("installed", False)),
                spec=_string(item, "spec") or _string(item, "ref"),
            )
        )
    return plugins


def _setup_description(section: str) -> str:
    return {
        "workspace": "Elige el directorio de trabajo y el perfil de espacio de OpenClaw.",
        "model": "Configura proveedores, login y modelos disponibles en OpenClaw.",
        "web": "Configura acceso web (búsqueda, herramientas de navegador) si aplica.",
        "channels": "Añade o repara canales como Slack, WhatsApp, Telegram o Discord.",
        "plugins": "Instala plugins de OpenClaw sin acoplarlos al código de Karajan.",
        "skills": "Instala y revisa skills visibles para los agentes de OpenClaw.",
        "health": "Ejecuta comprobaciones de salud y diagnóstico guiado.",
    }.get(section, "Abre un flujo guiado de OpenClaw.")


def _string(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _redact(value: str) -> str:
    redacted = value
    for key, secret in os.environ.items():
        if not secret or len(secret) < 8:
            continue
        upper = key.upper()
        if "TOKEN" in upper or "KEY" in upper or "SECRET" in upper or "PASSWORD" in upper:
            redacted = redacted.replace(secret, "[redacted]")
    return redacted
