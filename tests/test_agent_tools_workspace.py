"""Workspace confinement — the security boundary of the whole tool layer.

Every escape route gets an explicit test: traversal, absolute and UNC paths,
symlinked parents, symlinks planted between check and write (TOCTOU), and
secret-shaped files, which are denied on *read* and not only on write.
"""

import os
from pathlib import Path

import pytest

from app.agent_tools.spec import ToolDenied
from app.agent_tools.workspace import Workspace


@pytest.fixture
def workspace(tmp_path: Path) -> Workspace:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=1\n", encoding="utf-8")
    return Workspace.open(tmp_path)


def test_resolves_a_normal_relative_path(workspace: Workspace) -> None:
    resolved = workspace.resolve("src/app.py")
    assert resolved.name == "app.py"
    assert workspace.relative(resolved) == "src/app.py"


def test_resolves_a_target_that_does_not_exist_yet(workspace: Workspace) -> None:
    """Writes need this: `resolve(strict=True)` would reject every new file."""
    resolved = workspace.resolve("src/new/deep/file.py", for_write=True)
    assert resolved.parent.name == "deep"


@pytest.mark.parametrize(
    "path",
    [
        "../outside.py",
        "src/../../outside.py",
        "src/./../../etc/passwd",
        "src/../../../../../../../../etc/passwd",
    ],
)
def test_refuses_traversal(workspace: Workspace, path: str) -> None:
    with pytest.raises(ToolDenied) as excinfo:
        workspace.resolve(path)
    assert excinfo.value.code == "outside_workspace"


def test_obfuscated_traversal_stays_inside_instead_of_escaping(workspace: Workspace) -> None:
    """`....//....//` is not traversal: `....` is just an oddly named directory.

    Worth pinning down, because it is a classic bypass attempt and the correct
    outcome is *containment*, not rejection — rejecting it would suggest the
    guard works by pattern-matching `..`, which is exactly how these guards
    usually break.
    """
    resolved = workspace.resolve("....//....//outside.py", for_write=True)
    # Assert the property, not the spelling: Windows and POSIX normalize the odd
    # segments differently, but both must land inside the root. (`....` is a
    # directory name that merely *looks* like traversal, so the relative form
    # still starts with dots — containment is the thing that matters.)
    assert os.path.commonpath([str(workspace.root), str(resolved)]) == str(workspace.root)


@pytest.mark.parametrize(
    "path",
    ["/etc/passwd", "C:/Windows/System32/config", "//server/share/file", "\\\\server\\share\\file"],
)
def test_refuses_absolute_and_unc_paths(workspace: Workspace, path: str) -> None:
    """These do not escape the root, they ignore it — rejected before touching the fs."""
    with pytest.raises(ToolDenied) as excinfo:
        workspace.resolve(path)
    assert excinfo.value.code == "outside_workspace"


def test_refuses_a_null_byte(workspace: Workspace) -> None:
    with pytest.raises(ToolDenied) as excinfo:
        workspace.resolve("src/app.py\0.txt")
    assert excinfo.value.code == "bad_params"


def test_refuses_an_empty_path(workspace: Workspace) -> None:
    with pytest.raises(ToolDenied):
        workspace.resolve("   ")


@pytest.mark.parametrize(
    "name", [".env", ".env.production", "server.pem", "deploy.key", "id_rsa", "credentials.json"]
)
def test_refuses_reading_secret_shaped_files(workspace: Workspace, name: str) -> None:
    """Denying the *read* is the strongest control: the secret never reaches the
    model's context, and therefore never reaches `run_events`."""
    with pytest.raises(ToolDenied) as excinfo:
        workspace.resolve(name)
    assert excinfo.value.code == "denied"


def test_refuses_secret_directories(workspace: Workspace) -> None:
    for path in (".ssh/id_rsa", ".aws/config", "nested/.gnupg/key"):
        with pytest.raises(ToolDenied):
            workspace.resolve(path)


def test_refuses_git_internals(workspace: Workspace) -> None:
    with pytest.raises(ToolDenied) as excinfo:
        workspace.resolve(".git/config", for_write=True)
    assert excinfo.value.code == "denied"


def test_refuses_writing_over_a_directory(workspace: Workspace) -> None:
    with pytest.raises(ToolDenied) as excinfo:
        workspace.resolve("src", for_write=True)
    assert excinfo.value.code == "bad_params"


@pytest.mark.skipif(os.name == "nt", reason="creating symlinks on Windows needs elevation")
def test_refuses_a_symlinked_parent_that_points_outside(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    (root / "src").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "loot.txt").write_text("secret", encoding="utf-8")
    (root / "src" / "link").symlink_to(outside, target_is_directory=True)

    workspace = Workspace.open(root)
    with pytest.raises(ToolDenied) as excinfo:
        workspace.resolve("src/link/loot.txt")
    assert excinfo.value.code == "outside_workspace"


@pytest.mark.skipif(os.name == "nt", reason="creating symlinks on Windows needs elevation")
def test_confirm_after_write_catches_a_symlink_planted_after_the_check(tmp_path: Path) -> None:
    """TOCTOU: a `run_command` in an earlier turn could plant the link between
    `resolve()` and the write. This is the second half of that guard."""
    root = tmp_path / "ws"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()

    workspace = Workspace.open(root)
    target = workspace.resolve("planted.txt", for_write=True)
    target.symlink_to(outside / "real.txt")

    with pytest.raises(ToolDenied) as excinfo:
        workspace.confirm_after_write(target)
    assert excinfo.value.code == "outside_workspace"


def test_open_refuses_a_missing_root(tmp_path: Path) -> None:
    with pytest.raises(ToolDenied) as excinfo:
        Workspace.open(tmp_path / "nope")
    assert excinfo.value.code == "not_found"


def test_open_refuses_a_file_as_root(tmp_path: Path) -> None:
    target = tmp_path / "file.txt"
    target.write_text("x", encoding="utf-8")
    with pytest.raises(ToolDenied):
        Workspace.open(target)


def test_open_refuses_the_home_directory() -> None:
    """A boundary that wide protects nothing."""
    with pytest.raises(ToolDenied) as excinfo:
        Workspace.open(Path.home())
    assert excinfo.value.code == "denied"


def test_open_refuses_karajans_own_repo_unless_asked() -> None:
    karajan_root = Path(__file__).resolve().parent.parent
    with pytest.raises(ToolDenied):
        Workspace.open(karajan_root)
    allowed = Workspace.open(karajan_root, allow_self=True)
    assert allowed.is_self is True


def test_self_workspace_protects_the_harness_from_the_agent() -> None:
    karajan_root = Path(__file__).resolve().parent.parent
    workspace = Workspace.open(karajan_root, allow_self=True)
    for path in ("app/main.py", "data/active_config.json", "dashboard/static/app.js"):
        # Documentation packs may read the harness, but agent tools may never
        # mutate it.
        assert workspace.resolve(path).is_file()
        with pytest.raises(ToolDenied) as excinfo:
            workspace.resolve(path, for_write=True)
        assert excinfo.value.code == "denied"
    # Anything outside those trees is still fair game.
    assert workspace.resolve("README.md").name == "README.md"


def test_is_noise_flags_vendored_trees(workspace: Workspace) -> None:
    assert workspace.is_noise(workspace.root / "node_modules" / "pkg" / "index.js")
    assert workspace.is_noise(workspace.root / "src" / "__pycache__" / "x.pyc")
    assert not workspace.is_noise(workspace.root / "src" / "app.py")
