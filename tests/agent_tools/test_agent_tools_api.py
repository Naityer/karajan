"""The tool catalog is served like the provider catalog: as inspectable data."""

from fastapi.testclient import TestClient

from app import main
from app.agent_tools import catalog


def test_agent_tools_endpoint_serves_the_whole_catalog() -> None:
    client = TestClient(main.app)
    response = client.get("/agent-tools")
    assert response.status_code == 200

    body = response.json()
    assert {tool["name"] for tool in body} == {tool.name for tool in catalog.all_tools()}

    read_file = next(tool for tool in body if tool["name"] == "read_file")
    assert read_file["risk"] == "read"
    assert read_file["terminal"] is False
    assert read_file["failure_modes"]
    assert "read_file" in read_file["example"]
    assert {param["name"] for param in read_file["params"]} == {"path", "start_line", "max_lines"}
    assert next(p for p in read_file["params"] if p["name"] == "max_lines")["default"] == 400


def test_agent_tool_profiles_endpoint_exposes_the_permission_sets() -> None:
    client = TestClient(main.app)
    response = client.get("/agent-tools/profiles")
    assert response.status_code == 200

    profiles = {item["name"]: item for item in response.json()}
    assert set(profiles) == set(catalog.profile_names())
    assert profiles["readonly"]["max_risk"] == "read"
    assert profiles["build"]["max_risk"] == "execute"
    assert "write_file" not in profiles["readonly"]["tools"]
    assert "run_command" in profiles["build"]["tools"]
    # Every profile must expose a way to stop, or the loop can only time out.
    assert all(profile["terminal_tools"] for profile in profiles.values())
