"""The embedded MCP transport must not bypass the production guard."""

import pytest

from app.application.container import KarajanContainer
from app.configuration.modo import leer_modo
from app.application.dto import ResolvedIdentity
from karajan_cli.client import EmbeddedKarajanClient, KarajanApiError


def test_invalid_mode_file_fails_closed_and_missing_file_preserves_compatibility(tmp_path):
    assert leer_modo(tmp_path) == "desarrollo"
    mode_file = tmp_path / "modo.json"
    for content in (b"{broken", b"null", b"\xff"):
        mode_file.write_bytes(content)
        assert leer_modo(tmp_path) == "produccion"


@pytest.mark.parametrize("resource", ["config", "routing_layout"])
def test_embedded_mutation_requires_config_capability(tmp_path, monkeypatch, resource):
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    monkeypatch.delenv("KARAJAN_REQUIRE_ATLAS_TOKEN", raising=False)
    container = KarajanContainer.build(data_dir=tmp_path, in_memory=True)
    client = EmbeddedKarajanClient(container)
    try:
        before = getattr(client, f"get_{resource}")()
        client.identity = ResolvedIdentity("unprivileged", frozenset())
        with pytest.raises(KarajanApiError) as exc:
            getattr(client, f"put_{resource}")(before)
        assert exc.value.status_code == 403
    finally:
        client.close()


@pytest.mark.parametrize("resource", ["config", "routing_layout"])
@pytest.mark.parametrize("mode", ["produccion", "desarrollo"])
def test_embedded_mutation_respects_mode(tmp_path, monkeypatch, resource, mode):
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    monkeypatch.delenv("KARAJAN_REQUIRE_ATLAS_TOKEN", raising=False)
    (tmp_path / "modo.json").write_text(f'{{"modo":"{mode}"}}', encoding="utf-8")
    container = KarajanContainer.build(data_dir=tmp_path, in_memory=True)
    client = EmbeddedKarajanClient(container)
    try:
        before = getattr(client, f"get_{resource}")()
        put = getattr(client, f"put_{resource}")
        if mode == "produccion":
            with pytest.raises(KarajanApiError) as exc:
                put(before)
            assert exc.value.status_code == 423
            after = getattr(client, f"get_{resource}")()
            # An unsaved default layout generates a fresh timestamp on each read.
            after.pop("updated_at", None)
            before.pop("updated_at", None)
            assert after == before
        else:
            assert isinstance(put(before), dict)
    finally:
        client.close()
