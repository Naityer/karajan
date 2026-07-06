"""Tests for the pure, disk-free helpers in scripts/setup_production.py.

Deliberately does NOT exercise reset_config()/prompt_reset_hierarchy()/main()
here — those touch real project paths (data/active_config.json,
data/routing_layout.json) derived from PROJECT_ROOT, and there's no clean way
to redirect them without changing the script's structure. The interactive
flow was verified manually against a real run instead; this file covers the
non-destructive logic that's safe to unit test.
"""

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import setup_production  # noqa: E402


def test_ask_yes_no_accepts_variants(monkeypatch) -> None:
    for word in ("s", "si", "sí", "y", "yes", "S", "YES"):
        monkeypatch.setattr("builtins.input", lambda _prompt, _w=word: _w)
        assert setup_production.ask_yes_no("¿?") is True

    for word in ("n", "no", "nope", "x"):
        monkeypatch.setattr("builtins.input", lambda _prompt, _w=word: _w)
        assert setup_production.ask_yes_no("¿?", default=True) is False


def test_ask_yes_no_uses_default_on_empty(monkeypatch) -> None:
    monkeypatch.setattr("builtins.input", lambda _prompt: "")
    assert setup_production.ask_yes_no("¿?", default=True) is True
    assert setup_production.ask_yes_no("¿?", default=False) is False


def test_ask_yes_no_uses_default_on_eof(monkeypatch) -> None:
    def raise_eof(_prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", raise_eof)
    assert setup_production.ask_yes_no("¿?", default=True) is True


def test_parse_index_selection() -> None:
    options = ["a", "b", "c"]
    assert setup_production._parse_index_selection("1,3", options) == ["a", "c"]
    assert setup_production._parse_index_selection("2", options) == ["b"]
    assert setup_production._parse_index_selection("9", options) == []  # out of range ignored
    assert setup_production._parse_index_selection("not-a-number", options) == []
