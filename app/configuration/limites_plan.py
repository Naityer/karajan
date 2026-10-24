"""Límites del plan de suscripción de los agentes (uso semanal de Claude y Codex).

Atlas dev los lee de las propias CLIs (`usoSinChat` / `usoCodexSinChat`) y los deja en un JSON
(`ATLAS_LIMITES_PLAN`, o `~/.atlas-dev/limites-plan.json`). Karajan solo lo lee: si Claude pasa del umbral
semanal (`KARAJAN_LIMITE_CLAUDE`, 50 % por defecto), lo que le tocaba va a Codex y queda anotado. Un dato de
más de dos horas no se usa (mejor no decidir con información vieja). El port de TypeScript (`atlas/src/limites.ts`)
hace lo mismo con el mismo fichero.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

MAX_EDAD = timedelta(hours=2)


def ruta() -> Path:
    explicita = os.environ.get("KARAJAN_LIMITES_PLAN") or os.environ.get("ATLAS_LIMITES_PLAN")
    if explicita:
        return Path(explicita)
    datos = os.environ.get("ATLAS_DEV_DATA")
    return Path(datos) / "limites-plan.json" if datos else Path.home() / ".atlas-dev" / "limites-plan.json"


def umbral_claude() -> float:
    try:
        return float(os.environ.get("KARAJAN_LIMITE_CLAUDE", "50"))
    except ValueError:
        return 50.0


def leer(ahora: datetime | None = None, fichero: Path | None = None) -> dict[str, Any] | None:
    try:
        datos = json.loads((fichero or ruta()).read_text(encoding="utf-8"))
        leido = datetime.fromisoformat(str(datos["leido"]).replace("Z", "+00:00"))
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if leido.tzinfo is None:
        leido = leido.replace(tzinfo=timezone.utc)
    if (ahora or datetime.now(timezone.utc)) - leido > MAX_EDAD:
        return None
    return datos


def claude_excedido(ahora: datetime | None = None, fichero: Path | None = None) -> float | None:
    """El % semanal de Claude si supera el umbral; `None` si no lo supera o no hay dato reciente."""
    datos = leer(ahora, fichero)
    try:
        pct = float(((datos or {}).get("claude") or {}).get("semanal"))
    except (TypeError, ValueError):
        return None
    return pct if pct > umbral_claude() else None
