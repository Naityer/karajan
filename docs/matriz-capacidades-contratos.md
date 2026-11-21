# Matriz de capacidades y contratos de Karajan

Esta fotografía está obtenida por lectura estática del código actual, no de bases reales ni de servicios en ejecución. Los listados por ruta identifican la firma y la declaración visible; no garantizan autorización efectiva, equivalencia ni cobertura de cada caso. Las rutas y esquemas del código siguen siendo el contrato canónico. Una ruta del paquete Atlas se registra bajo el prefijo que le asigne Atlas dev. Las pruebas indicadas son evidencia relacionada, no una afirmación de que cubran todos los escenarios.

## Matriz de capacidades

| Capacidad | Python | TypeScript y entradas | Datos, efectos y dependencias | Pruebas relacionadas y diferencia |
|---|---|---|---|---|
| Clasificar, registrar y consultar tareas | `app/modules/tasks/api.py`, `app/application/` | `heuristica.ts`, `almacen.ts`, CLI `control mision` y `estadisticas` | SQLite de tareas, configuración y perfil; clasificar Python puede registrar una tarea; planificación local TS no la guarda | `tests/api/test_ingest.py`, `atlas/tests/paridad.test.ts`, `cli.test.ts`; algoritmos y contratos no son equivalentes por asumir nombres iguales |
| Ejecutar/cancelar, proveedores | `app/modules/v1/api.py`, `tasks/api.py`, `execution/`, `agents/api.py` | `delegar.ts`, `proveedores.ts`, `control mision --ejecutar` | Procesos, credenciales/proveedores y workspace; hay efectos externos; la planificación local no ejecuta | `tests/execution/`, `tests/providers/`, `atlas/tests/control.test.ts`; requiere validación de permisos y disponibilidad por entrada |
| Perfiles y configuración | `configuration/api.py`, `decision/api.py` | `perfiles.ts`, `runtime.ts`, rutas `/routing-layout`; CLI `control perfiles/jerarquia` | JSON y configuración activa; consultas locales; escrituras necesitan el control aplicable | `tests/configuration/`, `atlas/tests/perfiles.test.ts`, `modo.test.ts`; no suponer mismos esquemas |
| Biblioteca y recursos | `inspiration/api.py`, `app/resources/` | `biblioteca.ts`, `comparador.ts`; CLI `inspiration`, `comparar` | `resources.db`, skills del equipo; Python admite ingestión, refresco y mutaciones; Atlas expone lecturas parciales | `tests/resources/`, `tests/api/test_resource_api.py`, `atlas/tests/inspiration-api.test.ts`, `comparador.test.ts`; paridad parcial |
| Analítica y producción | `monitoring/api.py`, `app/analytics/` | `analitica.ts`, `produccion.ts`, CLI `estadisticas`, `grafica` | SQLite de tareas, perfil y eventualmente disponibilidad de proveedores; exportación de gráfica escribe archivo elegido | `tests/analytics/`, `atlas/tests/produccion.test.ts`, `cli.test.ts`; hay pruebas de paridad parcial, no equivalencia completa |
| Laboratorios, componentes y dosificador | No hay equivalente completo | `componentes.ts`, `laboratorio.ts`, `dosificador*.ts`; CLI `lab`, `componentes`, `dosificador` | Estado del paquete, modo y laboratorio SQLite; ejecución local sintética del dosificador sin borradores; otras ejecuciones pueden requerir Atlas y crear borradores | `atlas/tests/laboratorio.test.ts`, `dosificador-api.test.ts`, `dosificador-sim.test.ts`, `cli.test.ts`; listado local incorpora historial con base de laboratorio; sin base muestra solo el catálogo |
| Skills y rotación | `agents/api.py`, `app/resources/` | `rotador.ts`, `skills-seleccion.ts`, rutas `/skills/*` | Directorios locales de skills; rotación aplicada puede mover carpetas, simulación no | `tests/resources/test_skills.py`, `atlas/tests/rotador.test.ts`, `modo.test.ts`; operaciones distintas |
| Handoff y observabilidad | `shared/api.py`, `monitoring/api.py` | Analítica parcial y laboratorio | Persistencia de packs/eventos, tarea o recursos de la instalación | `tests/execution/test_handoff.py`, `test_observability.py`; sin equivalencia completa identificada |

## Rutas de datos e instalaciones

* Python usa por defecto `data/` relativo al directorio de trabajo (`app/platform/persistence/sqlite/__init__.py`): `task_logs.db`, `resources.db`, `routing_layout.json`, `active_config.json`; la construcción del almacén de recursos siembra y migra datos. Los constructores pueden recibir otro directorio. No se han abierto ni copiado aquí los datos reales.
* Atlas recibe el directorio de datos del paquete, detecta la instalación nativa por `ATLAS_KARAJAN_DATA` o `ATLAS_WORKSPACE`; `ATLAS_KARAJAN_COMPARTIR=0` elige importación. `ATLAS_KARAJAN_LAYOUT` y `ATLAS_KARAJAN_RESOURCES` pueden seleccionar otras rutas. Véase `atlas/src/runtime.ts` para las reglas y las diferencias de compartir/importar.
* `kj` acepta `--datos`/`KARAJAN_DATA_DIR` y `--datos-atlas`/`KARAJAN_ATLAS_DATA_DIR`, además de rutas individuales para bases y configuraciones; estas tienen prioridad. Consulte `docs/CLI.md` y `docs/arquitectura-transportes.md` para las opciones y condiciones de existencia.
* La base de tareas y el almacén de laboratorio pueden usar SQLite/WAL; la configuración JSON no forma parte de una transacción SQLite. No se infiere que la escritura concurrente ni la recuperación ante corte estén demostradas entre todos los procesos.

