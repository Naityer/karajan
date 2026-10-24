"""The tool catalog is data, so it can be checked like data — no model involved."""

import pytest

from app.agent_tools import catalog
from app.agent_tools.spec import RiskTier, ToolDenied, coerce_params


def test_every_tool_is_fully_described() -> None:
    """A half-described tool becomes a prompt the model cannot follow."""
    for tool in catalog.all_tools():
        assert tool.summary and tool.summary.endswith("."), tool.name
        assert tool.returns, tool.name
        assert tool.example, tool.name
        assert tool.name in tool.example, f"{tool.name}: the example must call the tool it documents"
        assert isinstance(tool.risk, RiskTier), tool.name
        for param in tool.params:
            assert param.description or not param.required, f"{tool.name}.{param.name}"


def test_tools_that_can_fail_document_their_failure_modes() -> None:
    """Failure hints are what let a 7b model recover instead of looping."""
    for tool in catalog.all_tools():
        if tool.risk in (RiskTier.READ, RiskTier.WRITE, RiskTier.EXECUTE):
            assert tool.failure_modes, f"{tool.name} touches the world but documents no failures"


def test_profiles_only_reference_known_tools() -> None:
    known = {tool.name for tool in catalog.all_tools()}
    for profile, granted in catalog.PROFILES.items():
        unknown = set(granted) - known
        assert not unknown, f"profile '{profile}' references unknown tools: {unknown}"


def test_every_profile_has_a_way_to_stop() -> None:
    """Without a terminal tool the loop can only end by exhausting its budget."""
    for profile in catalog.profile_names():
        assert catalog.terminal_tools(profile), f"profile '{profile}' cannot terminate"


@pytest.mark.parametrize(
    ("profile", "expected"),
    [
        ("minimal", RiskTier.READ),
        ("readonly", RiskTier.READ),
        ("doc", RiskTier.READ),
        ("edit", RiskTier.WRITE),
        ("build", RiskTier.EXECUTE),
    ],
)
def test_max_risk_drives_the_approval_policy(profile, expected) -> None:
    assert catalog.max_risk(profile) is expected


def test_read_only_profiles_grant_no_write_or_execute_tool() -> None:
    for profile in ("minimal", "readonly", "doc"):
        risks = {tool.risk for tool in catalog.tools_for_profile(profile)}
        assert RiskTier.WRITE not in risks and RiskTier.EXECUTE not in risks, profile


def test_unknown_profile_grants_nothing() -> None:
    assert catalog.tools_for_profile("does-not-exist") == []
    assert catalog.max_risk("does-not-exist") is RiskTier.CONTROL


def test_coerce_params_types_and_defaults() -> None:
    spec = catalog.get_tool("read_file")
    values = coerce_params(spec, {"path": "a.py", "start_line": "12"})
    assert values == {"path": "a.py", "start_line": 12, "max_lines": 400}


def test_coerce_params_accepts_the_many_spellings_of_true() -> None:
    spec = catalog.get_tool("write_file")
    for raw in ("true", "True", "1", "yes", "si"):
        assert coerce_params(spec, {"path": "a", "content": "b", "overwrite": raw})["overwrite"] is True
    for raw in ("false", "0", "no", ""):
        assert coerce_params(spec, {"path": "a", "content": "b", "overwrite": raw})["overwrite"] is False


def test_coerce_params_rejects_missing_required_and_says_the_signature() -> None:
    spec = catalog.get_tool("read_file")
    with pytest.raises(ToolDenied) as excinfo:
        coerce_params(spec, {"start_line": 1})
    assert excinfo.value.code == "bad_params"
    assert "read_file(" in str(excinfo.value)


def test_coerce_params_rejects_an_uncoercible_integer() -> None:
    spec = catalog.get_tool("read_file")
    with pytest.raises(ToolDenied) as excinfo:
        coerce_params(spec, {"path": "a.py", "start_line": "primera"})
    assert excinfo.value.code == "bad_params"


def test_coerce_params_ignores_unknown_keys() -> None:
    """A model that invents an extra field should still get its call executed."""
    spec = catalog.get_tool("note")
    assert coerce_params(spec, {"text": "hola", "reason": "porque si"}) == {"text": "hola"}
