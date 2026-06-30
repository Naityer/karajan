"""Rate limiter demo — delegated across N1-N4 local workers.

sub_001 (N1, Qwen)       → models: Request, RatePolicy
sub_002 (N2, Qwen)       → SlidingWindowCounter
sub_003 (N3, DeepSeek)   → TokenBucket (Redis-compatible interface + TTL)
sub_004 (N4, MistralNemo) → PolicyEngine (routing by domain + priority)
"""
from __future__ import annotations

import time
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Literal


# ── sub_001 · N1 · Qwen local ──────────────────────────────────────────────

@dataclass
class Request:
    client_id: str
    domain: str
    priority: int = 1  # 1=normal, 2=high, 3=critical
    timestamp: float = field(default_factory=time.monotonic)


@dataclass
class RatePolicy:
    domain: str
    requests_per_second: float
    burst: int
    strict: bool = False  # if True, no burst tolerance


# ── sub_002 · N2 · Qwen local ──────────────────────────────────────────────

class SlidingWindowCounter:
    """Fixed sliding-window request counter."""

    def __init__(self, window_size: float, limit: int) -> None:
        self.window_size = window_size
        self.limit = limit
        self._timestamps: deque[float] = deque()
        self._lock = threading.Lock()

    def is_allowed(self) -> bool:
        now = time.monotonic()
        with self._lock:
            cutoff = now - self.window_size
            while self._timestamps and self._timestamps[0] < cutoff:
                self._timestamps.popleft()
            if len(self._timestamps) >= self.limit:
                return False
            self._timestamps.append(now)
            return True

    @property
    def current_count(self) -> int:
        now = time.monotonic()
        cutoff = now - self.window_size
        with self._lock:
            return sum(1 for t in self._timestamps if t >= cutoff)


# ── sub_003 · N3 · DeepSeek local ──────────────────────────────────────────

class TokenBucket:
    """Token bucket with Redis-compatible INCR/EXPIRE interface and TTL.

    Simulates atomic INCR + EXPIRE so the interface can swap to a real Redis
    client without changing the calling code.
    """

    def __init__(self, policy: RatePolicy) -> None:
        self._policy = policy
        self._tokens: float = float(policy.burst)
        self._last_refill: float = time.monotonic()
        self._lock = threading.Lock()
        self._expires_at: float | None = None

    # Redis-compatible surface
    def incr(self, key: str) -> int:  # noqa: ARG002
        """Consume one token. Returns remaining tokens (like Redis INCR inverse)."""
        with self._lock:
            self._refill()
            if self._tokens >= 1:
                self._tokens -= 1
                return int(self._tokens)
            return -1  # rate limited

    def expire(self, key: str, ttl: float) -> None:  # noqa: ARG002
        """Set TTL on this bucket (simulated Redis EXPIRE)."""
        with self._lock:
            self._expires_at = time.monotonic() + ttl

    @property
    def is_expired(self) -> bool:
        if self._expires_at is None:
            return False
        return time.monotonic() > self._expires_at

    def is_allowed(self) -> bool:
        result = self.incr("_")
        return result >= 0

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        refill = elapsed * self._policy.requests_per_second
        self._tokens = min(float(self._policy.burst), self._tokens + refill)
        self._last_refill = now


# ── sub_004 · N4 · Mistral Nemo local ──────────────────────────────────────

class PolicyEngine:
    """Routes requests to the right limiter based on domain and priority.

    High-priority requests bypass strict-mode policies.
    Unknown domains fall back to the default policy.
    """

    def __init__(self, policies: list[RatePolicy]) -> None:
        self._policies: dict[str, RatePolicy] = {p.domain: p for p in policies}
        self._buckets: dict[str, TokenBucket] = {}
        self._windows: dict[str, SlidingWindowCounter] = {}
        self._lock = threading.Lock()

    def allow(self, request: Request) -> tuple[bool, str]:
        """Return (allowed, reason)."""
        policy = self._policies.get(request.domain) or self._policies.get("default")
        if policy is None:
            return False, "no_policy_for_domain"

        # Critical priority bypasses strict mode
        if request.priority >= 3 and policy.strict:
            return True, "critical_priority_bypass"

        bucket = self._get_bucket(request.domain, policy)

        # Expired buckets reset
        if bucket.is_expired:
            with self._lock:
                self._buckets.pop(request.domain, None)
            bucket = self._get_bucket(request.domain, policy)

        allowed = bucket.is_allowed()
        reason = "ok" if allowed else f"rate_limited:{policy.domain}"
        return allowed, reason

    def _get_bucket(self, domain: str, policy: RatePolicy) -> TokenBucket:
        with self._lock:
            if domain not in self._buckets:
                self._buckets[domain] = TokenBucket(policy)
            return self._buckets[domain]

    def stats(self) -> dict[str, dict]:
        return {
            domain: {
                "tokens_remaining": round(b._tokens, 2),
                "expired": b.is_expired,
            }
            for domain, b in self._buckets.items()
        }
