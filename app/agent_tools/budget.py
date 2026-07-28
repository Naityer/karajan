"""Per-session budgets.

Exhausting a budget is a **clean terminal state**, never an exception: the
partial transcript still becomes the subtask output and a `budget_exhausted`
event still lands in the trace. A loop that dies mid-flight leaves the operator
with nothing to look at, which is the failure mode this whole layer exists to
remove.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class BudgetState:
    turns: int = 0
    tool_calls: int = 0
    commands: int = 0
    files_written: int = 0
    bytes_read: int = 0
    bytes_written: int = 0
    cost_usd: float = 0.0
    started_at: float = field(default_factory=time.monotonic)

    def elapsed_s(self) -> float:
        return time.monotonic() - self.started_at


@dataclass
class RunBudget:
    max_turns: int = 12
    max_tool_calls: int = 24
    max_commands: int = 10
    max_files_written: int = 20
    max_bytes_read: int = 2_000_000
    max_bytes_written: int = 512_000
    max_wall_time_s: int = 900
    max_cost_usd: float = 0.0  # 0 disables the check
    state: BudgetState = field(default_factory=BudgetState)

    # ── checks ──────────────────────────────────────────────────────────────
    def exhausted(self) -> str | None:
        """Reason the session must stop, or None. Checked before every turn."""
        if self.state.turns >= self.max_turns:
            return f"limite de turnos alcanzado ({self.max_turns})"
        if self.state.tool_calls >= self.max_tool_calls:
            return f"limite de llamadas a herramientas alcanzado ({self.max_tool_calls})"
        if self.state.elapsed_s() >= self.max_wall_time_s:
            return f"limite de tiempo alcanzado ({self.max_wall_time_s}s)"
        if self.max_cost_usd and self.state.cost_usd >= self.max_cost_usd:
            return f"limite de coste alcanzado ({self.state.cost_usd:.5f} >= {self.max_cost_usd} USD)"
        return None

    def refuses(self, tool_name: str, *, bytes_out: int = 0) -> str | None:
        """Reason this specific call is refused, or None.

        Distinct from `exhausted`: this stops one call, not the session, so the
        model gets an observation and can choose something cheaper.
        """
        if tool_name == "run_command" and self.state.commands >= self.max_commands:
            return f"limite de comandos alcanzado ({self.max_commands})"
        if tool_name in {"write_file", "edit_file"}:
            if self.state.files_written >= self.max_files_written:
                return f"limite de archivos escritos alcanzado ({self.max_files_written})"
            if self.state.bytes_written + bytes_out > self.max_bytes_written:
                return (
                    f"limite de bytes escritos alcanzado "
                    f"({self.state.bytes_written}+{bytes_out} > {self.max_bytes_written})"
                )
        if self.state.bytes_read >= self.max_bytes_read:
            return f"limite de bytes leidos alcanzado ({self.max_bytes_read})"
        return None

    # ── accounting ──────────────────────────────────────────────────────────
    def record_turn(self) -> None:
        self.state.turns += 1

    def record_cost(self, usd: float) -> None:
        self.state.cost_usd += max(0.0, usd)

    def record_call(self, tool_name: str, *, bytes_read: int = 0, bytes_written: int = 0) -> None:
        self.state.tool_calls += 1
        self.state.bytes_read += bytes_read
        self.state.bytes_written += bytes_written
        if tool_name == "run_command":
            self.state.commands += 1
        if bytes_written:
            self.state.files_written += 1

    def remaining_summary(self) -> str:
        """Rendered into the system prompt every turn. Measurably reduces
        dithering on small models — they stop exploring once they can see the
        budget shrinking."""
        return (
            f"turnos restantes: {max(0, self.max_turns - self.state.turns)} · "
            f"llamadas restantes: {max(0, self.max_tool_calls - self.state.tool_calls)}"
        )

    def snapshot(self) -> dict:
        return {
            "turns": self.state.turns,
            "max_turns": self.max_turns,
            "tool_calls": self.state.tool_calls,
            "max_tool_calls": self.max_tool_calls,
            "commands": self.state.commands,
            "files_written": self.state.files_written,
            "bytes_read": self.state.bytes_read,
            "bytes_written": self.state.bytes_written,
            "cost_usd": round(self.state.cost_usd, 6),
            "elapsed_s": round(self.state.elapsed_s(), 3),
        }
