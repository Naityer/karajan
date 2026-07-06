from __future__ import annotations

import asyncio
import itertools
import logging
from dataclasses import dataclass, field
from typing import Any

from app import delegation
from app import flow_policy
from app.logging_config import get_logger, log_event
from app.models import (
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    KarajanConfig,
    RoutingEntity,
    RoutingLayout,
    Subtask,
    TaskStatus,
)
from app.providers.registry import candidate_tiers, eligible_entities, resolve_entity

logger = get_logger("scheduler")

_PRIORITY_RANK = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
_WAIT_POLL_TIMEOUT_S = 5.0


class AvailabilityTracker:
    """Live busy/free bookkeeping per routing-layout entity.

    Distinct from `app.credentials` readiness (installed/configured) — this is
    "is this specific agent mid-task right now," the signal a real queue needs
    to decide whether to hand it more work.
    """

    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._in_flight: dict[str, int] = {}
        self._capacity: dict[str, int] = {}

    async def try_acquire(self, entity: RoutingEntity) -> bool:
        async with self._condition:
            capacity = max(1, entity.max_concurrent)
            in_flight = self._in_flight.get(entity.id, 0)
            if in_flight >= capacity:
                self._capacity[entity.id] = capacity
                return False
            self._in_flight[entity.id] = in_flight + 1
            self._capacity[entity.id] = capacity
            return True

    async def release(self, entity_id: str) -> None:
        async with self._condition:
            self._in_flight[entity_id] = max(0, self._in_flight.get(entity_id, 1) - 1)
            self._condition.notify_all()

    async def wait_for_change(self, timeout: float = _WAIT_POLL_TIMEOUT_S) -> None:
        async with self._condition:
            try:
                await asyncio.wait_for(self._condition.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                pass

    def snapshot(self) -> dict[str, tuple[int, int]]:
        """entity_id -> (in_flight, capacity), for dashboard/observability."""
        return {
            entity_id: (self._in_flight.get(entity_id, 0), capacity)
            for entity_id, capacity in self._capacity.items()
        }


@dataclass(order=True)
class QueueItem:
    priority: int
    sequence: int
    task_id: str = field(compare=False)
    subtask: Subtask = field(compare=False)
    index: int = field(compare=False)
    classification: ClassificationResult = field(compare=False)
    config: KarajanConfig = field(compare=False)
    layout: RoutingLayout | None = field(compare=False)


class TaskScheduler:
    """Async, availability-driven dispatcher.

    Priority only decides queue position — an agent is never handed a task
    until it's actually free. When every eligible agent at the best tier for a
    level is busy, dispatch escalates to the next eligible tier (logged), and
    when nothing is free anywhere it waits without blocking other queued work.
    Opt-in via `KarajanConfig.orchestration.dispatch_mode == "queue"`; the
    synchronous `delegation.delegate()` path is untouched.
    """

    def __init__(self, store: Any | None = None) -> None:
        self._queue: asyncio.PriorityQueue[QueueItem] = asyncio.PriorityQueue()
        self._sequence = itertools.count()
        self.availability = AvailabilityTracker()
        self._store = store
        self._pending: dict[str, dict[str, Any]] = {}
        self._waiting_logged: set[str] = set()
        self._task: asyncio.Task | None = None
        self._stopping = False

    def start(self) -> None:
        if self._task is None:
            self._stopping = False
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def queue_depth(self) -> int:
        return self._queue.qsize()

    async def enqueue(
        self,
        classification: ClassificationResult,
        config: KarajanConfig,
        layout: RoutingLayout | None,
    ) -> None:
        subtasks = classification.subtasks
        self._pending[classification.task_id] = {
            "executions": [None] * len(subtasks),
            "decisions": [],
            "remaining": len(subtasks),
        }
        for index, subtask in enumerate(subtasks, start=1):
            priority_label = flow_policy.priority_for(classification, subtask)
            item = QueueItem(
                priority=_PRIORITY_RANK.get(priority_label, 3),
                sequence=next(self._sequence),
                task_id=classification.task_id,
                subtask=subtask,
                index=index,
                classification=classification,
                config=config,
                layout=layout,
            )
            self._pending[classification.task_id]["decisions"].append(
                DecisionLogEntry(
                    task_id=classification.task_id,
                    phase="queue",
                    decision=f"{subtask.id}:queued;priority={priority_label}",
                    score=float(subtask.complexity),
                    reason="Enqueued for availability-driven dispatch.",
                )
            )
            await self._queue.put(item)

    async def _run(self) -> None:
        while True:
            item = await self._queue.get()
            try:
                await self._dispatch(item)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep the dispatcher alive across bad items
                logger.exception("scheduler_dispatch_failed task_id=%s subtask=%s", item.task_id, item.subtask.id)
            finally:
                self._queue.task_done()

    async def _dispatch(self, item: QueueItem) -> None:
        level = flow_policy.level_for_complexity(item.subtask.complexity)
        entities = eligible_entities(level, item.layout)

        if not entities:
            # No layout-graph entity covers this level — degrade to the static
            # tier-pinned resolver so the task still completes.
            asyncio.create_task(self._execute_static(item))
            return

        tiers = candidate_tiers(entities)
        best_tier = tiers[0]
        for tier_value in tiers:
            for entity in (e for e in entities if e.tier == tier_value):
                if await self.availability.try_acquire(entity):
                    if tier_value != best_tier:
                        self._log(
                            item,
                            "escalate",
                            f"{item.subtask.id}:escalate;from_tier={best_tier};to_tier={tier_value};to={entity.id}",
                            "Best tier was fully busy; escalated to the next eligible tier.",
                        )
                    key = f"{item.task_id}:{item.subtask.id}"
                    self._waiting_logged.discard(key)
                    asyncio.create_task(self._execute(item, entity))
                    return

        key = f"{item.task_id}:{item.subtask.id}"
        if key not in self._waiting_logged:
            self._waiting_logged.add(key)
            self._log(
                item,
                "wait",
                f"{item.subtask.id}:waiting;checked_tiers={tiers}",
                "No eligible agent is free right now; will retry as capacity frees up.",
            )
        asyncio.create_task(self._await_and_requeue(item))

    async def _await_and_requeue(self, item: QueueItem) -> None:
        await self.availability.wait_for_change()
        await self._queue.put(item)

    async def _execute(self, item: QueueItem, entity: RoutingEntity) -> None:
        try:
            resolution = resolve_entity(entity, item.subtask.recommended_model)
            if resolution is None:
                # Entity can't actually serve this tier after all — release and retry elsewhere.
                asyncio.create_task(self._await_and_requeue(item))
                return
            subtask_execution, decisions = await asyncio.to_thread(
                delegation.run_subtask,
                item.classification,
                item.index,
                item.subtask,
                item.config,
                item.layout,
                resolution,
            )
            self._record_completion(item, subtask_execution, decisions)
        finally:
            await self.availability.release(entity.id)

    async def _execute_static(self, item: QueueItem) -> None:
        subtask_execution, decisions = await asyncio.to_thread(
            delegation.run_subtask,
            item.classification,
            item.index,
            item.subtask,
            item.config,
            item.layout,
            None,
        )
        self._record_completion(item, subtask_execution, decisions)

    def _log(self, item: QueueItem, phase: str, decision: str, reason: str) -> None:
        entry = DecisionLogEntry(
            task_id=item.task_id,
            phase=phase,
            decision=decision,
            score=float(item.subtask.complexity),
            reason=reason,
        )
        pending = self._pending.get(item.task_id)
        if pending is not None:
            pending["decisions"].append(entry)
        if self._store is not None:
            self._store.add_decisions([entry])

    def _record_completion(self, item: QueueItem, subtask_execution, decisions: list[DecisionLogEntry]) -> None:
        pending = self._pending.get(item.task_id)
        if pending is None:
            return
        pending["executions"][item.index - 1] = subtask_execution
        pending["decisions"].extend(decisions)
        pending["remaining"] -= 1
        if self._store is not None:
            self._store.add_decisions(decisions)
        if pending["remaining"] <= 0:
            self._finalize(item.task_id, item.classification)

    def _finalize(self, task_id: str, classification: ClassificationResult) -> None:
        pending = self._pending.pop(task_id, None)
        if pending is None:
            return
        executions = [e for e in pending["executions"] if e is not None]
        overall = TaskStatus.FAILED if any(e.status == TaskStatus.FAILED for e in executions) else TaskStatus.COMPLETED
        result = DelegationResult(
            task_id=task_id,
            status=overall,
            executions=executions,
            total_latency_ms=sum(e.latency_ms for e in executions),
            total_estimated_cost_usd=round(sum(e.estimated_cost_usd for e in executions), 5),
            total_input_tokens=sum(e.input_tokens for e in executions),
            total_output_tokens=sum(e.output_tokens for e in executions),
        )
        log_event(logger, logging.INFO, "queue_task_completed", task_id=task_id, status=overall.value)
        if self._store is not None:
            self._store.save_delegation(result)
