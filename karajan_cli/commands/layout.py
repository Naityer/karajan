from __future__ import annotations

import typer

from karajan_cli import output
from karajan_cli.client import KarajanClient

app = typer.Typer(no_args_is_help=True)
entities_app = typer.Typer(no_args_is_help=True)
groups_app = typer.Typer(no_args_is_help=True)
membership_app = typer.Typer(no_args_is_help=True)
app.add_typer(entities_app, name="entities", help="Agentes/nodos de la jerarquía de Decisión.")
app.add_typer(groups_app, name="groups", help="Grupos de jerarquía (contenedores de Prio).")
app.add_typer(membership_app, name="membership", help="Pertenencia de un agente a un grupo y su Prio.")


@app.command("show")
def show(ctx: typer.Context) -> None:
    """Vuelca la RoutingLayout completa (entidades + grupos)."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    if ctx.obj["json"]:
        output.print_json(layout)
        return
    output.print_kv(layout)


@entities_app.command("list")
def entities_list(ctx: typer.Context) -> None:
    """Lista los agentes/nodos registrados en la jerarquía."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    if ctx.obj["json"]:
        output.print_json(layout["entities"])
        return
    rows = [
        {
            "id": e["id"],
            "nombre": e.get("name") or "",
            "rol": e["role"],
            "provider": e.get("provider") or "",
            "tier": e["tier"],
            "levels": ",".join(e.get("levels", [])),
        }
        for e in layout["entities"]
    ]
    output.print_table(rows, title="Entidades")


@entities_app.command("add")
def entities_add(
    ctx: typer.Context,
    id: str = typer.Option(..., "--id"),
    role: str = typer.Option(..., "--role", help="parent|agent|child|worker|backup|guardian|validator|memory|monitor"),
    provider: str = typer.Option(None, "--provider"),
    name: str = typer.Option(None, "--name"),
    tier: int = typer.Option(2, "--tier"),
    levels: list[str] = typer.Option([], "--level", help="Repetible, ej. --level level_3_intermediate"),
    role_tags: list[str] = typer.Option([], "--role-tag"),
    parent_id: str = typer.Option(None, "--parent-id"),
) -> None:
    """Añade un agente a la jerarquía (GET + append + PUT completo del layout)."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    if any(e["id"] == id for e in layout["entities"]):
        typer.echo(f"Ya existe una entidad con id '{id}'", err=True)
        raise typer.Exit(code=1)
    layout["entities"].append(
        {
            "id": id,
            "name": name,
            "role": role,
            "role_tags": list(role_tags),
            "provider": provider,
            "parentId": parent_id,
            "levels": list(levels),
            "tier": tier,
        }
    )
    client.put_routing_layout(layout)
    typer.echo(f"Entidad '{id}' añadida.")


@entities_app.command("edit")
def entities_edit(
    ctx: typer.Context,
    entity_id: str,
    provider: str = typer.Option(None, "--provider"),
    tier: int = typer.Option(None, "--tier"),
    role: str = typer.Option(None, "--role"),
) -> None:
    """Modifica campos de una entidad existente (GET + patch local + PUT completo)."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    entity = next((e for e in layout["entities"] if e["id"] == entity_id), None)
    if entity is None:
        typer.echo(f"No existe la entidad '{entity_id}'", err=True)
        raise typer.Exit(code=1)
    if provider is not None:
        entity["provider"] = provider
    if tier is not None:
        entity["tier"] = tier
    if role is not None:
        entity["role"] = role
    client.put_routing_layout(layout)
    typer.echo(f"Entidad '{entity_id}' actualizada.")


@entities_app.command("remove")
def entities_remove(ctx: typer.Context, entity_id: str) -> None:
    """Elimina una entidad de la jerarquía."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    before = len(layout["entities"])
    layout["entities"] = [e for e in layout["entities"] if e["id"] != entity_id]
    if len(layout["entities"]) == before:
        typer.echo(f"No existe la entidad '{entity_id}'", err=True)
        raise typer.Exit(code=1)
    client.put_routing_layout(layout)
    typer.echo(f"Entidad '{entity_id}' eliminada.")


@groups_app.command("list")
def groups_list(ctx: typer.Context) -> None:
    """Lista los grupos de jerarquía (contenedores de Prio)."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    if ctx.obj["json"]:
        output.print_json(layout["groups"])
        return
    output.print_table(layout["groups"], title="Grupos de jerarquía")


@groups_app.command("add")
def groups_add(
    ctx: typer.Context,
    id: str = typer.Option(..., "--id"),
    name: str = typer.Option(..., "--name"),
    color: str = typer.Option("#336699", "--color"),
) -> None:
    """Crea un grupo de jerarquía nuevo."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    if any(g["id"] == id for g in layout["groups"]):
        typer.echo(f"Ya existe un grupo con id '{id}'", err=True)
        raise typer.Exit(code=1)
    layout["groups"].append({"id": id, "name": name, "color": color})
    client.put_routing_layout(layout)
    typer.echo(f"Grupo '{id}' creado.")


@groups_app.command("remove")
def groups_remove(ctx: typer.Context, group_id: str) -> None:
    """Elimina un grupo (las membresías de agentes a ese grupo quedan huérfanas; límpialas con `membership unset`)."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    before = len(layout["groups"])
    layout["groups"] = [g for g in layout["groups"] if g["id"] != group_id]
    if len(layout["groups"]) == before:
        typer.echo(f"No existe el grupo '{group_id}'", err=True)
        raise typer.Exit(code=1)
    client.put_routing_layout(layout)
    typer.echo(f"Grupo '{group_id}' eliminado.")


@membership_app.command("set")
def membership_set(ctx: typer.Context, entity_id: str, group_id: str, prio: int) -> None:
    """Añade/actualiza la membresía de un agente a un grupo con su Prio (menor número = más prioridad)."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    entity = next((e for e in layout["entities"] if e["id"] == entity_id), None)
    if entity is None:
        typer.echo(f"No existe la entidad '{entity_id}'", err=True)
        raise typer.Exit(code=1)
    if not any(g["id"] == group_id for g in layout["groups"]):
        typer.echo(f"No existe el grupo '{group_id}'", err=True)
        raise typer.Exit(code=1)
    memberships = [m for m in entity.get("memberships", []) if m["group_id"] != group_id]
    memberships.append({"group_id": group_id, "prio": prio})
    entity["memberships"] = memberships
    client.put_routing_layout(layout)
    typer.echo(f"'{entity_id}' -> grupo '{group_id}' con Prio {prio}.")


@membership_app.command("unset")
def membership_unset(ctx: typer.Context, entity_id: str, group_id: str) -> None:
    """Quita a un agente de un grupo."""
    client: KarajanClient = ctx.obj["client"]
    layout = client.get_routing_layout()
    entity = next((e for e in layout["entities"] if e["id"] == entity_id), None)
    if entity is None:
        typer.echo(f"No existe la entidad '{entity_id}'", err=True)
        raise typer.Exit(code=1)
    entity["memberships"] = [m for m in entity.get("memberships", []) if m["group_id"] != group_id]
    client.put_routing_layout(layout)
    typer.echo(f"'{entity_id}' quitado del grupo '{group_id}'.")
