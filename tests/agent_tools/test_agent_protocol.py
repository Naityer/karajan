"""The text-protocol parser — the highest-risk surface of the tool layer.

Every tolerance tested here exists because small local models actually produce
the malformed shape in question. If one of these regresses, a 7b model silently
stops being able to use tools at all.
"""

import pytest

from app.agent_tools import catalog, protocol

ALLOWED = catalog.tools_for_profile("build")


def parse(text: str):
    return protocol.parse(text, ALLOWED)


def test_parses_a_canonical_call() -> None:
    outcome = parse(
        '<karajan:tool name="read_file">\n<param name="path">app/main.py</param>\n</karajan:tool>'
    )
    assert outcome.call is not None
    assert outcome.call.tool == "read_file"
    assert outcome.call.params == {"path": "app/main.py"}
    assert outcome.call.source == "text"


def test_preserves_indentation_and_newlines_in_a_body() -> None:
    """The reason this protocol is tags and not JSON: file content survives verbatim."""
    outcome = parse(
        '<karajan:tool name="edit_file">\n'
        '<param name="path">a.py</param>\n'
        '<param name="old_text">\ndef foo():\n    pass\n</param>\n'
        '<param name="new_text">\ndef foo():\n    return "x"\n</param>\n'
        "</karajan:tool>"
    )
    assert outcome.call.params["old_text"] == 'def foo():\n    pass'
    assert outcome.call.params["new_text"] == 'def foo():\n    return "x"'


def test_last_block_wins() -> None:
    """Models restate the system-prompt example before their real call; taking
    the first match would execute the example forever."""
    text = (
        '<karajan:tool name="list_dir"><param name="path">ejemplo</param></karajan:tool>\n'
        "Ahora lo que quiero hacer:\n"
        '<karajan:tool name="read_file"><param name="path">real.py</param></karajan:tool>'
    )
    outcome = parse(text)
    assert outcome.call.tool == "read_file"
    assert outcome.call.params["path"] == "real.py"


def test_strips_markdown_fences() -> None:
    text = (
        "Voy a leerlo:\n```xml\n"
        '<karajan:tool name="read_file"><param name="path">a.py</param></karajan:tool>\n```'
    )
    assert parse(text).call.tool == "read_file"


def test_accepts_a_missing_closing_tag() -> None:
    """Common when the model runs out of tokens mid-block."""
    outcome = parse('<karajan:tool name="note">\n<param name="text">pensando</param>')
    assert outcome.call.tool == "note"
    assert outcome.call.params["text"] == "pensando"


@pytest.mark.parametrize(
    "opening",
    [
        '<tool name="read_file">',
        '<karajan_tool name="read_file">',
        '<use_tool name="read_file">',
        "<karajan:tool name='read_file'>",
        '<karajan:tool name=read_file>',
        '<KARAJAN:TOOL NAME="read_file">',
    ],
)
def test_accepts_tag_spelling_variants(opening: str) -> None:
    outcome = parse(f'{opening}<param name="path">a.py</param></karajan:tool>')
    assert outcome.call is not None and outcome.call.tool == "read_file"


@pytest.mark.parametrize(
    ("alias", "expected"),
    [("list_files", "list_dir"), ("execute_command", "run_command"), ("attempt_completion", "finish")],
)
def test_normalizes_tool_aliases(alias: str, expected: str) -> None:
    outcome = parse(f'<karajan:tool name="{alias}"><param name="text">x</param></karajan:tool>')
    assert outcome.call is not None and outcome.call.tool == expected


@pytest.mark.parametrize(("alias", "expected"), [("file", "path"), ("old_string", "old_text"), ("cmd", "command")])
def test_normalizes_param_aliases(alias: str, expected: str) -> None:
    tool = {"path": "read_file", "old_text": "edit_file", "command": "run_command"}[expected]
    outcome = parse(f'<karajan:tool name="{tool}"><param name="{alias}">v</param></karajan:tool>')
    assert expected in outcome.call.params


def test_parses_the_secondary_json_form() -> None:
    """Several fine-tunes emit this natively instead of the tag form."""
    outcome = parse('Voy a hacer esto: {"tool": "read_file", "params": {"path": "a.py"}}')
    assert outcome.call.tool == "read_file"
    assert outcome.call.params["path"] == "a.py"
    assert outcome.call.source == "json"


def test_json_form_accepts_arguments_as_the_key() -> None:
    outcome = parse('{"name": "note", "arguments": {"text": "hola"}}')
    assert outcome.call.tool == "note" and outcome.call.params["text"] == "hola"


def test_prefers_the_tag_form_over_a_json_blob() -> None:
    text = (
        '{"tool": "run_command", "params": {"command": "rm -rf /"}}\n'
        '<karajan:tool name="note"><param name="text">seguro</param></karajan:tool>'
    )
    assert parse(text).call.tool == "note"


def test_reports_an_empty_response() -> None:
    outcome = parse("   ")
    assert outcome.call is None and "vacia" in outcome.error


def test_reports_plain_prose_with_no_block() -> None:
    outcome = parse("Creo que deberias mirar el archivo main.py y cambiar la funcion foo.")
    assert outcome.call is None
    assert "bloque" in outcome.error


def test_rejects_a_tool_outside_the_profile() -> None:
    readonly = catalog.tools_for_profile("readonly")
    outcome = protocol.parse(
        '<karajan:tool name="run_command"><param name="command">ls</param></karajan:tool>', readonly
    )
    assert outcome.call is None
    assert "no existe o no esta permitida" in outcome.error
    assert "read_file" in outcome.candidates


def test_rejects_an_invented_tool() -> None:
    outcome = parse('<karajan:tool name="delete_everything"><param name="x">1</param></karajan:tool>')
    assert outcome.call is None


def test_corrective_observation_shows_the_shape_to_copy() -> None:
    """The single most effective reliability mechanism for small models: don't
    explain the mistake, show the exact block to imitate."""
    outcome = parse("bla bla sin bloque")
    message = protocol.corrective_observation(outcome, ALLOWED)
    assert "ERROR DE FORMATO" in message
    assert "<karajan:tool" in message
    assert "`note`" in message


def test_a_body_with_json_inside_survives_intact() -> None:
    """Regression guard for the whole "why not JSON" argument."""
    payload = '{\n  "a": "quotes \\" and \\\\ backslashes",\n  "b": [1, 2]\n}'
    outcome = parse(
        '<karajan:tool name="write_file">'
        '<param name="path">c.json</param>'
        f'<param name="content">\n{payload}\n</param>'
        "</karajan:tool>"
    )
    assert outcome.call.params["content"] == payload