## Convenciones de los inventarios siguientes

En Python la tabla enumera los decoradores de los ocho routers que monta `app/api/factory.py`. `Entradas` es la firma Python declarada: Pydantic, `Query`, `Header` y `Depends` aportan detalles en el código. `Salida` es `response_model`, o la anotación de retorno si existe; `no declarado` no significa que no exista respuesta. `Control declarado` recoge dependencias explícitas en el decorador, no las comprobaciones dentro del cuerpo ni las de la infraestructura de despliegue. Así se evita atribuir permisos que aún no se han auditado. Las rutas `/v1` incluyen el prefijo declarado por su router.

## API Python: operaciones declaradas

| Método y ruta | Función y fuente | Entradas declaradas | Salida y control declarado |
|---|---|---|---|
| `GET /catalog` | `get_catalog` · app/modules/agents/api.py:60 | `sin parámetros declarados` | `list[ProviderInfo]`; `sin dependencia explícita en decorador` |
| `GET /agent-tools` | `agent_tools_catalog` · app/modules/agents/api.py:65 | `sin parámetros declarados` | `list[ToolSpecInfo]`; `sin dependencia explícita en decorador` |
| `GET /agent-tools/profiles` | `agent_tool_profiles` · app/modules/agents/api.py:92 | `sin parámetros declarados` | `list[ToolProfileInfo]`; `sin dependencia explícita en decorador` |
| `GET /skills` | `list_skills` · app/modules/agents/api.py:106 | `sin parámetros declarados` | `list[SkillInfo]`; `sin dependencia explícita en decorador` |
| `POST /skills/{name}/install` | `install_skill` · app/modules/agents/api.py:122 | `name: str, _: None, __: dict \| None` | `SkillInstallResult`; `[Depends(require_tarea_aceptada)]` |
| `GET /integrations/openclaw/status` | `openclaw_status` · app/modules/agents/api.py:130 | `sin parámetros declarados` | `OpenClawStatus`; `sin dependencia explícita en decorador` |
| `GET /integrations/openclaw/skills` | `openclaw_skills` · app/modules/agents/api.py:135 | `sin parámetros declarados` | `list[OpenClawSkillInfo]`; `sin dependencia explícita en decorador` |
| `POST /integrations/openclaw/skills/install` | `openclaw_install_skill` · app/modules/agents/api.py:140 | `_: None, __: dict \| None` | `OpenClawOperationResult`; `sin dependencia explícita en decorador` |
| `POST /integrations/openclaw/skills/update` | `openclaw_update_skill` · app/modules/agents/api.py:148 | `_: None, __: dict \| None` | `OpenClawOperationResult`; `sin dependencia explícita en decorador` |
| `GET /integrations/openclaw/channels` | `openclaw_channels` · app/modules/agents/api.py:156 | `sin parámetros declarados` | `list[OpenClawChannelInfo]`; `sin dependencia explícita en decorador` |
| `GET /integrations/openclaw/setup-commands` | `openclaw_setup_commands` · app/modules/agents/api.py:161 | `sin parámetros declarados` | `list[OpenClawSetupCommand]`; `sin dependencia explícita en decorador` |
| `GET /integrations/openclaw/channels/catalog` | `openclaw_channel_catalog` · app/modules/agents/api.py:166 | `sin parámetros declarados` | `list[OpenClawChannelInfo]`; `sin dependencia explícita en decorador` |
| `GET /integrations/openclaw/daemon-status` | `openclaw_daemon_status` · app/modules/agents/api.py:171 | `sin parámetros declarados` | `OpenClawDaemonStatus`; `sin dependencia explícita en decorador` |
| `GET /integrations/openclaw/plugins` | `openclaw_plugins` · app/modules/agents/api.py:176 | `sin parámetros declarados` | `list[OpenClawPluginInfo]`; `sin dependencia explícita en decorador` |
| `POST /integrations/openclaw/plugins/install` | `openclaw_install_plugin` · app/modules/agents/api.py:181 | `_: None, __: dict \| None` | `OpenClawOperationResult`; `sin dependencia explícita en decorador` |
| `GET /providers` | `list_providers` · app/modules/agents/api.py:189 | `sin parámetros declarados` | `list[CredentialStatus]`; `sin dependencia explícita en decorador` |
| `GET /providers/{name}/setup` | `provider_setup` · app/modules/agents/api.py:194 | `name: str` | `ProviderSetup`; `sin dependencia explícita en decorador` |
| `POST /providers/{name}/run` | `provider_run` · app/modules/agents/api.py:202 | `name: str, _: None, __: dict \| None` | `ProviderRunResult`; `sin dependencia explícita en decorador` |
| `GET /config` | `get_config` · app/modules/configuration/api.py:45 | `sin parámetros declarados` | `KarajanConfig`; `sin dependencia explícita en decorador` |
| `PUT /config` | `update_config` · app/modules/configuration/api.py:50 | `new_config: KarajanConfig, _: None, __: dict \| None` | `KarajanConfig`; `[Depends(require_tarea_aceptada)]` |
| `POST /setup/apply-default` | `apply_default_config` · app/modules/configuration/api.py:58 | `_: None, __: dict \| None` | `DefaultConfigApplyResult`; `[Depends(require_tarea_aceptada)]` |
| `POST /setup/apply-queue-config` | `apply_queue_config` · app/modules/configuration/api.py:103 | `_: None, __: dict \| None` | `DefaultConfigApplyResult`; `[Depends(require_tarea_aceptada)]` |
| `GET /setup/status` | `setup_status_endpoint` · app/modules/configuration/api.py:154 | `sin parámetros declarados` | `SetupStatus`; `sin dependencia explícita en decorador` |
| `POST /setup/complete` | `setup_complete` · app/modules/configuration/api.py:159 | `_: None, __: dict \| None` | `SetupStatus`; `sin dependencia explícita en decorador` |
| `GET /setup/tutorial` | `setup_tutorial` · app/modules/configuration/api.py:167 | `sin parámetros declarados` | `SetupTutorial`; `sin dependencia explícita en decorador` |
| `GET /routing-layout` | `get_routing_layout` · app/modules/decision/api.py:36 | `sin parámetros declarados` | `RoutingLayout`; `sin dependencia explícita en decorador` |
| `PUT /routing-layout` | `update_routing_layout` · app/modules/decision/api.py:41 | `layout: RoutingLayout, _: None, __: dict \| None` | `RoutingLayout`; `[Depends(require_tarea_aceptada)]` |
| `POST /routing-layout/presets/nivel` | `apply_level_preset` · app/modules/decision/api.py:52 | `_: None, __: dict \| None` | `RoutingLayout`; `[Depends(require_tarea_aceptada)]` |
| `POST /routing-layout/catalog/{provider_name}` | `add_catalog_provider_to_routing_layout` · app/modules/decision/api.py:67 | `provider_name: str, _: None, __: dict \| None` | `RoutingLayout`; `[Depends(require_tarea_aceptada)]` |
| `DELETE /routing-layout/catalog/{provider_name}` | `remove_catalog_provider_from_routing_layout` · app/modules/decision/api.py:105 | `provider_name: str, _: None, __: dict \| None` | `RoutingLayout`; `[Depends(require_tarea_aceptada)]` |
| `GET /resource-groups` | `list_resource_groups` · app/modules/inspiration/api.py:155 | `sin parámetros declarados` | `list[ResourceGroup]`; `sin dependencia explícita en decorador` |
| `POST /resource-groups` | `create_resource_group` · app/modules/inspiration/api.py:161 | `_: None, __: dict \| None` | `ResourceGroup`; `sin dependencia explícita en decorador` |
| `PUT /resource-groups/assignments` | `update_resource_group_assignments` · app/modules/inspiration/api.py:178 | `_: None, __: dict \| None` | `list[ResourceGroup]`; `sin dependencia explícita en decorador` |
| `PUT /resource-groups/{group_id}` | `update_resource_group` · app/modules/inspiration/api.py:197 | `group_id: str, _: None, __: dict \| None` | `ResourceGroup`; `sin dependencia explícita en decorador` |
| `DELETE /resource-groups/{group_id}` | `delete_resource_group` · app/modules/inspiration/api.py:217 | `group_id: str, confirmed: bool, move_to_id: str \| None, _: None, __: dict \| None` | `dict`; `sin dependencia explícita en decorador` |
| `GET /resources` | `list_resources` · app/modules/inspiration/api.py:240 | `q: str \| None, kind: ResourceKind \| None, status: str \| None, runtime: str \| None, agent_id: str \| None, source: str \| None, tags: list[str] \| None, limit: int, offset: int, accepted_only: bool` | `list[ResourceItem]`; `sin dependencia explícita en decorador` |
| `GET /resources/index` | `resources_agent_index` · app/modules/inspiration/api.py:299 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `POST /resources/recommend` | `recommend_resources` · app/modules/inspiration/api.py:330 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `GET /resources/discovery/sources` | `inspiration_sources` · app/modules/inspiration/api.py:393 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `POST /resources/discovery/sources` | `create_inspiration_source` · app/modules/inspiration/api.py:403 | `_: None` | `DiscoverySource`; `sin dependencia explícita en decorador` |
| `PUT /resources/discovery/sources` | `update_inspiration_sources` · app/modules/inspiration/api.py:434 | `_: None, __: dict \| None` | `dict`; `sin dependencia explícita en decorador` |
| `GET /resources/discovery/feed` | `inspiration_discovery_feed` · app/modules/inspiration/api.py:463 | `limit: int` | `dict`; `sin dependencia explícita en decorador` |
| `GET /resources/refresh/settings` | `resource_refresh_settings` · app/modules/inspiration/api.py:477 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `PUT /resources/refresh/settings` | `update_resource_refresh_settings` · app/modules/inspiration/api.py:483 | `_: None` | `dict`; `sin dependencia explícita en decorador` |
| `POST /resources/refresh/run` | `run_resource_refresh` · app/modules/inspiration/api.py:493 | `_: None` | `dict`; `sin dependencia explícita en decorador` |
| `GET /resources/refresh/runs/{run_id}` | `resource_refresh_run_status` · app/modules/inspiration/api.py:506 | `run_id: str` | `dict`; `sin dependencia explícita en decorador` |
| `POST /resources/ingest-url` | `ingest_resource_url` · app/modules/inspiration/api.py:529 | `_: None` | `ResourceItem`; `sin dependencia explícita en decorador` |
| `POST /resources/analyze` | `analyze_resource` · app/modules/inspiration/api.py:550 | `_: None` | `AnalyzeResult`; `sin dependencia explícita en decorador` |
| `POST /resources` | `create_resource` · app/modules/inspiration/api.py:618 | `_: None` | `ResourceItem`; `sin dependencia explícita en decorador` |
| `GET /resources/validity-policy` | `get_validity_policy` · app/modules/inspiration/api.py:710 | `sin parámetros declarados` | `ArtifactValidityPolicy`; `sin dependencia explícita en decorador` |
| `POST /resources/validity-policy/impact` | `preview_validity_policy_impact` · app/modules/inspiration/api.py:715 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `PUT /resources/validity-policy` | `save_validity_policy` · app/modules/inspiration/api.py:721 | `_: None` | `dict`; `sin dependencia explícita en decorador` |
| `POST /resources/validity-policy/revalidate` | `revalidate_validity_policy` · app/modules/inspiration/api.py:740 | `_: None` | `dict`; `sin dependencia explícita en decorador` |
| `GET /resources/review` | `list_resources_for_review` · app/modules/inspiration/api.py:748 | `state: str, limit: int, offset: int` | `list[ResourceItem]`; `sin dependencia explícita en decorador` |
| `POST /resources/{resource_id}/review` | `review_resource` · app/modules/inspiration/api.py:763 | `resource_id: str, _: None` | `ResourceItem`; `sin dependencia explícita en decorador` |
| `POST /resources/inventory` | `prepare_resource_inventory` · app/modules/inspiration/api.py:775 | `_: None` | `dict`; `sin dependencia explícita en decorador` |
| `GET /resources/inventory/{snapshot_id}.xlsx` | `download_resource_inventory` · app/modules/inspiration/api.py:789 | `snapshot_id: str` | `StreamingResponse`; `sin dependencia explícita en decorador` |
| `GET /resources/{resource_id}` | `resource_detail` · app/modules/inspiration/api.py:802 | `resource_id: str` | `dict`; `sin dependencia explícita en decorador` |
| `PATCH /resources/{resource_id}` | `update_resource` · app/modules/inspiration/api.py:815 | `resource_id: str, _: None` | `ResourceItem`; `sin dependencia explícita en decorador` |
| `POST /resources/{resource_id}/reindex` | `reindex_resource` · app/modules/inspiration/api.py:826 | `resource_id: str, _: None, __: dict \| None` | `dict`; `sin dependencia explícita en decorador` |
| `POST /resources/{resource_id}/reanalyze` | `reanalyze_resource` · app/modules/inspiration/api.py:865 | `resource_id: str, _: None` | `ResourceItem`; `sin dependencia explícita en decorador` |
| `PUT /resources/{resource_id}/visibility` | `update_resource_visibility` · app/modules/inspiration/api.py:904 | `resource_id: str, _: None, __: dict \| None` | `ResourceItem`; `sin dependencia explícita en decorador` |
| `POST /resources/{resource_id}/operations` | `operate_resource` · app/modules/inspiration/api.py:945 | `resource_id: str, _: None, __: dict \| None` | `ResourceOperationResult`; `sin dependencia explícita en decorador` |
| `GET /metrics` | `metrics` · app/modules/monitoring/api.py:55 | `sin parámetros declarados` | `Metrics`; `sin dependencia explícita en decorador` |
| `GET /agents/performance` | `agents_performance` · app/modules/monitoring/api.py:60 | `sin parámetros declarados` | `list[AgentPerformance]`; `sin dependencia explícita en decorador` |
| `GET /analytics/skills` | `skills_analytics` · app/modules/monitoring/api.py:70 | `days: int` | `dict`; `sin dependencia explícita en decorador` |
| `GET /search/tasks` | `search_tasks` · app/modules/monitoring/api.py:93 | `q: str, limit: int` | `dict`; `sin dependencia explícita en decorador` |
| `GET /analytics/dashboard` | `analytics_dashboard` · app/modules/monitoring/api.py:107 | `days: int` | `dict`; `sin dependencia explícita en decorador` |
| `GET /metrics/prometheus` | `metrics_prometheus` · app/modules/monitoring/api.py:124 | `sin parámetros declarados` | `PlainTextResponse`; `sin dependencia explícita en decorador` |
| `GET /observability` | `observability` · app/modules/monitoring/api.py:146 | `sin parámetros declarados` | `ObservabilitySnapshot`; `sin dependencia explícita en decorador` |
| `GET /observability/history` | `observability_history` · app/modules/monitoring/api.py:161 | `limit: int` | `MetricsHistory`; `sin dependencia explícita en decorador` |
| `GET /analytics/predictions/status` | `predictions_status` · app/modules/monitoring/api.py:170 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `POST /predict/task` | `predict_task` · app/modules/monitoring/api.py:185 | `sin parámetros declarados` | `PredictTaskResponse`; `sin dependencia explícita en decorador` |
| `GET /analytics/produccion` | `analytics_produccion` · app/modules/monitoring/api.py:254 | `dias: int, perfil: str` | `dict`; `sin dependencia explícita en decorador` |
| `GET /analytics/flujo` | `analytics_flujo` · app/modules/monitoring/api.py:261 | `dias: int, perfil: str` | `dict`; `sin dependencia explícita en decorador` |
| `GET /analytics/eficiencia` | `analytics_eficiencia` · app/modules/monitoring/api.py:267 | `dias: int, perfil: str` | `dict`; `sin dependencia explícita en decorador` |
| `GET /analytics/matriz-skills` | `analytics_matriz_skills` · app/modules/monitoring/api.py:273 | `dias: int, perfil: str` | `dict`; `sin dependencia explícita en decorador` |
| `GET /analytics/sugerencias` | `analytics_sugerencias` · app/modules/monitoring/api.py:279 | `dias: int, perfil: str` | `dict`; `sin dependencia explícita en decorador` |
| `GET /analytics/acierto` | `analytics_acierto` · app/modules/monitoring/api.py:285 | `dias: int, perfil: str` | `dict`; `sin dependencia explícita en decorador` |
| `GET /skills/catalogo` | `skills_catalogo` · app/modules/monitoring/api.py:291 | `dias: int` | `dict`; `sin dependencia explícita en decorador` |
| `POST /feedback/revisiones` | `feedback_revisiones` · app/modules/monitoring/api.py:310 | `body: Revisiones, _: None` | `dict`; `sin dependencia explícita en decorador` |
| `GET /manifest` | `manifest` · app/modules/shared/api.py:84 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `GET /atlas-addon.json` | `atlas_addon_manifest` · app/modules/shared/api.py:100 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `GET /events` | `events_stream` · app/modules/shared/api.py:117 | `sin parámetros declarados` | `StreamingResponse`; `sin dependencia explícita en decorador` |
| `GET /health` | `health` · app/modules/shared/api.py:151 | `sin parámetros declarados` | `HealthStatus`; `sin dependencia explícita en decorador` |
| `POST /handoff/packs` | `create_context_pack` · app/modules/shared/api.py:189 | `_: None, __: dict \| None` | `ContextPackDetail`; `sin dependencia explícita en decorador` |
| `GET /handoff/packs` | `list_context_packs` · app/modules/shared/api.py:220 | `status: str \| None` | `list[ContextPackSummary]`; `sin dependencia explícita en decorador` |
| `GET /handoff/packs/{pack_id}` | `get_context_pack` · app/modules/shared/api.py:231 | `pack_id: str` | `ContextPackDetail`; `sin dependencia explícita en decorador` |
| `POST /handoff/packs/{pack_id}/result` | `submit_doc_result` · app/modules/shared/api.py:239 | `pack_id: str, _: None, __: dict \| None` | `ContextPackDetail`; `sin dependencia explícita en decorador` |
| `POST /classify-task` | `classify_task` · app/modules/tasks/api.py:111 | `_: None, __: dict \| None` | `TaskRecord`; `sin dependencia explícita en decorador` |
| `POST /ingest` | `ingest` · app/modules/tasks/api.py:120 | `_: None, __: dict \| None` | `TaskRecord`; `sin dependencia explícita en decorador` |
| `POST /tasks/{task_id}/decisions` | `append_decision` · app/modules/tasks/api.py:138 | `task_id: str, entry: DecisionLogEntry, _: None, __: dict \| None` | `DecisionLogEntry`; `sin dependencia explícita en decorador` |
| `POST /delegate-task` | `delegate_task` · app/modules/tasks/api.py:193 | `_: None, __: dict \| None` | `TaskRecord`; `sin dependencia explícita en decorador` |
| `GET /queue/status` | `queue_status` · app/modules/tasks/api.py:292 | `_: None, __: dict \| None` | `dict`; `sin dependencia explícita en decorador` |
| `GET /tasks` | `list_tasks` · app/modules/tasks/api.py:302 | `limit: int \| None, offset: int` | `list[TaskRecord]`; `sin dependencia explícita en decorador` |
| `GET /tasks/{task_id}` | `get_task` · app/modules/tasks/api.py:311 | `task_id: str` | `TaskRecord`; `sin dependencia explícita en decorador` |
| `GET /tasks/{task_id}/decisions` | `task_decisions` · app/modules/tasks/api.py:319 | `task_id: str` | `list[DecisionLogEntry]`; `sin dependencia explícita en decorador` |
| `GET /tasks/{task_id}/runs` | `task_runs` · app/modules/tasks/api.py:324 | `task_id: str` | `list[RunInfo]`; `sin dependencia explícita en decorador` |
| `GET /tasks/{task_id}/artifacts` | `task_artifacts` · app/modules/tasks/api.py:334 | `task_id: str` | `list[ArtifactInfo]`; `sin dependencia explícita en decorador` |
| `GET /runs/{run_id}/events` | `run_events` · app/modules/tasks/api.py:340 | `run_id: str, limit: int, offset: int` | `list[RunEventInfo]`; `sin dependencia explícita en decorador` |
| `POST /tasks/{task_id}/approve-review` | `approve_review` · app/modules/tasks/api.py:350 | `task_id: str, _: None, __: dict \| None` | `TaskRecord`; `sin dependencia explícita en decorador` |
| `GET /v1/health/live` | `liveness` · app/modules/v1/api.py:77 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `GET /v1/health/ready` | `readiness` · app/modules/v1/api.py:82 | `sin parámetros declarados` | `dict`; `sin dependencia explícita en decorador` |
| `POST /v1/tasks/classify` | `classify` · app/modules/v1/api.py:87 | `body: ClassifyBody, correlation_id: str \| None, idempotency_key: str` | `no declarado`; `secured` |
| `POST /v1/executions` | `execute` · app/modules/v1/api.py:108 | `body: ExecuteBody, correlation_id: str \| None, idempotency_key: str` | `no declarado`; `secured` |
| `GET /v1/tasks` | `list_tasks` · app/modules/v1/api.py:132 | `limit: int \| None, offset: int` | `no declarado`; `secured` |
| `GET /v1/tasks/{task_id}` | `get_task` · app/modules/v1/api.py:140 | `task_id: str` | `no declarado`; `secured` |
| `POST /v1/executions/{execution_id}/cancel` | `cancel_execution` · app/modules/v1/api.py:148 | `execution_id: str, correlation_id: str` | `no declarado`; `secured` |


