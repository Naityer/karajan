"""Public management/observability service used by non-HTTP adapters."""

from __future__ import annotations

import os

from app import (
    KARAJAN_VERSION,
    agent_console,
    catalog,
    classifier,
    credentials,
    monitoring,
)
from app.application_services import domain_event
from app.models import DecisionLogEntry, KarajanConfig, RoutingLayout
from app.resource_activation import attach_resource_recommendations


class ManagementService:
    def __init__(self, runtime) -> None:
        self.runtime = runtime

    def health(self) -> dict:
        try:
            total, db_ok = self.runtime.tasks.count_tasks(), True
        except Exception:  # noqa: BLE001 - health must report a degraded dependency
            total, db_ok = 0, False
        return {
            "status": "ok" if db_ok else "degraded",
            "version": KARAJAN_VERSION,
            "backend": self.runtime.config.backend.value,
            "profile": self.runtime.config.profile.value,
            "auth_enabled": bool(os.environ.get("KARAJAN_TOKEN")),
            "db_ok": db_ok,
            "total_tasks": total,
        }

    def get_config(self) -> KarajanConfig:
        return self.runtime.config

    def put_config(self, config: KarajanConfig) -> KarajanConfig:
        return self.runtime.set_config(config)

    def get_routing_layout(self) -> RoutingLayout:
        return self.runtime.routing.load()

    def put_routing_layout(self, layout: RoutingLayout) -> RoutingLayout:
        return self.runtime.routing.save(layout)

    def list_catalog(self):
        return catalog.all_providers()

    def list_providers(self):
        return credentials.detect_all()

    def provider_setup(self, name: str):
        return credentials.guided_setup(name)

    def provider_run(self, name: str, slot: str):
        provider = catalog.get_provider(name)
        if provider is None:
            raise KeyError(name)
        return agent_console.run_provider_command(provider, slot)

    def metrics(self):
        return self.runtime.tasks.metrics()

    def agents_performance(self):
        return self.runtime.tasks.agent_performance()

    def search_tasks(self, query: str, limit: int = 20) -> dict:
        results = self.runtime.tasks.search_tasks(query, limit=limit)
        return {"query": query, "count": len(results), "results": results}

    def get_decisions(self, task_id: str):
        return self.runtime.tasks.list_decisions(task_id)

    def queue_status(self) -> dict:
        availability = {
            entity_id: {"in_flight": in_flight, "capacity": capacity}
            for entity_id, (in_flight, capacity) in self.runtime.scheduler.availability.snapshot().items()
        }
        return {"pending": self.runtime.scheduler.queue_depth(), "availability": availability}

    def ingest(self, payload: dict, *, correlation_id: str) -> object:
        classification = classifier.reconcile(
            payload, self.runtime.config, source="model:/karajan"
        )
        classification = attach_resource_recommendations(
            classification, self.runtime.resources, self.runtime.resource_ranking_engine
        )
        return self.runtime.tasks.save_classification(
            classification,
            monitoring.build_classify_decision(classification),
            outbox_events=[
                domain_event(
                    "TaskClassificationIngested",
                    classification.task_id,
                    correlation_id,
                )
            ],
        )

    def append_decision(self, task_id: str, entry: DecisionLogEntry) -> DecisionLogEntry:
        self.runtime.tasks.get_task(task_id)
        entry.task_id = task_id
        self.runtime.tasks.add_decisions([entry])
        return entry
