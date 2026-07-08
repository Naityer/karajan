"""In-process Server-Sent Events bus for live dashboard reactivity.

A tiny async pub/sub so the backend can push "something changed" signals to any
open dashboard/iframe, which then refreshes the affected view instantly instead
of waiting for the fallback poll. No external dependencies, no persistence — it
only fans small JSON events (`{"type": ..., ...}`) out to connected clients.

Thread-safety: state-changing routes here are sync `def` handlers, so FastAPI
runs them in a worker thread. `asyncio.Queue` is *not* thread-safe, so `publish`
hops back onto the main event loop via `call_soon_threadsafe` before touching any
queue. The loop reference is set once from the app lifespan.
"""

from __future__ import annotations

import asyncio
from typing import Any

# Bounded so a stalled/slow client can never grow memory without limit; when a
# client's queue fills we drop it (it will reconnect and re-fetch fresh state).
_QUEUE_MAXSIZE = 200

_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
_loop: asyncio.AbstractEventLoop | None = None


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Record the main event loop (called once from the app lifespan)."""
    global _loop
    _loop = loop


def subscribe() -> asyncio.Queue[dict[str, Any]]:
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue[dict[str, Any]]) -> None:
    _subscribers.discard(q)


def subscriber_count() -> int:
    return len(_subscribers)


def publish(event_type: str, **data: Any) -> None:
    """Fan a small event out to every connected client (best-effort, non-blocking).

    Safe to call from a sync route running in a worker thread: the actual queue
    writes are marshalled onto the event loop. A no-op if the loop isn't running
    yet or there are no subscribers.
    """
    if _loop is None:
        return
    payload: dict[str, Any] = {"type": event_type, **data}

    def _fan() -> None:
        dead: list[asyncio.Queue[dict[str, Any]]] = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            _subscribers.discard(q)

    try:
        _loop.call_soon_threadsafe(_fan)
    except RuntimeError:
        # Loop already closed (shutdown); nothing to deliver to.
        pass