La seguridad de `/v1` usa `secured` en las operaciones indicadas, definida como `Depends(require_token)` y `Depends(require_atlas_token)` en `app/modules/v1/api.py`. Liveness y readiness no declaran dicha dependencia. Errores de aplicación traducidos en `/v1`: autorización 403, inexistencia 404, conflicto/presupuesto 409, validación 422, proveedor o modo no disponible 503, plazo 504 y resultado desconocido 502. No trasladar estos códigos a las rutas anteriores sin comprobarlas.

## API del paquete Atlas: rutas registradas

La tabla localiza las rutas en `atlas/src/servidor.ts`; las operaciones coordinadas viven en `aplicacion.ts`, `aplicacion-dosificador.ts` y `aplicacion-laboratorio.ts`. El método HTTP no prueba ausencia de efectos. Hay que comprobar cuerpo, validaciones y controles de cada manejador y sus colaboradores. Los clientes conocidos incluyen `kj`, SDK y UI de Atlas, pero no se ha demostrado una lista exhaustiva de terceros.

| Método y ruta | Fuente |
|---|---|
| `POST /dosificador/decidir` | `atlas/src/servidor.ts` |
| `POST /dosificador/observar` | `atlas/src/servidor.ts` |
| `GET /dosificador/estado` | `atlas/src/servidor.ts` |
| `POST /dosificador/relevo` | `atlas/src/servidor.ts` |
| `GET /dosificador/decisiones` | `atlas/src/servidor.ts` |
| `GET /dosificador/config` | `atlas/src/servidor.ts` |
| `PUT /dosificador/config` | `atlas/src/servidor.ts` |
| `POST /dosificador/simular` | `atlas/src/servidor.ts` |
| `GET /health` | `atlas/src/servidor.ts` |
| `GET /metrics` | `atlas/src/servidor.ts` |
| `GET /agents/performance` | `atlas/src/servidor.ts` |
| `GET /analytics/skills` | `atlas/src/servidor.ts` |
| `GET /tasks` | `atlas/src/servidor.ts` |
| `GET /tasks/:id` | `atlas/src/servidor.ts` |
| `GET /tasks/:id/runs` | `atlas/src/servidor.ts` |
| `GET /tasks/:id/decisions` | `atlas/src/servidor.ts` |
| `GET /search/tasks` | `atlas/src/servidor.ts` |
| `GET /skills` | `atlas/src/servidor.ts` |
| `GET /config` | `atlas/src/servidor.ts` |
| `POST /classify-task` | `atlas/src/servidor.ts` |
| `GET /routing-layout` | `atlas/src/servidor.ts` |
| `PUT /routing-layout` | `atlas/src/servidor.ts` |
| `POST /routing-layout/presets/dominios` | `atlas/src/servidor.ts` |
| `POST /routing-layout/presets/nivel` | `atlas/src/servidor.ts` |
| `POST /routing-layout/desde-texto` | `atlas/src/servidor.ts` |
| `GET /providers` | `atlas/src/servidor.ts` |
| `POST /routing/plan` | `atlas/src/servidor.ts` |
| `POST /delegate-task` | `atlas/src/servidor.ts` |
| `GET /analytics/produccion` | `atlas/src/servidor.ts` |
| `GET /analytics/flujo` | `atlas/src/servidor.ts` |
| `GET /analytics/eficiencia` | `atlas/src/servidor.ts` |
| `GET /analytics/matriz-skills` | `atlas/src/servidor.ts` |
| `GET /analytics/sugerencias` | `atlas/src/servidor.ts` |
| `GET /analytics/acierto` | `atlas/src/servidor.ts` |
| `GET /skills/catalogo` | `atlas/src/servidor.ts` |
| `GET /resources/:id` | `atlas/src/servidor.ts` |
| `GET /skills/rotacion` | `atlas/src/servidor.ts` |
| `POST /skills/rotar` | `atlas/src/servidor.ts` |
| `POST /feedback/revisiones` | `atlas/src/servidor.ts` |
| `GET /laboratorio/componentes` | `atlas/src/servidor.ts` |
| `GET /laboratorio/arquitectura` | `atlas/src/servidor.ts` |
| `GET /laboratorio/arquitectura/:id` | `atlas/src/servidor.ts` |
| `GET /laboratorio/comparar` | `atlas/src/servidor.ts` |
| `GET /laboratorio/ejecuciones` | `atlas/src/servidor.ts` |
| `GET /laboratorio/tutores` | `atlas/src/servidor.ts` |
| `POST /laboratorio/tutores/actualizar` | `atlas/src/servidor.ts` |
| `GET /laboratorio/tutoria` | `atlas/src/servidor.ts` |
| `GET /laboratorio/tutoria/brechas` | `atlas/src/servidor.ts` |
| `GET /laboratorio/modo` | `atlas/src/servidor.ts` |
| `GET /laboratorio/propuestas` | `atlas/src/servidor.ts` |
| `GET /laboratorio/curador` | `atlas/src/servidor.ts` |
| `POST /laboratorio/curador/proponer` | `atlas/src/servidor.ts` |
| `POST /laboratorio/ejecutar` | `atlas/src/servidor.ts` |
| `GET /laboratorio/sugerencias-skills` | `atlas/src/servidor.ts` |
| `POST /laboratorio/calibracion` | `atlas/src/servidor.ts` |
| `GET /laboratorio/calibracion` | `atlas/src/servidor.ts` |
| `GET /resources`, `/resources/index`, `/resources/discovery/sources`, `/resources/review`, `/resources/validity-policy`, `/resources/refresh/settings`, `/resource-groups` | `atlas/src/servidor.ts` registra estas rutas mediante un bucle y `consultarBiblioteca` |

