"""API del módulo Configuration.

Configuración activa y el asistente de puesta en marcha (perfil por defecto, cola de despacho, tutorial).

Movida tal cual desde `app/main.py` (nota "Plan de mejora", §17): mismas
rutas, mismos modelos de respuesta, mismas guardas de autenticación. Lo
único que cambia es que el almacén y los servicios ya no son globals del
módulo `main` — se resuelven contra el runtime activo en cada petición.
"""

from __future__ import annotations

import logging

from app import (
    catalog,
    events,
    production_setup,
    setup_status,
)
from app.atlas_auth import require_atlas_token
from app.auth import require_token
from app.logging_config import log_event
from app.models import (
    CredentialStatus,
    DefaultConfigApplyResult,
    KarajanConfig,
    SetupStatus,
    SetupTutorial,
)
from app.tutorial import navigation_tutorial_markdown
from fastapi import (
    APIRouter,
    Depends,
)

from app import runtime as runtime_module
from app.logging_config import get_logger, log_event


logger = get_logger("api")
router = APIRouter(tags=["configuration"])


@router.get("/config", response_model=KarajanConfig)
def get_config() -> KarajanConfig:
    return runtime_module.current().config


@router.put("/config", response_model=KarajanConfig)
def update_config(new_config: KarajanConfig, _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)) -> KarajanConfig:
    saved = runtime_module.current().set_config(new_config)
    log_event(logger, logging.INFO, "config_updated", backend=new_config.backend.value, profile=new_config.profile.value)
    events.publish("config_changed")
    return saved


@router.post("/setup/apply-default", response_model=DefaultConfigApplyResult)
def apply_default_config(_: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)) -> DefaultConfigApplyResult:
    """Restore the reference production hierarchy (Claude / ChatGPT / Qwen+DeepSeek local)
    from data/production_baseline/ and report what's still missing to run real tasks.

    Backed by `app/production_setup.py`, the same module `scripts/setup_production.py`
    uses from the command line — this is its "apply from the GUI" entry point.
    """
    backups = production_setup.reset_config()
    runtime_module.current().reload_config()
    runtime_module.current().routing.load()

    required = production_setup.ollama_required_models()
    installed = production_setup.ollama_installed_models()
    missing_models = [model for model in required if model not in installed]

    creds: dict[str, CredentialStatus] = {}
    next_steps: list[str] = []
    for provider_name in production_setup.REQUIRED_API_PROVIDERS:
        status = production_setup.check_api_key(provider_name)
        creds[provider_name] = status
        if not status.ready:
            next_steps.append(f"Configura la credencial de {provider_name} en .env ({status.detail})")
    for model in missing_models:
        next_steps.append(f"ollama pull {model}")
    for provider_name in production_setup.CLOUD_PROVIDERS:
        provider = catalog.get_provider(provider_name)
        if provider is not None:
            models = ", ".join(dict.fromkeys(provider.tiers.values()))
            next_steps.append(
                f"Opcional (L1, requiere cuenta Ollama): {provider.login_command} y luego usa {models}"
            )

    log_event(logger, logging.INFO, "default_config_applied", backups=len(backups), missing_models=len(missing_models))
    return DefaultConfigApplyResult(
        ok=True,
        restored=["data/active_config.json", "data/routing_layout.json"],
        backups=backups,
        ollama_installed=[model for model in required if model in installed],
        ollama_missing=missing_models,
        credentials=creds,
        next_steps=next_steps,
    )


@router.post("/setup/apply-queue-config", response_model=DefaultConfigApplyResult)
def apply_queue_config(_: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)) -> DefaultConfigApplyResult:
    """Turn on the availability-driven queue + validator loop and make sure every
    tier (raíz/L1/L2) of the pyramidal hierarchy is present in the routing graph.

    Purely additive and idempotent: existing entities/customizations are never
    touched, only missing baseline hierarchy nodes get appended, and running
    this again when everything's already configured is a harmless no-op.
    """
    layout = runtime_module.current().routing.load()
    merged_layout, added_ids = production_setup.ensure_queue_hierarchy_entities(layout)
    if added_ids:
        runtime_module.current().routing.save(merged_layout)

    config = runtime_module.current().config
    config.orchestration.dispatch_mode = "queue"
    config.orchestration.enable_validator_loop = True
    runtime_module.current().set_config(config)

    required = production_setup.ollama_required_models()
    installed = production_setup.ollama_installed_models()
    missing_models = [model for model in required if model not in installed]

    next_steps: list[str] = [f"ollama pull {model}" for model in missing_models]
    for provider_name in production_setup.CLOUD_PROVIDERS:
        provider = catalog.get_provider(provider_name)
        if provider is not None:
            models = ", ".join(dict.fromkeys(provider.tiers.values()))
            next_steps.append(
                f"Opcional (L1, requiere cuenta Ollama): {provider.login_command} y luego usa {models}"
            )

    log_event(
        logger,
        logging.INFO,
        "queue_hierarchy_applied",
        added_entities=len(added_ids),
        missing_models=len(missing_models),
    )
    return DefaultConfigApplyResult(
        ok=True,
        restored=[f"routing-layout: +{len(added_ids)} agente(s) añadidos"] if added_ids else [],
        ollama_installed=[model for model in required if model in installed],
        ollama_missing=missing_models,
        next_steps=next_steps,
    )


# --- First-run setup (web overlay + terminal installer share this state) ----


@router.get("/setup/status", response_model=SetupStatus)
def setup_status_endpoint() -> SetupStatus:
    return SetupStatus(completed=setup_status.is_complete())


@router.post("/setup/complete", response_model=SetupStatus)
def setup_complete(_: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)) -> SetupStatus:
    """Mark first-run setup done (web overlay finished/skipped) and write the
    navigation tutorial doc — idempotent, safe to call again."""
    setup_status.mark_complete()
    return SetupStatus(completed=True)


@router.get("/setup/tutorial", response_model=SetupTutorial)
def setup_tutorial() -> SetupTutorial:
    """Not gated on completion — help must work regardless of onboarding state."""
    return SetupTutorial(markdown=navigation_tutorial_markdown())
