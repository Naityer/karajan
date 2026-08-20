"""API del módulo Agents.

Catálogo de proveedores/modelos, herramientas de agente, skills instalables e integración con OpenClaw.

Movida tal cual desde `app/main.py` (nota "Plan de mejora", §17): mismas
rutas, mismos modelos de respuesta, mismas guardas de autenticación. Lo
único que cambia es que el almacén y los servicios ya no son globals del
módulo `main` — se resuelven contra el runtime activo en cada petición.
"""

from __future__ import annotations

from app import (
    agent_console,
    agent_tools,
    catalog,
    credentials,
    events,
    openclaw_client,
    resource_library,
    skills_catalog,
)
from app.atlas_auth import require_atlas_token
from app.auth import require_token
from app.models import (
    CredentialStatus,
    OpenClawChannelInfo,
    OpenClawDaemonStatus,
    OpenClawInstallRequest,
    OpenClawOperationResult,
    OpenClawPluginInfo,
    OpenClawPluginInstallRequest,
    OpenClawSetupCommand,
    OpenClawSkillInfo,
    OpenClawStatus,
    OpenClawUpdateRequest,
    ProviderInfo,
    ProviderRunRequest,
    ProviderRunResult,
    ProviderSetup,
    ResourceKind,
    SkillInfo,
    SkillInstallResult,
    ToolParamInfo,
    ToolProfileInfo,
    ToolSpecInfo,
)
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
)

from app import runtime as runtime_module


router = APIRouter(tags=["agents"])


@router.get("/catalog", response_model=list[ProviderInfo])
def get_catalog() -> list[ProviderInfo]:
    return catalog.all_providers()


@router.get("/agent-tools", response_model=list[ToolSpecInfo])
def agent_tools_catalog() -> list[ToolSpecInfo]:
    """The agent tool catalog, as data — the `/catalog` of tools."""
    return [
        ToolSpecInfo(
            name=tool.name,
            summary=tool.summary,
            params=[
                ToolParamInfo(
                    name=param.name,
                    type=param.type,
                    required=param.required,
                    default=param.default,
                    description=param.description,
                )
                for param in tool.params
            ],
            returns=tool.returns,
            risk=tool.risk.value,
            terminal=tool.terminal,
            failure_modes=list(tool.failure_modes),
            example=tool.example,
        )
        for tool in agent_tools.catalog.all_tools()
    ]


@router.get("/agent-tools/profiles", response_model=list[ToolProfileInfo])
def agent_tool_profiles() -> list[ToolProfileInfo]:
    """Permission sets and the highest risk each one can reach."""
    return [
        ToolProfileInfo(
            name=name,
            tools=[tool.name for tool in agent_tools.catalog.tools_for_profile(name)],
            max_risk=agent_tools.catalog.max_risk(name).value,
            terminal_tools=agent_tools.catalog.terminal_tools(name),
        )
        for name in agent_tools.catalog.profile_names()
    ]


@router.get("/skills", response_model=list[SkillInfo])
def list_skills() -> list[SkillInfo]:
    return [
        SkillInfo(
            name=item.slug,
            description=item.summary,
            installed=item.status == "installed" or bool(item.installations),
            recommended=item.status == "installed" or bool(item.installations),
            applies_to=item.compatible_runtimes,
            install_command=None if item.status == "installed" else f"karajan resources install {item.slug}",
            repo_url=item.repo_url,
        )
        for item in runtime_module.current().resources.list_resources(kind=ResourceKind.SKILL, limit=500)
    ]


@router.post("/skills/{name}/install", response_model=SkillInstallResult)
def install_skill(name: str, _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)) -> SkillInstallResult:
    result = skills_catalog.install_skill(name)
    resource_library.seed_resource_library(runtime_module.current().resources)
    events.publish("resource_changed")
    return result


@router.get("/integrations/openclaw/status", response_model=OpenClawStatus)
def openclaw_status() -> OpenClawStatus:
    return openclaw_client.OpenClawClient(runtime_module.current().config).status()


@router.get("/integrations/openclaw/skills", response_model=list[OpenClawSkillInfo])
def openclaw_skills() -> list[OpenClawSkillInfo]:
    return openclaw_client.OpenClawClient(runtime_module.current().config).skills()


@router.post("/integrations/openclaw/skills/install", response_model=OpenClawOperationResult)
def openclaw_install_skill(
    request: OpenClawInstallRequest,
    _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token),
) -> OpenClawOperationResult:
    return openclaw_client.OpenClawClient(runtime_module.current().config).install_skill(request)


@router.post("/integrations/openclaw/skills/update", response_model=OpenClawOperationResult)
def openclaw_update_skill(
    request: OpenClawUpdateRequest,
    _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token),
) -> OpenClawOperationResult:
    return openclaw_client.OpenClawClient(runtime_module.current().config).update_skill(request)


@router.get("/integrations/openclaw/channels", response_model=list[OpenClawChannelInfo])
def openclaw_channels() -> list[OpenClawChannelInfo]:
    return openclaw_client.OpenClawClient(runtime_module.current().config).channels()


@router.get("/integrations/openclaw/setup-commands", response_model=list[OpenClawSetupCommand])
def openclaw_setup_commands() -> list[OpenClawSetupCommand]:
    return openclaw_client.OpenClawClient(runtime_module.current().config).setup_commands()


@router.get("/integrations/openclaw/channels/catalog", response_model=list[OpenClawChannelInfo])
def openclaw_channel_catalog() -> list[OpenClawChannelInfo]:
    return openclaw_client.OpenClawClient(runtime_module.current().config).channel_catalog()


@router.get("/integrations/openclaw/daemon-status", response_model=OpenClawDaemonStatus)
def openclaw_daemon_status() -> OpenClawDaemonStatus:
    return openclaw_client.OpenClawClient(runtime_module.current().config).daemon_status()


@router.get("/integrations/openclaw/plugins", response_model=list[OpenClawPluginInfo])
def openclaw_plugins() -> list[OpenClawPluginInfo]:
    return openclaw_client.OpenClawClient(runtime_module.current().config).plugins()


@router.post("/integrations/openclaw/plugins/install", response_model=OpenClawOperationResult)
def openclaw_install_plugin(
    request: OpenClawPluginInstallRequest,
    _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token),
) -> OpenClawOperationResult:
    return openclaw_client.OpenClawClient(runtime_module.current().config).install_plugin(request.spec, request.acknowledge_clawhub_risk)


@router.get("/providers", response_model=list[CredentialStatus])
def list_providers() -> list[CredentialStatus]:
    return credentials.detect_all()


@router.get("/providers/{name}/setup", response_model=ProviderSetup)
def provider_setup(name: str) -> ProviderSetup:
    setup = credentials.guided_setup(name)
    if setup is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return setup


@router.post("/providers/{name}/run", response_model=ProviderRunResult)
def provider_run(name: str, request: ProviderRunRequest, _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)) -> ProviderRunResult:
    """Run a provider's catalog-defined login/probe command for the Agentes console.

    Only `login_command`/`probe_command` from the static catalog can run — see
    `app/agent_console.py` for why this can't become arbitrary command execution.
    """
    provider = catalog.get_provider(name)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return agent_console.run_provider_command(provider, request.slot)
