"""Tests de delegación — validan cada subtarea por nivel."""
from __future__ import annotations

import time
import threading

import pytest
from rate_limiter import PolicyEngine, RatePolicy, Request, SlidingWindowCounter, TokenBucket


# ── sub_001 · N1 ────────────────────────────────────────────────────────────

def test_request_fields():
    r = Request(client_id="u1", domain="api", priority=2)
    assert r.client_id == "u1"
    assert r.domain == "api"
    assert r.priority == 2
    assert r.timestamp > 0


def test_rate_policy_defaults():
    p = RatePolicy(domain="api", requests_per_second=10.0, burst=20)
    assert p.strict is False


# ── sub_002 · N2 ────────────────────────────────────────────────────────────

def test_sliding_window_allows_within_limit():
    sw = SlidingWindowCounter(window_size=1.0, limit=5)
    for _ in range(5):
        assert sw.is_allowed()


def test_sliding_window_blocks_over_limit():
    sw = SlidingWindowCounter(window_size=1.0, limit=3)
    for _ in range(3):
        sw.is_allowed()
    assert not sw.is_allowed()


def test_sliding_window_resets_after_expiry():
    sw = SlidingWindowCounter(window_size=0.1, limit=2)
    sw.is_allowed()
    sw.is_allowed()
    assert not sw.is_allowed()
    time.sleep(0.15)
    assert sw.is_allowed()


# ── sub_003 · N3 ────────────────────────────────────────────────────────────

def test_token_bucket_allows_burst():
    policy = RatePolicy(domain="api", requests_per_second=1.0, burst=5)
    tb = TokenBucket(policy)
    results = [tb.is_allowed() for _ in range(5)]
    assert all(results)


def test_token_bucket_blocks_after_burst():
    policy = RatePolicy(domain="api", requests_per_second=0.1, burst=2)
    tb = TokenBucket(policy)
    tb.is_allowed()
    tb.is_allowed()
    assert not tb.is_allowed()


def test_token_bucket_refills_over_time():
    policy = RatePolicy(domain="api", requests_per_second=10.0, burst=1)
    tb = TokenBucket(policy)
    assert tb.is_allowed()
    assert not tb.is_allowed()
    time.sleep(0.12)
    assert tb.is_allowed()


def test_token_bucket_ttl_expiry():
    policy = RatePolicy(domain="api", requests_per_second=1.0, burst=1)
    tb = TokenBucket(policy)
    tb.expire("key", ttl=0.05)
    time.sleep(0.1)
    assert tb.is_expired


def test_token_bucket_thread_safety():
    policy = RatePolicy(domain="api", requests_per_second=100.0, burst=50)
    tb = TokenBucket(policy)
    results = []

    def consume():
        for _ in range(10):
            results.append(tb.is_allowed())

    threads = [threading.Thread(target=consume) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    allowed = sum(results)
    assert allowed <= 50, f"Burst exceeded: {allowed} allowed"


# ── sub_004 · N4 ────────────────────────────────────────────────────────────

@pytest.fixture
def engine():
    return PolicyEngine([
        RatePolicy(domain="api", requests_per_second=10.0, burst=5),
        RatePolicy(domain="internal", requests_per_second=100.0, burst=50, strict=True),
        RatePolicy(domain="default", requests_per_second=2.0, burst=2),
    ])


def test_policy_engine_allows_known_domain(engine):
    r = Request(client_id="u1", domain="api", priority=1)
    allowed, reason = engine.allow(r)
    assert allowed
    assert reason == "ok"


def test_policy_engine_domains_are_independent(engine):
    for _ in range(5):
        engine.allow(Request(client_id="u1", domain="api", priority=1))

    # api exhausted, internal should still work
    blocked, reason = engine.allow(Request(client_id="u1", domain="api", priority=1))
    assert not blocked
    assert "rate_limited" in reason

    allowed, _ = engine.allow(Request(client_id="u1", domain="internal", priority=1))
    assert allowed


def test_policy_engine_strict_mode_blocks_normal(engine):
    for _ in range(50):
        engine.allow(Request(client_id="u1", domain="internal", priority=1))
    blocked, reason = engine.allow(Request(client_id="u1", domain="internal", priority=1))
    assert not blocked


def test_policy_engine_critical_bypasses_strict(engine):
    for _ in range(50):
        engine.allow(Request(client_id="u1", domain="internal", priority=1))
    allowed, reason = engine.allow(Request(client_id="u1", domain="internal", priority=3))
    assert allowed
    assert reason == "critical_priority_bypass"


def test_policy_engine_unknown_domain_fallback(engine):
    r = Request(client_id="u1", domain="unknown", priority=1)
    allowed, _ = engine.allow(r)
    assert allowed  # falls back to "default" policy


def test_policy_engine_no_policy_blocks(engine):
    empty = PolicyEngine([])
    r = Request(client_id="u1", domain="api", priority=1)
    allowed, reason = empty.allow(r)
    assert not allowed
    assert reason == "no_policy_for_domain"