## Herramientas MCP

FastMCP expone cadenas de texto; una cadena que empieza por `ERROR` es una respuesta de herramienta y no necesariamente un error de transporte MCP. Usa cliente embebido por defecto o HTTP explícito, según `karajan_cli/client.py`. Las comprobaciones del cliente y la operación deben leerse juntas; esta tabla no promete que la autorización sea equivalente entre transportes.

| Herramienta y firma | Efecto principal y dependencias | Fuente |
|---|---|---|
| `karajan_run(prompt: str)` | Classify a task by complexity and delegate it to the optimal AI model via Karajan. | `karajan_cli/mcp_server.py:88` |
| `karajan_classify(prompt: str)` | Classify a task's complexity level without executing it. | `karajan_cli/mcp_server.py:167` |
| `karajan_health(sin parámetros declarados)` | Check if the Karajan server is running and which backend/profile is active. | `karajan_cli/mcp_server.py:202` |
| `karajan_providers(sin parámetros declarados)` | List all AI providers and their credential/readiness status in Karajan. | `karajan_cli/mcp_server.py:211` |
| `karajan_assign(task_id: str, provider_or_entity: str, as_entity: bool)` | Force-delegate an already-classified task to one named agent/provider, | `karajan_cli/mcp_server.py:229` |
| `karajan_config_get(dotted_path: str \| None)` | Read the active KarajanConfig, or one field by dotted path (e.g. "orchestration.dispatch_mode"). | `karajan_cli/mcp_server.py:259` |
| `karajan_config_set(dotted_path: str, value: str)` | Write one KarajanConfig field by dotted path (GET, patch locally, PUT). | `karajan_cli/mcp_server.py:279` |
| `karajan_layout_show(sin parámetros declarados)` | Show the Decisión routing hierarchy (entities + groups). | `karajan_cli/mcp_server.py:314` |
| `karajan_layout_set_provider(entity_id: str, provider: str)` | Change one routing entity's provider (narrowly-scoped layout mutation; | `karajan_cli/mcp_server.py:331` |
| `karajan_provider_activate(name: str, slot: str)` | Run a provider's catalog-defined login or probe command. | `karajan_cli/mcp_server.py:354` |
| `karajan_stats(kind: str, days: int)` | Return harness statistics. | `karajan_cli/mcp_server.py:378` |


