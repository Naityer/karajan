"""Exercise the actual MCP stdio boundary with an isolated installation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import anyio
import pytest

pytest.importorskip("mcp")

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import get_default_environment, stdio_client


def _exercise_mcp(tmp_path: Path) -> None:
    env = get_default_environment()
    env.update({"KARAJAN_TRANSPORT": "embedded", "KARAJAN_DATA_DIR": str(tmp_path)})
    env.pop("KARAJAN_URL", None)
    server = StdioServerParameters(
        command=sys.executable,
        args=["-m", "karajan_cli.mcp_server"],
        env=env,
        cwd=str(Path(__file__).resolve().parents[2]),
    )

    async def exercise() -> None:
        with anyio.fail_after(30):
            async with stdio_client(server) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    assert {
                        "karajan_health", "karajan_classify", "karajan_run",
                        "karajan_config_get", "karajan_config_set", "karajan_assign",
                    } <= {tool.name for tool in tools.tools}
                    result = await session.call_tool("karajan_health", {})
                    assert not result.isError
                    text = "\n".join(block.text for block in result.content if block.type == "text")
                    assert "status:" in text
                    assert "db_ok:" in text
                    assert "version:" in text

    anyio.run(exercise)


def test_embedded_mcp_stdio_health_and_tool_contract(tmp_path: Path) -> None:
    # Also bound event-loop creation, which happens before anyio's own deadline.
    subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(tmp_path)],
        check=True,
        timeout=45,
    )


if __name__ == "__main__":
    _exercise_mcp(Path(sys.argv[1]))
