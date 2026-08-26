"""Composition root for embedded Karajan and its optional persistent host."""

from __future__ import annotations

import os
import threading
from contextlib import ExitStack
from pathlib import Path
from typing import Self

from app.application import KarajanApplication
from app.application_contracts import DomainEventPublisher
from app.runtime import KarajanRuntime, build_runtime


class StorageAlreadyOwnedError(RuntimeError):
    pass


class _ProcessFileLock:
    """OS-backed single-owner lock; ownership is released when the process dies."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._file = path.open("a+b")
        if self._file.tell() == 0:
            self._file.write(b"0")
            self._file.flush()
        try:
            if os.name == "nt":
                import msvcrt

                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._file.close()
            raise StorageAlreadyOwnedError(f"SQLite storage is already owned: {path}") from exc

    def close(self) -> None:
        if self._file.closed:
            return
        try:
            if os.name == "nt":
                import msvcrt

                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._file.close()


class KarajanContainer:
    def __init__(
        self,
        runtime: KarajanRuntime,
        application: KarajanApplication | None = None,
        *,
        stack: ExitStack | None = None,
    ) -> None:
        self._stack = stack or ExitStack()
        self.runtime = runtime
        self.application = application or runtime.application or KarajanApplication(runtime)
        runtime.application = self.application
        close = getattr(runtime.tasks, "close", None)
        if callable(close):
            self._stack.callback(close)

    @classmethod
    def build(
        cls,
        *,
        data_dir: Path | str,
        in_memory: bool = False,
    ) -> KarajanContainer:
        stack = ExitStack()
        path = Path(data_dir)
        if not in_memory:
            lock = _ProcessFileLock(path / ".karajan.sqlite.lock")
            stack.callback(lock.close)
        try:
            runtime = build_runtime(data_dir=path, in_memory=in_memory)
            return cls(runtime, stack=stack)
        except BaseException:
            stack.close()
            raise

    def close(self) -> None:
        self._stack.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()


class KarajanHost:
    """Optional host services. Construction has no scheduler/thread side effect."""

    def __init__(
        self,
        container: KarajanContainer,
        *,
        publisher: DomainEventPublisher | None = None,
        poll_interval: float = 0.5,
    ) -> None:
        self.container = container
        self.publisher = publisher
        self.poll_interval = poll_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self.publisher is None or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._dispatch_loop, daemon=True)
        self._thread.start()

    def _dispatch_loop(self) -> None:
        while not self._stop.wait(self.poll_interval):
            for event in self.container.runtime.tasks.list_pending_outbox():
                try:
                    self.publisher.publish(event)
                except Exception:  # noqa: BLE001 - delivery failure is recorded for retry
                    self.container.runtime.tasks.record_outbox_attempt(event["event_id"])
                else:
                    self.container.runtime.tasks.mark_outbox_delivered(event["event_id"])

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self.poll_interval * 2))
            self._thread = None

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()