## CLI `kj`

La implementación directa y su selección de transporte están en `atlas/src/cli.ts` y `cli-local.ts`; el registro de comandos por módulo está en `atlas/src/sdk/`. Además de los comandos propios `modo`, `componentes`, `lab ls/run/informe/historial`, `grafica`, `curador`, `dosificador estado/config/decidir/simular`, `propuestas`, `comparar` y `tutoria`, se registran las siguientes rutas de módulo. `--json` serializa los resultados de cada camino, pero no establece por sí mismo igualdad entre local y HTTP.

| Comando registrado | Resumen | Fuente |
|---|---|---|
| `kj control estado` | modo, proveedores, cuota, borradores y revisiones de un vistazo | `atlas/src/sdk/modulos/control.ts:118` |
| `kj control mapa` | equipos por zona con su carga, cuota y actividad reciente | `atlas/src/sdk/modulos/control.ts:123` |
| `kj control jerarquia` | árbol de agentes y reglas de enrutado | `atlas/src/sdk/modulos/control.ts:127` |
| `kj control perfiles` | perfiles de enrutado (el que ejecuta y el que se edita) | `atlas/src/sdk/modulos/control.ts:128` |
| `kj control proveedores` | Claude Code, Codex, Qwen…: cuáles están listos | `atlas/src/sdk/modulos/control.ts:129` |
| `kj control revisiones` | tareas que esperan revisión humana | `atlas/src/sdk/modulos/control.ts:130` |
| `kj control cuota` | cuota de cada agente y modo del dosificador | `atlas/src/sdk/modulos/control.ts:131` |
| `kj control mision` | clasifica y planifica una tarea; con --ejecutar la delega de verdad | `atlas/src/sdk/modulos/control.ts:132` |
| `kj estadisticas resumen` | indicadores, flujo, coste/latencia y qué mejorar | `atlas/src/sdk/modulos/estadisticas.ts:89` |
| `kj estadisticas agentes` | ranking, acierto y latencia por agente | `atlas/src/sdk/modulos/estadisticas.ts:90` |
| `kj estadisticas skills` | actividad, uso por categoría y mapas de calor | `atlas/src/sdk/modulos/estadisticas.ts:91` |
| `kj estadisticas tareas` | las tareas más recientes | `atlas/src/sdk/modulos/estadisticas.ts:92` |
| `kj estadisticas tarea` | detalle de una tarea: criterios y decisiones | `atlas/src/sdk/modulos/estadisticas.ts:96` |
| `kj inspiration resumen` | recuentos por tipo, estado, validez, origen y grupo | `atlas/src/sdk/modulos/inspiration.ts:108` |
| `kj inspiration lista` | catálogo con filtros | `atlas/src/sdk/modulos/inspiration.ts:109` |
| `kj inspiration arbol` | familia → grupo → artefacto → componentes | `atlas/src/sdk/modulos/inspiration.ts:113` |
| `kj inspiration grupos` | taxonomía de grupos con su número de recursos | `atlas/src/sdk/modulos/inspiration.ts:120` |
| `kj inspiration ver` | ficha de un recurso: datos, componentes y operaciones | `atlas/src/sdk/modulos/inspiration.ts:121` |
| `kj inspiration radar` | fuentes de descubrimiento | `atlas/src/sdk/modulos/inspiration.ts:126` |
| `kj inspiration revision` | recursos que esperan aceptar o descartar | `atlas/src/sdk/modulos/inspiration.ts:127` |
| `kj inspiration refresco` | estado del último refresco de la biblioteca | `atlas/src/sdk/modulos/inspiration.ts:131` |
| `kj inspiration validez` | política de validez de las fuentes y su efecto | `atlas/src/sdk/modulos/inspiration.ts:132` |


El registro también permite acciones genéricas de componente con rutas comodín; véase `atlas/src/sdk/registro.ts` y `atlas/src/sdk/componentes-cli.ts`. Las opciones completas y los códigos de salida deben comprobarse en `docs/CLI.md` y el código del comando concreto. Falta una comparación automatizada exhaustiva de contratos locales/HTTP, incluidos errores, cabeceras, perfiles y acciones dependientes de Atlas; no debe entenderse esta matriz como prueba de aceptación completa.

## Límites de esta fotografía

No se han investigado consumidores externos que no estén en el repositorio, ni se han ejecutado proveedores o servicios reales para elaborar esta matriz. Se conservan ambos motores y sus diferencias; una decisión de referencia o retirada requiere la evidencia pendiente indicada en `docs/adr/0002-referencia-por-capacidad-borrador.md`. La identificación exhaustiva de permisos efectivos por ruta requiere seguir tanto las dependencias declaradas como los controles internos, configuración y middleware del host. La comparación de línea base anterior a cambios locales no puede reconstruirse como una prueba ejecutada si no se dispone de su registro.
