"""Executors: the happy path and *every declared failure mode*, plus dry-run.

The failure modes matter more than the successes here. They are what the model
reads when it gets something wrong, and a tool whose error message says nothing
actionable turns a recoverable mistake into a wasted session.
"""

import os
from pathlib import Path

import pytest

from app.agent_tools import catalog, dispatch
from app.agent_tools.budget import RunBudget
from app.agent_tools.workspace import Workspace


@pytest.fixture
def ws(tmp_path: Path) -> Workspace:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text(
        "def foo():\n    pass\n\n\ndef bar():\n    return 2\n", encoding="utf-8"
    )
    (tmp_path / "README.md").write_text("# Demo\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "junk.js").write_text("const foo = 1;\n", encoding="utf-8")
    return Workspace.open(tmp_path)


def call(ws: Workspace, name: str, /, profile: str = "build", **params):
    return dispatch(name, params, ws, profile=profile)


# ── list_dir ────────────────────────────────────────────────────────────────
def test_list_dir_lists_and_elides_noise(ws: Workspace) -> None:
    result = call(ws, "list_dir", depth=2)
    assert result.ok
    assert "src/" in result.observation and "app.py" in result.observation
    assert "node_modules/ (omitido)" in result.observation


def test_list_dir_not_found(ws: Workspace) -> None:
    result = call(ws, "list_dir", path="nope")
    assert not result.ok and result.error_code == "not_found"


def test_list_dir_on_a_file_is_bad_params(ws: Workspace) -> None:
    result = call(ws, "list_dir", path="README.md")
    assert not result.ok and result.error_code == "bad_params"


def test_list_dir_outside_workspace(ws: Workspace) -> None:
    result = call(ws, "list_dir", path="../..")
    assert not result.ok and result.error_code == "outside_workspace"


# ── read_file ───────────────────────────────────────────────────────────────
def test_read_file_numbers_lines(ws: Workspace) -> None:
    result = call(ws, "read_file", path="src/app.py")
    assert result.ok
    assert "    1| def foo():" in result.observation
    assert result.bytes_read > 0


def test_read_file_windows_and_signals_the_remainder(ws: Workspace) -> None:
    result = call(ws, "read_file", path="src/app.py", start_line=1, max_lines=2)
    assert result.ok
    assert "[truncado: 4 lineas mas; sigue con start_line=3]" in result.observation


def test_read_file_out_of_range_start_line(ws: Workspace) -> None:
    result = call(ws, "read_file", path="src/app.py", start_line=999)
    assert not result.ok and result.error_code == "bad_params"
    assert "6 lineas" in result.observation


def test_read_file_refuses_a_secret(ws: Workspace) -> None:
    (ws.root / ".env").write_text("TOKEN=abc\n", encoding="utf-8")
    result = call(ws, "read_file", path=".env")
    assert not result.ok and result.error_code == "denied"


def test_read_file_refuses_binary(ws: Workspace) -> None:
    (ws.root / "blob.bin").write_bytes(b"\x00\x01\x02binary")
    result = call(ws, "read_file", path="blob.bin")
    assert not result.ok and result.error_code == "bad_params"


# ── search / find_files ─────────────────────────────────────────────────────
def test_search_finds_matches_and_skips_noise(ws: Workspace) -> None:
    result = call(ws, "search", pattern="foo")
    assert result.ok
    assert "src/app.py:1:" in result.observation
    assert "node_modules" not in result.observation


def test_search_reports_no_matches_as_success(ws: Workspace) -> None:
    """"Nothing found" is information, not an error."""
    result = call(ws, "search", pattern="zzz-not-here")
    assert result.ok and result.data["matches"] == 0


def test_search_rejects_a_broken_regex(ws: Workspace) -> None:
    result = call(ws, "search", pattern="(unclosed", regex=True)
    assert not result.ok and result.error_code == "bad_params"


def test_search_treats_the_pattern_as_literal_by_default(ws: Workspace) -> None:
    """`foo(` is an invalid regex; as a literal it matches `def foo():`."""
    result = call(ws, "search", pattern="foo(")
    assert result.ok and result.data["matches"] == 1
    assert "def foo():" in result.observation


def test_find_files_matches_a_glob(ws: Workspace) -> None:
    result = call(ws, "find_files", glob="**/*.py")
    assert result.ok and "src/app.py" in result.observation


def test_find_files_rejects_an_absolute_pattern(ws: Workspace) -> None:
    result = call(ws, "find_files", glob="/etc/*")
    assert not result.ok and result.error_code == "outside_workspace"


# ── write_file ──────────────────────────────────────────────────────────────
def test_write_file_creates_parents_and_records_an_artifact(ws: Workspace) -> None:
    result = call(ws, "write_file", path="docs/deep/notes.md", content="hola\n")
    assert result.ok
    assert (ws.root / "docs" / "deep" / "notes.md").read_text(encoding="utf-8") == "hola\n"
    assert result.artifacts and result.artifacts[0][0] == "docs/deep/notes.md"
    assert len(result.artifacts[0][1]) == 64  # sha256


def test_write_file_refuses_to_clobber_without_overwrite(ws: Workspace) -> None:
    result = call(ws, "write_file", path="README.md", content="x")
    assert not result.ok and result.error_code == "conflict"
    assert "overwrite=true" in result.observation
    assert (ws.root / "README.md").read_text(encoding="utf-8") == "# Demo\n"


def test_write_file_overwrites_when_asked(ws: Workspace) -> None:
    assert call(ws, "write_file", path="README.md", content="nuevo\n", overwrite=True).ok
    assert (ws.root / "README.md").read_text(encoding="utf-8") == "nuevo\n"


def test_write_file_refuses_a_protected_path(ws: Workspace) -> None:
    result = call(ws, "write_file", path=".git/config", content="x")
    assert not result.ok and result.error_code == "denied"


def test_write_file_refuses_oversized_content(ws: Workspace) -> None:
    result = call(ws, "write_file", path="big.txt", content="x" * 600_000)
    assert not result.ok and result.error_code == "too_large"
    assert not (ws.root / "big.txt").exists()


# ── edit_file ───────────────────────────────────────────────────────────────
def test_edit_file_replaces_and_returns_a_diff(ws: Workspace) -> None:
    result = call(ws, "edit_file", path="src/app.py", old_text="    pass", new_text="    return 1")
    assert result.ok
    assert "-    pass" in result.observation and "+    return 1" in result.observation
    assert "return 1" in (ws.root / "src" / "app.py").read_text(encoding="utf-8")


def test_edit_file_missing_match_quotes_the_nearest_lines(ws: Workspace) -> None:
    """"not found" alone leaves a small model with nowhere to go."""
    result = call(ws, "edit_file", path="src/app.py", old_text="def fooo():", new_text="x")
    assert not result.ok and result.error_code == "not_found"
    assert "def foo():" in result.observation
    assert "sin los numeros de linea" in result.observation


def test_edit_file_ambiguous_match_is_refused(ws: Workspace) -> None:
    (ws.root / "dup.py").write_text("x = 1\nx = 1\n", encoding="utf-8")
    result = call(ws, "edit_file", path="dup.py", old_text="x = 1", new_text="x = 2")
    assert not result.ok and result.error_code == "ambiguous"
    assert (ws.root / "dup.py").read_text(encoding="utf-8") == "x = 1\nx = 1\n"


def test_edit_file_honors_an_explicit_count(ws: Workspace) -> None:
    (ws.root / "dup.py").write_text("x = 1\nx = 1\n", encoding="utf-8")
    assert call(ws, "edit_file", path="dup.py", old_text="x = 1", new_text="x = 2", count=2).ok
    assert (ws.root / "dup.py").read_text(encoding="utf-8") == "x = 2\nx = 2\n"


def test_edit_file_not_found(ws: Workspace) -> None:
    result = call(ws, "edit_file", path="nope.py", old_text="a", new_text="b")
    assert not result.ok and result.error_code == "not_found"


def test_edit_file_rejects_empty_old_text(ws: Workspace) -> None:
    result = call(ws, "edit_file", path="src/app.py", old_text="", new_text="b")
    assert not result.ok and result.error_code == "bad_params"


# ── dry run ─────────────────────────────────────────────────────────────────
def test_dry_run_shows_the_diff_and_writes_nothing(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("old\n", encoding="utf-8")
    ws = Workspace.open(tmp_path, dry_run=True)

    written = call(ws, "write_file", path="new.md", content="hola\n")
    assert written.ok and written.data["dry_run"] is True
    assert not (tmp_path / "new.md").exists()
    # The artifact row is still recorded, so the operator can inspect the plan.
    assert written.artifacts

    edited = call(ws, "edit_file", path="a.py", old_text="old", new_text="new")
    assert edited.ok and "[dry-run]" in edited.observation
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "old\n"

    ran = call(ws, "run_command", command="git status")
    assert ran.ok and "[dry-run] se ejecutaria" in ran.observation


# ── run_command ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "command",
    ["ls | grep x", "echo a && echo b", "cat f; rm g", "echo $(whoami)", "echo `id`", "echo a > f"],
)
def test_run_command_refuses_shell_metacharacters(ws: Workspace, command: str) -> None:
    result = call(ws, "run_command", command=command)
    assert not result.ok and result.error_code == "denied"
    assert "metacaracteres de shell" in result.observation


def test_run_command_refuses_a_binary_outside_the_allowlist(ws: Workspace) -> None:
    result = call(ws, "run_command", command="curl http://example.com")
    assert not result.ok and result.error_code == "denied"
    assert "no esta en la lista permitida" in result.observation


def test_run_command_refuses_an_absolute_binary_path(ws: Workspace) -> None:
    result = call(ws, "run_command", command="/usr/bin/python script.py")
    assert not result.ok and result.error_code == "denied"


def test_run_command_requires_approval_for_installs_and_inline_code(ws: Workspace) -> None:
    for command in ("npm install left-pad", "python -c import os", "pip install requests"):
        result = call(ws, "run_command", command=command)
        assert not result.ok and result.error_code == "denied", command
        assert "aprobacion humana" in result.observation


def test_run_command_forbids_destructive_git(ws: Workspace) -> None:
    result = call(ws, "run_command", command="git reset --hard")
    assert not result.ok and result.error_code == "denied"
    assert "prohibido" in result.observation


def test_run_command_reports_a_missing_binary(ws: Workspace) -> None:
    result = dispatch(
        "run_command", {"command": "make all"}, ws, profile="build"
    ) if not _has("make") else None
    if result is not None:
        assert not result.ok and result.error_code == "not_found"


def test_run_command_runs_inside_the_workspace(ws: Workspace) -> None:
    if not _has("git"):
        pytest.skip("git is not installed")
    result = call(ws, "run_command", command="git status --porcelain")
    # Not a repo → non-zero exit, but it ran, and it ran *here*.
    assert result.data["command"] == "git status --porcelain"
    assert "exit=" in result.observation


def _has(binary: str) -> bool:
    import shutil

    return shutil.which(binary) is not None


# ── control ─────────────────────────────────────────────────────────────────
def test_note_is_a_legal_zero_cost_action(ws: Workspace) -> None:
    result = call(ws, "note", text="todavia no se que hacer")
    assert result.ok and result.observation == "anotado"


def test_finish_normalizes_an_unknown_status(ws: Workspace) -> None:
    result = call(ws, "finish", summary="hecho", status="perfecto")
    assert result.ok and result.data["status"] == "success"


def test_propose_context_keeps_real_files_and_reports_the_rest(ws: Workspace) -> None:
    result = call(
        ws, "propose_context", profile="doc",
        paths="src/app.py\nREADME.md\nno/existe.py\n",
        rationale="entrada y motor",
    )
    assert result.ok
    assert result.data["paths"] == ["src/app.py", "README.md"]
    assert result.data["missing"] == ["no/existe.py"]


def test_propose_context_fails_when_nothing_exists(ws: Workspace) -> None:
    result = call(ws, "propose_context", profile="doc", paths="a.py\nb.py")
    assert not result.ok and result.error_code == "not_found"


# ── dispatch ────────────────────────────────────────────────────────────────
def test_dispatch_rejects_an_unknown_tool_and_lists_the_real_ones(ws: Workspace) -> None:
    result = dispatch("read_files", {"path": "a"}, ws, profile="readonly")
    assert not result.ok and result.error_code == "bad_params"
    assert "read_file" in result.observation


def test_dispatch_enforces_the_profile(ws: Workspace) -> None:
    result = dispatch("write_file", {"path": "a", "content": "b"}, ws, profile="readonly")
    assert not result.ok and result.error_code == "denied"
    assert "perfil 'readonly'" in result.observation
    assert not (ws.root / "a").exists()


def test_dispatch_turns_a_missing_param_into_an_observation(ws: Workspace) -> None:
    result = dispatch("read_file", {}, ws, profile="readonly")
    assert not result.ok and result.error_code == "bad_params"
    assert "read_file(" in result.observation


def test_dispatch_never_raises_even_if_an_executor_explodes(ws: Workspace, monkeypatch) -> None:
    from app.agent_tools import executors

    def boom(*args, **kwargs):
        raise RuntimeError("kaboom")

    monkeypatch.setitem(executors._EXECUTORS, "note", boom)
    result = dispatch("note", {"text": "x"}, ws, profile="readonly")
    assert not result.ok and result.error_code == "internal"
    assert "kaboom" in result.observation


def test_dispatch_truncates_an_oversized_observation(ws: Workspace, monkeypatch) -> None:
    spec = catalog.get_tool("note")
    (ws.root / "huge.txt").write_text("x" * 40_000, encoding="utf-8")
    result = dispatch("read_file", {"path": "huge.txt"}, ws, profile="readonly")
    assert len(result.observation) <= catalog.get_tool("read_file").max_output_chars + 100
    assert "[truncado a" in result.observation
    assert spec is not None


def test_dispatch_accounts_against_the_budget(ws: Workspace) -> None:
    budget = RunBudget()
    dispatch("read_file", {"path": "src/app.py"}, ws, profile="readonly", budget=budget)
    assert budget.state.tool_calls == 1
    assert budget.state.bytes_read > 0


def test_dispatch_refuses_when_the_budget_says_so(ws: Workspace) -> None:
    budget = RunBudget(max_commands=0)
    result = dispatch("run_command", {"command": "git status"}, ws, profile="build", budget=budget)
    assert not result.ok and result.error_code == "denied"
    assert "limite de comandos" in result.observation


@pytest.mark.parametrize(
    "raw",
    [
        "src/app.py\nREADME.md",
        "src/app.py(README.md)",          # observed from llama3.1:8b
        "src/app.py, README.md",
        "- src/app.py\n- README.md",
        "`src/app.py`; `README.md`",
        "[src/app.py, README.md]",
    ],
)
def test_propose_context_tolerates_how_models_actually_write_lists(ws: Workspace, raw: str) -> None:
    """One path per line is the spec; models produce five other shapes. Splitting
    on all of them is the difference between selecting one file and the right two."""
    result = call(ws, "propose_context", profile="doc", paths=raw)
    assert result.ok
    assert result.data["paths"] == ["src/app.py", "README.md"]


def test_propose_context_deduplicates(ws: Workspace) -> None:
    result = call(ws, "propose_context", profile="doc", paths="README.md\nREADME.md")
    assert result.data["paths"] == ["README.md"]
