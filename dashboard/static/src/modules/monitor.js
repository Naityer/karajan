// Pestaña "Estadísticas" (`data-view="monitor"`).
//
// Extraído mecánicamente de app.js (nota "Plan de mejora", §18): mismo
// código, mismo comportamiento — solo cambia de dónde vienen sus nombres
// compartidos (antes globals de un único archivo, ahora imports explícitos).

import { $, $$, LEVELS, LEVEL_FULL, TIER_LABEL, api, escapeHtml, state, toast } from "./shared.js";
import { renderAgentNotifications, renderNotifications } from "./shell.js";

// ---- MONITOR ---------------------------------------------------------------

// Sub-navigation (segmented control: Resumen | Agentes | Tareas). Only one
// sub-view is visible at a time; the last choice persists in localStorage. Each
// sub-view lazily triggers its own data refresh when shown via enterSubview()
// — a dispatcher that Phases B/C/D will specialise. For now every sub-view
// shares refreshMonitor(); SSE live updates keep flowing regardless.
const MONITOR_SUBVIEWS = ["resumen", "agentes", "tareas", "skills"];

const MONITOR_SUBVIEW_KEY = "karajan-monitor-subview";

export function initMonitorSubnav() {
  const nav = $("#monitorSubnav");
  if (!nav || nav.dataset.bound) return;
  nav.dataset.bound = "1";
  nav.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-subview]");
    if (!tab) return;
    enterSubview(tab.dataset.subview);
  });
}

export function restoreMonitorSubview() {
  const stored = localStorage.getItem(MONITOR_SUBVIEW_KEY);
  const name = MONITOR_SUBVIEWS.includes(stored) ? stored : "resumen";
  enterSubview(name);
}

function enterSubview(name) {
  if (!MONITOR_SUBVIEWS.includes(name)) name = "resumen";
  state.monitorSubview = name;
  localStorage.setItem(MONITOR_SUBVIEW_KEY, name);
  $$("#monitorSubnav .monitor-subtab").forEach((tab) => {
    const on = tab.dataset.subview === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  MONITOR_SUBVIEWS.forEach((key) => {
    const section = $(`#subview-${key}`);
    if (!section) return;
    const on = key === name;
    section.classList.toggle("active", on);
    section.hidden = !on;
  });
  // Lazy per-sub-view refresh. Phases B/C/D specialise this; the shared
  // refreshMonitor() path still fetches once and (Phase B) also feeds the
  // executive Resumen renderer at its tail when Resumen is active.
  // On entering Resumen, drop the cached analytics so the trend charts refetch
  // fresh (they otherwise ride the cache to stay off the SSE hot loop).
  if (name === "resumen") state.resumenAnalytics = null;
  // Agentes shares the same /analytics/dashboard cache; drop it on entry so the
  // latency percentiles refetch fresh, then ride the cache on SSE/poll.
  if (name === "agentes") state.resumenAnalytics = null;
  // Tareas shares the same /analytics/dashboard cache (success-by-type,
  // runs-over-time); drop it on entry so those refetch fresh, then ride the cache.
  if (name === "tareas") state.resumenAnalytics = null;
  refreshMonitor().catch(() => {});
}

export async function refreshMonitor() {
  if (!$("#monitorMainContent")) return;
  const [metrics, tasks, observability, providers, history, performance] = await Promise.all([
    api("/metrics"),
    api("/tasks"),
    api("/observability"),
    api("/providers"),
    api("/observability/history").catch(() => ({ points: [] })),
    api("/agents/performance").catch(() => []),
  ]);
  state.tasks = tasks;
  state.lastObservability = observability;
  state.lastMetrics = metrics;
  state.providers = providers;
  state.metricsHistory = history;
  state.agentPerformance = performance;
  renderNotifications();
  renderAgentNotifications();
  if (!state.selectedNodeId && observability.nodes?.length) state.selectedNodeId = observability.nodes[0].id;
  renderSummaryMetrics(metrics, tasks, observability);
  renderSystemHealth(observability.health);
  renderExecutionFlow(observability.execution_flow || []);
  renderNodeOverview(observability.nodes || [], metrics, observability.model_usage || []);
  // Human is decoupled: it owns its own light data path (refreshHuman) driven by
  // view activation + SSE — Monitor no longer renders Human panels as a side effect.
  _renderAgentPanels(observability.nodes || [], observability.execution_flow || [], observability.audit_timeline || []);
  renderAuditTimeline(observability.audit_timeline || []);
  renderTaskRows(tasks);
  const selected = tasks.find((t) => t.task_id === state.selected) || tasks[0];
  if (selected) {
    state.selected = selected.task_id;
    await renderDetail(selected);
  }
  // Phase B: the executive Resumen sub-view renders from this same fetch bundle
  // when it's the active sub-view, so SSE/poll updates flow to its KPI tiles
  // without a second EventSource or a duplicate network round-trip.
  if (state.monitorSubview === "resumen") {
    renderResumen({ metrics, observability, performance }).catch(() => {});
  }
  // Phase C: the Agentes analytics + merged config ride the same fetch bundle when
  // Agentes is the active sub-view, so SSE/poll updates flow to the leaderboard,
  // percentiles, cost and skills heatmap without a duplicate round-trip.
  if (state.monitorSubview === "agentes") {
    renderAgentes({ metrics, tasks, observability, performance }).catch(() => {});
  }
  // Phase D: the Tareas analytics band + task table (and any open drill-down)
  // ride the same fetch bundle when Tareas is active, so SSE/poll (task_changed,
  // run_completed) refresh the KPIs/table live without a duplicate round-trip.
  // The open drill-down (state.tareasOpenTask) survives the refresh.
  if (state.monitorSubview === "tareas") {
    renderTareas({ metrics, tasks, observability, performance }).catch(() => {});
  }
  if (state.monitorSubview === "skills") {
    renderSkillsAnalytics().catch((error) => {
      const el = $("#skillsView");
      if (el) el.innerHTML = `<div class="chart-empty">${dvEsc(error.message || "No se pudieron cargar las métricas")}</div>`;
    });
  }
}

// ---- Skills sub-view -------------------------------------------------------
// Recommendations are useful demand signals, but only explicit subtask
// executions count as usage. Keeping both visible avoids inflated adoption and
// success rates.
function buildSkillsAnalyticsFallback(records, catalogSkills, days) {
  const cutoff = days === 0 ? 0 : Date.now() - days * 86400000;
  const rows = new Map();
  const agents = new Map();
  const taskTypes = new Map();
  const timeline = new Map();
  const recommendedTasks = new Set();
  const executedTasks = new Set();
  const rowFor = (rawName) => {
    const name = String(rawName || "").trim();
    if (!name) return null;
    const key = name.toLocaleLowerCase();
    if (!rows.has(key)) rows.set(key, { name, recommended: new Set(), executed: new Set(), executions: 0, successes: 0, failures: 0, latency: 0, cost: 0, agents: {}, task_types: {}, last_used_at: null });
    return rows.get(key);
  };
  (catalogSkills || []).forEach((skill) => rowFor(skill?.name || skill?.slug || skill));
  const addDimension = (map, dimension, skill) => {
    if (!map.has(dimension)) map.set(dimension, {});
    map.get(dimension)[skill] = (map.get(dimension)[skill] || 0) + 1;
  };

  (records || []).forEach((record) => {
    const classification = record.classification || {};
    const taskId = record.task_id || record.id;
    const taskType = classification.intent || "sin tipo";
    const classifiedAt = Date.parse(classification.created_at || record.created_at || 0) || 0;
    if (!cutoff || classifiedAt >= cutoff) {
      const recommendations = new Set([...(classification.recommended_skills || []), ...(classification.subtasks || []).map((subtask) => subtask.recommended_skill).filter(Boolean)]);
      recommendations.forEach((skill) => { const row = rowFor(skill); if (row) { row.recommended.add(taskId); recommendedTasks.add(taskId); } });
    }
    const delegation = record.delegation;
    if (!delegation) return;
    const completedAt = Date.parse(delegation.completed_at || record.updated_at || 0) || 0;
    if (cutoff && completedAt < cutoff) return;
    const subtasks = new Map((classification.subtasks || []).map((subtask) => [subtask.id, subtask]));
    (delegation.executions || []).forEach((execution) => {
      const skill = subtasks.get(execution.subtask_id)?.recommended_skill;
      const row = rowFor(skill);
      if (!row) return;
      const success = String(execution.status || "").toLowerCase() === "completed";
      const agent = execution.model_used || execution.backend || "Agente sin identificar";
      const day = new Date(completedAt || Date.now()).toISOString().slice(0, 10);
      row.executed.add(taskId);
      row.executions += 1;
      row[success ? "successes" : "failures"] += 1;
      row.latency += Math.max(0, Number(execution.latency_ms) || 0);
      row.cost += Math.max(0, Number(execution.estimated_cost_usd) || 0);
      row.agents[agent] = (row.agents[agent] || 0) + 1;
      row.task_types[taskType] = (row.task_types[taskType] || 0) + 1;
      row.last_used_at = new Date(completedAt || Date.now()).toISOString();
      addDimension(agents, agent, row.name);
      addDimension(taskTypes, taskType, row.name);
      const point = timeline.get(day) || { date: day, executions: 0, successes: 0, skills: {} };
      point.executions += 1;
      point.successes += success ? 1 : 0;
      point.skills[row.name] = (point.skills[row.name] || 0) + 1;
      timeline.set(day, point);
      executedTasks.add(taskId);
    });
  });

  const skills = [...rows.values()].map((row) => ({
    name: row.name,
    recommended_tasks: row.recommended.size,
    executed_tasks: row.executed.size,
    executions: row.executions,
    successes: row.successes,
    failures: row.failures,
    success_rate: row.executions ? row.successes / row.executions : null,
    avg_latency_ms: row.executions ? row.latency / row.executions : null,
    total_cost_usd: row.cost,
    agents: row.agents,
    task_types: row.task_types,
    last_used_at: row.last_used_at,
  })).sort((a, b) => b.executions - a.executions || b.recommended_tasks - a.recommended_tasks || a.name.localeCompare(b.name));
  const dimensionRows = (source, key) => [...source.entries()].map(([name, values]) => ({ [key]: name, executions: Object.values(values).reduce((sum, value) => sum + value, 0), skills: values })).sort((a, b) => b.executions - a.executions);
  const executions = skills.reduce((sum, row) => sum + row.executions, 0);
  const successes = skills.reduce((sum, row) => sum + row.successes, 0);
  const activeSkills = skills.filter((row) => row.executions > 0).length;
  return {
    period_days: days,
    generated_at: new Date().toISOString(),
    summary: { catalog_skills: skills.length, recommended_tasks: recommendedTasks.size, executed_tasks: executedTasks.size, executions, active_skills: activeSkills, unused_skills: Math.max(0, skills.length - activeSkills), successes, failures: executions - successes, success_rate: executions ? successes / executions : null, assignment_coverage: recommendedTasks.size ? executedTasks.size / recommendedTasks.size : null },
    skills,
    by_agent: dimensionRows(agents, "agent"),
    by_task_type: dimensionRows(taskTypes, "task_type"),
    timeline: [...timeline.values()].sort((a, b) => a.date.localeCompare(b.date)),
    compatibility_mode: true,
  };
}

async function loadSkillsAnalyticsReport() {
  try {
    return await api(`/analytics/skills?days=${state.skillAnalyticsDays}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    const [tasks, skills] = await Promise.all([
      api("/tasks?limit=500").catch(() => state.tasks || []),
      api("/skills").catch(() => state.skills || []),
    ]);
    return buildSkillsAnalyticsFallback(tasks, skills, state.skillAnalyticsDays);
  }
}

export async function renderSkillsAnalytics() {
  const el = $("#skillsView");
  if (!el) return;
  const report = await loadSkillsAnalyticsReport();
  const summary = report.summary || {};
  const skills = report.skills || [];
  const active = skills.filter((row) => row.executions > 0);
  const pct = (value) => value == null ? "—" : `${Math.round(Number(value) * 100)}%`;
  const periodLabel = state.skillAnalyticsDays === 0 ? "Todo" : `${state.skillAnalyticsDays} días`;
  const periodControls = [7, 30, 90, 365, 0].map((days) =>
    `<button type="button" class="skills-period${state.skillAnalyticsDays === days ? " active" : ""}" data-skills-period="${days}">${days === 0 ? "Todo" : `${days} d`}</button>`
  ).join("");

  const timeline = report.timeline || [];
  const timelineChart = lineChart({
    series: [
      { name: "Ejecuciones", seriesIndex: 0, points: timeline.map((row) => ({ x: row.date, y: row.executions })) },
      { name: "Correctas", seriesIndex: 2, points: timeline.map((row) => ({ x: row.date, y: row.successes })) },
    ],
    xFormat: (value) => String(value).slice(5),
    yFormat: "int",
    yLabel: "Ejecuciones verificadas",
    small: true,
  });
  const ranking = hbarChart({
    rows: active.slice(0, 10).map((row, index) => ({ label: row.name, value: row.executions, seriesIndex: index })),
    valueFormat: "int",
    maxLabelWidth: 160,
  });
  const taskRows = (report.by_task_type || []).slice(0, 10).map((row, index) => ({
    label: row.task_type,
    value: row.executions,
    seriesIndex: index,
  }));
  const taskChart = hbarChart({ rows: taskRows, valueFormat: "int", maxLabelWidth: 180 });

  const topSkills = active.slice(0, 8).map((row) => row.name);
  const agents = (report.by_agent || []).slice(0, 8);
  const agentMatrix = agents.map((agent) => topSkills.map((skill) => Number(agent.skills?.[skill]) || 0));
  const agentHeatmap = heatmap({
    rows: agents.map((row) => row.agent),
    cols: topSkills,
    matrix: agentMatrix,
    valueFormat: "int",
  });

  const detailRows = skills.map((row, seriesIndex) => ({
    ...row,
    seriesIndex,
    agents_label: Object.keys(row.agents || {}).join(", ") || "—",
  }));
  const detailTable = dataTable({
    columns: [
      { key: "name", label: "Skill", dot: true },
      { key: "recommended_tasks", label: "Recomendada", numeric: true },
      { key: "executions", label: "Usos", numeric: true },
      { key: "success_rate", label: "Acierto", numeric: true, format: (value, row) => `${pct(value)} <span class="hint">n=${row.executions}</span>` },
      { key: "agents_label", label: "Agentes" },
      { key: "avg_latency_ms", label: "Latencia", numeric: true, format: (value) => value == null ? "—" : `${Math.round(value)} ms` },
      { key: "total_cost_usd", label: "Coste", numeric: true, format: (value) => `$${Number(value || 0).toFixed(4)}` },
    ],
    rows: detailRows,
  });
  const evolutionSeries = active.map((row, seriesIndex) => ({
    name: row.name,
    seriesIndex,
    points: timeline.map((point) => ({
      x: point.date,
      y: Number(point.skills?.[row.name]) || 0,
    })),
  }));
  const evolutionChart = evolutionSeries.length && timeline.length
    ? lineChart({
        series: evolutionSeries,
        xFormat: (value) => String(value).slice(5),
        yFormat: "int",
        yLabel: "Usos verificados por skill",
        legendAlways: true,
      })
    : `<div class="chart-empty">Todavía no hay ejecuciones verificadas para dibujar la evolución.</div>`;
  const inventoryControls = `<div class="skills-inventory-toggle" role="group" aria-label="Vista del inventario">
    <button type="button" data-skills-inventory-view="table" aria-pressed="${state.skillInventoryView === "table"}" class="${state.skillInventoryView === "table" ? "active" : ""}">Inventario</button>
    <button type="button" data-skills-inventory-view="timeline" aria-pressed="${state.skillInventoryView === "timeline"}" class="${state.skillInventoryView === "timeline" ? "active" : ""}">Evolución</button>
  </div>`;
  const inventoryBody = state.skillInventoryView === "timeline" ? evolutionChart : detailTable;

  el.innerHTML = `<div class="skills-head">
      <div><span class="eyebrow">TELEMETRÍA DE SKILLS</span><h1>Uso y efectividad</h1><p>Qué skills se recomiendan, cuáles se ejecutan y qué agentes obtienen resultados.</p></div>
      <div class="skills-periods" role="group" aria-label="Periodo de análisis">${periodControls}</div>
    </div>
    ${statTileRow([
      { label: "Skills activas", value: summary.active_skills ?? 0, sub: `${summary.catalog_skills ?? 0} identificadas · ${periodLabel}` },
      { label: "Usos verificados", value: summary.executions ?? 0, sub: `${summary.executed_tasks ?? 0} tareas con ejecución` },
      { label: "Tasa de acierto", value: pct(summary.success_rate), sub: `n=${summary.executions ?? 0} ejecuciones` },
      { label: "Cobertura de asignación", value: pct(summary.assignment_coverage), sub: `${summary.recommended_tasks ?? 0} tareas con recomendación` },
      { label: "Sin uso", value: summary.unused_skills ?? 0, sub: "Oportunidad de revisión o retirada" },
    ])}
    <div class="skills-grid skills-grid-primary">
      ${chartFrame({ title: "Actividad", subtitle: "uso real por día", body: timelineChart })}
      ${chartFrame({ title: "Skills más utilizadas", subtitle: "ejecuciones verificadas", body: ranking })}
    </div>
    <div class="skills-grid skills-grid-secondary">
      ${chartFrame({ title: "Reparto por tarea", subtitle: "intención clasificada", body: taskChart })}
      ${chartFrame({ title: "Agente × skill", subtitle: "quién utilizó cada capacidad", body: agentHeatmap })}
    </div>
    ${chartFrame({ title: "Inventario de comportamiento", subtitle: state.skillInventoryView === "timeline" ? "evolución diaria por skill activa" : "recomendación y ejecución no se mezclan", controls: inventoryControls, body: inventoryBody })}
    <p class="skills-method"><b>Método.</b> Un uso solo se contabiliza cuando una subtarea ejecutada declara la skill. La tasa de acierto es completadas / ejecuciones; el tamaño de muestra aparece como <code>n</code>.${report.compatibility_mode ? " <span>Datos calculados en modo compatible; reinicia el backend para activar el endpoint dedicado.</span>" : ""}</p>`;
}

// ---- Resumen sub-view (Phase B) --------------------------------------------
// Executive KPI/analytics dashboard built entirely from the Phase A dataviz
// component library (statTileRow, smallMultiples, hbarChart, chartFrame,
// dataTable) so it is theme-aware (dark/light/amber) and colourblind-safe by
// construction. Accepts an optional pre-fetched {metrics, observability,
// performance} bundle (the refreshMonitor hot path passes it to avoid a
// duplicate round-trip); otherwise it self-fetches. The richer over-time
// analytics (/analytics/dashboard) is cached in state.resumenAnalytics — fetched
// fresh on sub-view entry, reused on SSE/poll so DuckDB stays off the hot loop.
async function renderResumen(pre) {
  const el = $("#resumenView");
  if (!el) return;
  let metrics, observability, performance;
  if (pre && pre.metrics && pre.observability) {
    ({ metrics, observability, performance } = pre);
  } else {
    [metrics, observability, performance] = await Promise.all([
      api("/metrics"),
      api("/observability"),
      api("/agents/performance").catch(() => []),
    ]);
  }
  metrics = metrics || {};
  observability = observability || {};
  performance = performance || [];
  if (!state.resumenAnalytics) {
    state.resumenAnalytics = await api("/analytics/dashboard?days=30").catch(() => null);
  }
  const analytics = state.resumenAnalytics;

  const cl = computeCostLatency(performance);
  const health = observability.health || {};
  const modelUsage = observability.model_usage || [];
  const byLevel = metrics.by_level || {};
  const rot = (analytics && analytics.runs_over_time) || [];

  // --- 1) Hero KPI tiles ---
  let successPct = null;
  if (rot.length) {
    const r = rot.reduce((a, b) => a + Number(b.run_count || 0), 0);
    const s = rot.reduce((a, b) => a + Number(b.success_count || 0), 0);
    successPct = r ? Math.round((s / r) * 100) : 100;
  } else if (cl.tasks) {
    successPct = Math.round((1 - cl.errors / cl.tasks) * 100);
  }
  const successStatus = successPct == null ? undefined
    : successPct >= 90 ? "good" : successPct >= 60 ? "warning" : "critical";
  const activeAgents = performance.filter((p) => Number(p.task_count || 0) > 0).length;
  const humanReview = Number(metrics.human_review_required || 0);
  const totalCost = cl.hasData ? cl.totalCost : Number(metrics.total_estimated_cost_usd || 0);
  const avgLatency = cl.hasData ? cl.avgLatency : Number(health.avg_latency_ms || 0);
  const completed = metrics.by_status?.completed || 0;
  const kpis = statTileRow([
    { label: "Total tareas", value: dvNum(metrics.total_tasks || 0), sub: `${completed} completadas · ${metrics.total_subtasks || 0} subtareas` },
    { label: "Coste total", value: `$${Number(totalCost).toFixed(4)}`, sub: "acumulado (histórico)" },
    { label: "Latencia media", value: `${dvNum(Math.round(avgLatency))} ms`, sub: "ponderada por ejecuciones" },
    { label: "Tasa de éxito", value: successPct == null ? "—" : `${successPct}%`, sub: `${cl.errors} errores`, status: successStatus },
    { label: "Agentes activos", value: dvNum(activeAgents), sub: `${performance.length} proveedores` },
    { label: "En revisión humana", value: dvNum(humanReview), sub: humanReview > 0 ? "requiere atención" : "al día", status: humanReview > 0 ? "warning" : "good" },
  ]);

  // --- 2) Actividad en el tiempo (small multiples, shared x-axis) ---
  const xFmt = (x) => String(x || "").slice(5, 10); // MM-DD
  const smCharts = [
    { title: "Ejecuciones/día", xFormat: xFmt, yFormat: (v) => dvNum(v),
      series: [{ name: "Ejecuciones", seriesIndex: 0, points: rot.map((b) => ({ x: b.bucket, y: Number(b.run_count || 0) })) }] },
    { title: "Coste/día (USD)", xFormat: xFmt, yFormat: (v) => `$${Number(v).toFixed(4)}`,
      series: [{ name: "Coste", seriesIndex: 1, points: rot.map((b) => ({ x: b.bucket, y: Number(b.total_cost || 0) })) }] },
    { title: "Latencia media/día (ms)", xFormat: xFmt, yFormat: (v) => dvNum(v),
      series: [{ name: "Latencia", seriesIndex: 2, points: rot.map((b) => ({ x: b.bucket, y: Math.round(Number(b.avg_latency_ms || 0)) })) }] },
  ];
  const activityBody = rot.length
    ? smallMultiples({ charts: smCharts })
    : `<div class="chart-empty">${analytics ? "sin ejecuciones en la ventana" : "analítica no disponible (DuckDB opcional)"}</div>`;
  const activityFrame = chartFrame({
    title: "Actividad en el tiempo",
    subtitle: analytics ? `últimos ${analytics.window_days || 30} días · una escala Y por métrica` : "",
    body: activityBody,
    table: rot.length ? dataTable({
      columns: [
        { key: "bucket", label: "Día", format: (v) => xFmt(v) },
        { key: "run_count", label: "Ejec", numeric: true },
        { key: "total_cost", label: "Coste", numeric: true, format: (v) => `$${Number(v).toFixed(4)}` },
        { key: "avg_latency_ms", label: "Latencia (ms)", numeric: true, format: (v) => dvNum(Math.round(Number(v) || 0)) },
      ],
      rows: rot,
    }) : null,
  });

  // --- 3) Distribución por nivel de complejidad (ordinal) ---
  const LEVELS = [
    ["level_1_simple", "1 · Simple"], ["level_2_moderate", "2 · Moderado"],
    ["level_3_intermediate", "3 · Intermedio"], ["level_4_complex", "4 · Complejo"],
    ["level_5_critical", "5 · Crítico"],
  ];
  const levelRows = LEVELS.map(([k, lab], i) => ({ label: lab, value: Number(byLevel[k] || 0), seriesIndex: i }));
  const complexityFrame = chartFrame({
    title: "Distribución por nivel de complejidad",
    subtitle: `${dvNum(metrics.total_tasks || 0)} tareas · complejidad media ${dvNum(metrics.average_complexity_score || 0)}`,
    body: hbarChart({ rows: levelRows, valueFormat: (v) => dvNum(v), maxLabelWidth: 96 }),
    table: dataTable({
      columns: [{ key: "label", label: "Nivel", dot: true }, { key: "value", label: "Tareas", numeric: true }],
      rows: levelRows,
    }),
  });

  // --- 4) Reparto por modelo (llamadas; table adds coste/latencia) ---
  const modelRows = modelUsage.slice()
    .sort((a, b) => Number(b.calls || 0) - Number(a.calls || 0))
    .map((m, i) => ({ label: m.model, value: Number(m.calls || 0), seriesIndex: i }));
  const modelFrame = chartFrame({
    title: "Reparto por modelo",
    subtitle: "llamadas por modelo",
    body: modelRows.length ? hbarChart({ rows: modelRows, valueFormat: (v) => dvNum(v), maxLabelWidth: 160 })
      : `<div class="chart-empty">sin llamadas a modelo</div>`,
    table: modelUsage.length ? dataTable({
      columns: [
        { key: "model", label: "Modelo" },
        { key: "calls", label: "Llamadas", numeric: true },
        { key: "estimated_cost", label: "Coste", numeric: true, format: (v) => `$${Number(v || 0).toFixed(4)}` },
        { key: "latency_ms", label: "Latencia (ms)", numeric: true, format: (v) => dvNum(Number(v) || 0) },
      ],
      rows: modelUsage,
    }) : null,
  });

  // --- 5) Salud del sistema (compact status tiles + donut) ---
  const healthPct = health.observed_nodes ? Math.round((health.healthy_nodes / health.observed_nodes) * 100) : 0;
  const tone = health.status === "healthy" ? "ok" : health.status === "error" ? "bad" : "warn";
  const healthTiles = statTileRow([
    { label: "Nodos sanos", value: dvNum(health.healthy_nodes || 0), sub: `de ${health.observed_nodes || 0}`, status: "good" },
    { label: "En aviso", value: dvNum(health.warning_nodes || 0), status: health.warning_nodes > 0 ? "warning" : undefined },
    { label: "En error", value: dvNum(health.error_nodes || 0), status: health.error_nodes > 0 ? "critical" : undefined },
    { label: "Tareas activas", value: dvNum(health.active_tasks || 0), sub: `${health.blocked_tasks || 0} bloqueadas` },
  ]);
  const healthBody = `<div class="resumen-health">
    <div class="resumen-health-ring">
      ${svgDonut(healthPct, { tone, sub: "salud" })}
      <span class="pill ${tone}">${dvEsc(health.status || "—")}</span>
    </div>
    <div class="resumen-health-tiles">${healthTiles}</div>
  </div>`;
  const healthFrame = chartFrame({
    title: "Salud del sistema",
    subtitle: `latencia media ${dvNum(Math.round(health.avg_latency_ms || 0))} ms`,
    body: healthBody,
  });

  const relationSection = analytics ? resumenAgentTaskSection(analytics) : "";

  el.innerHTML = `
    <div class="resumen-kpis">${kpis}</div>
    ${activityFrame}
    ${relationSection}
    <div class="resumen-2up">${complexityFrame}${modelFrame}</div>
    ${healthFrame}`;
}

// ---- Resumen: relación Tareas ↔ Agentes ------------------------------------
// Built on the additive DuckDB cross-tabs (agent_task_matrix / agent_task_flow):
// a KPI band, a metric-switchable Agente×Tipo heatmap, a cost-vs-latency
// efficiency scatter and a Tipo→Agente→Estado flow Sankey. Every mark reads real
// run data; the whole section is omitted when analytics is unavailable/empty.
const RESUMEN_HM_METRICS = {
  volumen: { label: "Volumen", pick: (r) => Number(r.run_count) || 0, fmt: (v) => dvNum(v), note: "ejecuciones por combinación" },
  exito: { label: "Éxito %", pick: (r) => Math.round((Number(r.success_rate) || 0) * 100), fmt: (v) => `${dvNum(v)}%`, note: "% de ejecuciones completadas sin error" },
  coste: { label: "Coste medio", pick: (r) => Number(r.avg_cost_per_run) || 0, fmt: (v) => `$${Number(v).toFixed(4)}`, note: "coste medio por ejecución (USD)" },
  latencia: { label: "Latencia media", pick: (r) => Math.round(Number(r.avg_latency_ms) || 0), fmt: (v) => `${dvNum(v)} ms`, note: "latencia media por ejecución" },
};

const _shortLabel = (s, n = 22) => { s = String(s || "—"); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function resumenAgentTaskPivot(rows, metricKey) {
  const m = RESUMEN_HM_METRICS[metricKey] || RESUMEN_HM_METRICS.volumen;
  const agentVol = {}, typeVol = {};
  rows.forEach((r) => {
    agentVol[r.provider_name] = (agentVol[r.provider_name] || 0) + Number(r.run_count || 0);
    typeVol[r.task_type] = (typeVol[r.task_type] || 0) + Number(r.run_count || 0);
  });
  const agents = Object.keys(agentVol).sort((a, b) => agentVol[b] - agentVol[a]).slice(0, 10);
  const types = Object.keys(typeVol).sort((a, b) => typeVol[b] - typeVol[a]).slice(0, 8);
  const look = new Map(rows.map((r) => [`${r.provider_name}||${r.task_type}`, r]));
  const matrix = agents.map((a) => types.map((t) => { const r = look.get(`${a}||${t}`); return r ? m.pick(r) : 0; }));
  return { agents, types, matrix, valueFormat: m.fmt, note: m.note, label: m.label };
}

// Heatmap body as an HTML string (used for the first paint and on metric switch).
function resumenHeatmapHtml() {
  const rows = (state.resumenAnalytics && state.resumenAnalytics.agent_task_matrix) || [];
  if (!rows.length) return `<div class="chart-empty">sin datos de agente × tarea</div>`;
  const metric = state.resumenHeatMetric || "volumen";
  const p = resumenAgentTaskPivot(rows, metric);
  return heatmap({ rows: p.agents, cols: p.types, matrix: p.matrix, valueFormat: p.valueFormat }) +
    `<p class="dv-hm-note"><b>${dvEsc(p.label)}</b> — ${dvEsc(p.note)}</p>`;
}

// Cost-vs-latency efficiency scatter: one bubble per agent×tipo, hue by tipo.
function resumenScatterHtml(rows) {
  const active = rows.filter((r) => Number(r.run_count) > 0);
  if (!active.length) return `<div class="chart-empty">sin ejecuciones</div>`;
  const types = [...new Set(active.map((r) => r.task_type))].sort();
  const ti = new Map(types.map((t, i) => [t, i]));
  const points = active.map((r) => ({
    x: Math.round(Number(r.avg_latency_ms) || 0),
    y: Number(r.avg_cost_per_run) || 0,
    size: Number(r.run_count) || 1,
    seriesIndex: ti.get(r.task_type),
    tip: `${r.provider_name} · ${r.task_type} · ${dvNum(r.run_count)} ejec · $${Number(r.avg_cost_per_run).toFixed(4)}/ejec · ${dvNum(Math.round(Number(r.avg_latency_ms) || 0))} ms`,
  }));
  return scatterPlot({
    points, xLabel: "Latencia media (ms)", yLabel: "Coste medio (USD)",
    xFormat: (v) => dvNum(v), yFormat: (v) => `$${Number(v).toFixed(4)}`,
  }) + chartLegend({ series: types.map((t, i) => ({ name: t, seriesIndex: i })) });
}

// Tipo → Agente → Estado flow Sankey from the 3-way agent_task_flow grouping.
function resumenSankeyHtml(flow) {
  if (!flow.length) return `<div class="chart-empty">sin datos de flujo</div>`;
  // Sort task types the same way the scatter does so a given tipo keeps ONE hue
  // across both charts (cross-chart colour consistency).
  const types = [...new Set(flow.map((f) => f.task_type))].sort();
  const provs = [...new Set(flow.map((f) => f.provider_name))];
  const stats = [...new Set(flow.map((f) => f.status))];
  const ti = new Map(types.map((t, i) => [t, i]));
  const typeNodes = types.map((t) => ({ id: `t:${t}`, label: _shortLabel(t, 18), color: dvSeries(ti.get(t)) }));
  const provNodes = provs.map((p) => ({ id: `p:${p}`, label: _shortLabel(p, 18) }));
  const statNodes = stats.map((s) => ({ id: `s:${s}`, label: s, color: tareasPillColor(s) }));
  const l1 = {}, l2 = {};
  flow.forEach((f) => {
    l1[`t:${f.task_type}>p:${f.provider_name}`] = (l1[`t:${f.task_type}>p:${f.provider_name}`] || 0) + Number(f.run_count);
    l2[`p:${f.provider_name}>s:${f.status}`] = (l2[`p:${f.provider_name}>s:${f.status}`] || 0) + Number(f.run_count);
  });
  const links = [];
  Object.entries(l1).forEach(([k, v]) => { const [from, to] = k.split(">"); links.push({ from, to, value: v, color: dvSeries(ti.get(from.slice(2))) }); });
  Object.entries(l2).forEach(([k, v]) => { const [from, to] = k.split(">"); links.push({ from, to, value: v, color: tareasPillColor(to.slice(2)) }); });
  return sankeyChart({
    columns: [
      { title: "Tipo de tarea", nodes: typeNodes },
      { title: "Agente", nodes: provNodes },
      { title: "Estado", nodes: statNodes },
    ],
    links,
  });
}

// KPI band summarising the agent↔task relationship (top agent/type/combo, cost
// focus, coverage, concentration) — all derived from the same cross-tab.
function resumenRelationKpis(rows) {
  const totalRuns = rows.reduce((a, r) => a + Number(r.run_count || 0), 0) || 1;
  const agentVol = {}, typeVol = {};
  rows.forEach((r) => {
    agentVol[r.provider_name] = (agentVol[r.provider_name] || 0) + Number(r.run_count || 0);
    typeVol[r.task_type] = (typeVol[r.task_type] || 0) + Number(r.run_count || 0);
  });
  const topAgent = Object.entries(agentVol).sort((a, b) => b[1] - a[1])[0];
  const topType = Object.entries(typeVol).sort((a, b) => b[1] - a[1])[0];
  const topCombo = rows.slice().sort((a, b) => Number(b.run_count) - Number(a.run_count))[0];
  const costCombo = rows.slice().sort((a, b) => Number(b.total_cost) - Number(a.total_cost))[0];
  const nAgents = Object.keys(agentVol).length, nTypes = Object.keys(typeVol).length;
  const concentration = topCombo ? Math.round((Number(topCombo.run_count) / totalRuns) * 100) : 0;
  return statTileRow([
    { label: "Agente más activo", value: _shortLabel(topAgent ? topAgent[0] : "—", 16), sub: topAgent ? `${Math.round((topAgent[1] / totalRuns) * 100)}% de ejecuciones` : "—" },
    { label: "Tipo dominante", value: _shortLabel(topType ? topType[0] : "—", 16), sub: topType ? `${dvNum(topType[1])} ejecuciones` : "—" },
    { label: "Combinación estrella", value: topCombo ? `${dvNum(topCombo.run_count)} ejec` : "—", sub: topCombo ? `${_shortLabel(topCombo.provider_name, 12)} · ${_shortLabel(topCombo.task_type, 12)}` : "—" },
    { label: "Foco de coste", value: costCombo ? `$${Number(costCombo.total_cost).toFixed(4)}` : "—", sub: costCombo ? `${_shortLabel(costCombo.provider_name, 12)} · ${_shortLabel(costCombo.task_type, 12)}` : "—" },
    { label: "Cobertura", value: `${nAgents}×${nTypes}`, sub: `${rows.length} combinaciones activas` },
    { label: "Concentración", value: `${concentration}%`, sub: "en la combinación top", status: concentration >= 60 ? "warning" : undefined },
  ]);
}

function resumenAgentTaskSection(analytics) {
  const rows = (analytics && analytics.agent_task_matrix) || [];
  const flow = (analytics && analytics.agent_task_flow) || [];
  if (!rows.length) return ""; // omit entirely when the cross-tab is empty
  const metric = state.resumenHeatMetric || "volumen";
  const switchHtml = `<div class="dv-seg" role="tablist" aria-label="Métrica del heatmap">${Object.entries(RESUMEN_HM_METRICS).map(([k, m]) => `<button type="button" class="dv-seg-btn${k === metric ? " active" : ""}" data-resumen-hm-metric="${k}" role="tab" aria-selected="${k === metric}">${dvEsc(m.label)}</button>`).join("")}</div>`;
  const heatFrame = chartFrame({
    title: "Agente × Tipo de tarea",
    subtitle: "especialización y carga · elige la métrica",
    controls: switchHtml,
    body: `<div id="resumenHeatmap" class="resumen-heatmap">${resumenHeatmapHtml()}</div>`,
  });
  // Colour-heavy frames ship a "ver tabla" view: the dataviz method requires a
  // table (or direct labels) as relief whenever categorical hues sit below the
  // 3:1 contrast floor — true for several series on both surfaces.
  const scatterFrame = chartFrame({
    title: "Eficiencia: coste vs latencia",
    subtitle: "cada burbuja es agente × tipo · tamaño = volumen",
    body: resumenScatterHtml(rows),
    table: dataTable({
      columns: [
        { key: "provider_name", label: "Agente" },
        { key: "task_type", label: "Tipo" },
        { key: "run_count", label: "Ejec.", numeric: true, format: (v) => dvNum(v) },
        { key: "avg_cost_per_run", label: "Coste/ejec.", numeric: true, format: (v) => `$${Number(v).toFixed(4)}` },
        { key: "avg_latency_ms", label: "Latencia media", numeric: true, format: (v) => `${dvNum(Math.round(Number(v) || 0))} ms` },
        { key: "success_rate", label: "Éxito %", numeric: true, format: (v) => `${Math.round((Number(v) || 0) * 100)}%` },
      ],
      rows: rows.filter((r) => Number(r.run_count) > 0),
      defaultSort: "run_count",
    }),
  });
  const sankeyFrame = chartFrame({
    title: "Flujo: tipo → agente → estado",
    subtitle: "reparto de ejecuciones por la cadena",
    body: resumenSankeyHtml(flow),
    table: dataTable({
      columns: [
        { key: "task_type", label: "Tipo de tarea" },
        { key: "provider_name", label: "Agente" },
        { key: "status", label: "Estado" },
        { key: "run_count", label: "Ejec.", numeric: true, format: (v) => dvNum(v) },
      ],
      rows: flow,
      defaultSort: "run_count",
    }),
  });
  return `<section class="resumen-relation">
    <div class="resumen-relation-head">
      <span class="eyebrow">Relación Tareas ↔ Agentes</span>
      <h3>Quién ejecuta qué, con qué eficiencia y cómo fluye</h3>
    </div>
    <div class="resumen-relation-kpis">${resumenRelationKpis(rows)}</div>
    ${heatFrame}
    <div class="resumen-2up">${scatterFrame}${sankeyFrame}</div>
  </section>`;
}

// Metric switch: repaint only the heatmap body (keeps the rest of Resumen stable).
function updateResumenHeatmap(metric) {
  if (!RESUMEN_HM_METRICS[metric]) return;
  state.resumenHeatMetric = metric;
  const box = $("#resumenHeatmap");
  if (box) box.innerHTML = resumenHeatmapHtml();
  $$("[data-resumen-hm-metric]").forEach((b) => {
    const on = b.dataset.resumenHmMetric === metric;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
}

function _renderAgentPanels(nodes, flow, audit) {
  const node = nodes.find((n) => n.id === state.selectedNodeId) || nodes[0];
  renderMonitorSidePanel(node, flow, audit);
}

// ---- Agentes sub-view (Phase C) --------------------------------------------
// Data-science-grade per-agent analytics (leaderboard, latency percentiles,
// cost, skills heatmap) built from the Phase A dataviz library, ABOVE the merged
// operational config/console (relocated from the old standalone #view-agents).
// Colour follows the ENTITY, not rank: a stable provider→seriesIndex map
// (alphabetical, deterministic) gives every agent the SAME hue in the leaderboard
// dot, the cost bar and the percentile row. Accepts the refreshMonitor bundle to
// avoid a duplicate round-trip; the richer percentile analytics rides the shared
// state.resumenAnalytics cache (same /analytics/dashboard endpoint).
async function renderAgentes(pre) {
  const el = $("#agentesView");
  // Analytics ONLY. Agent configuration/console/policies is a separate concept
  // and lives in its own top-nav "Agentes" tab (#view-agents / renderAgentsView),
  // not mixed in here — metrics and configuration are deliberately kept apart.
  if (!el) return;

  let metrics, tasks, observability, performance;
  if (pre && pre.observability) {
    ({ metrics, tasks, observability, performance } = pre);
  } else {
    [metrics, tasks, observability, performance] = await Promise.all([
      api("/metrics").catch(() => ({})),
      api("/tasks").catch(() => []),
      api("/observability").catch(() => ({})),
      api("/agents/performance").catch(() => []),
    ]);
  }
  metrics = metrics || {};
  tasks = Array.isArray(tasks) ? tasks : [];
  observability = observability || {};
  performance = (performance || []).filter((p) => p && p.provider_name);
  if (!state.resumenAnalytics) {
    state.resumenAnalytics = await api("/analytics/dashboard?days=30").catch(() => null);
  }
  const analytics = state.resumenAnalytics || {};
  const percentiles = (analytics.latency_percentiles || []).filter((p) => p && p.provider_name);
  const leaderboard = (analytics.provider_leaderboard || []).filter((p) => p && p.provider_name);
  const nodes = (observability.nodes || []);

  // --- Stable ENTITY→seriesIndex map (alphabetical, never rank-based) ---
  const names = new Set();
  performance.forEach((p) => names.add(p.provider_name));
  percentiles.forEach((p) => names.add(p.provider_name));
  leaderboard.forEach((p) => names.add(p.provider_name));
  const ordered = [...names].sort((a, b) => a.localeCompare(b));
  const seriesOf = new Map(ordered.map((name, i) => [name, i]));
  const si = (name) => seriesOf.has(name) ? seriesOf.get(name) : 0;

  // --- Per-agent aggregate rows (join /agents/performance as the stable base) ---
  const rows = performance.map((p) => {
    const tasks = Number(p.task_count || 0);
    const errors = Number(p.error_count || 0);
    const success = tasks ? (1 - errors / tasks) : 1;
    const cost = Number(p.total_cost || 0);
    return {
      provider: p.provider_name,
      seriesIndex: si(p.provider_name),
      tasks,
      success,
      successPct: `${(success * 100).toFixed(tasks ? 1 : 0)}%`,
      avgLatency: Math.round(Number(p.avg_latency_ms || 0)),
      cost,
      costPer: tasks ? cost / tasks : 0,
    };
  });

  // --- KPI tile row (executive glance) ---
  const active = rows.filter((r) => r.tasks > 0);
  const mostUsed = active.slice().sort((a, b) => b.tasks - a.tasks)[0];
  const mostExpensive = rows.slice().sort((a, b) => b.cost - a.cost)[0];
  // Global p50: run-weighted mean of per-agent p50 (honest aggregate label).
  let p50Weighted = 0, p50Runs = 0;
  percentiles.forEach((p) => {
    const rc = Number(p.run_count || 0);
    p50Weighted += Number(p.p50_latency_ms || 0) * rc;
    p50Runs += rc;
  });
  const globalP50 = p50Runs ? Math.round(p50Weighted / p50Runs) : 0;
  const kpis = statTileRow([
    { label: "Agentes activos", value: dvNum(active.length), sub: `${rows.length} en catálogo de ejecución` },
    { label: "Agente más usado", value: mostUsed ? mostUsed.provider : "—", sub: mostUsed ? `${dvNum(mostUsed.tasks)} ejecuciones` : "sin ejecuciones" },
    { label: "Agente más caro", value: mostExpensive && mostExpensive.cost > 0 ? mostExpensive.provider : "—", sub: mostExpensive ? `$${mostExpensive.cost.toFixed(4)} acumulado` : "" },
    { label: "Latencia p50 global", value: `${dvNum(globalP50)} ms`, sub: "ponderada por ejecuciones" },
  ]);

  // --- 1) Leaderboard (sortable dataTable, default: ejecuciones desc) ---
  const leaderRows = rows.map((r) => ({
    provider: r.provider,
    seriesIndex: r.seriesIndex,
    tasks: r.tasks,
    successPct: r.successPct,
    _success: r.success,
    avgLatency: r.avgLatency,
    cost: r.cost,
    costPer: r.costPer,
  }));
  const leaderMode = state.agentesLeaderboardMode || localStorage.getItem("karajan-agentes-leaderboard-mode") || "table";
  const leaderTable = leaderRows.length ? dataTable({
    columns: [
      { key: "provider", label: "Agente", dot: true },
      { key: "tasks", label: "Ejecuciones", numeric: true, format: (v) => dvNum(v) },
      { key: "successPct", label: "Éxito %", numeric: true, align: "right",
        format: (v) => `<span class="tnum">${dvEsc(v)}</span>`, },
      { key: "avgLatency", label: "Latencia media", numeric: true, format: (v) => `<span class="tnum">${dvNum(v)} ms</span>` },
      { key: "cost", label: "Coste total", numeric: true, format: (v) => `<span class="tnum">$${Number(v).toFixed(4)}</span>` },
      { key: "costPer", label: "Coste/ejec.", numeric: true, format: (v) => `<span class="tnum">$${Number(v).toFixed(4)}</span>` },
    ],
    rows: leaderRows,
    defaultSort: "tasks",
  }) : `<div class="chart-empty">sin ejecuciones registradas</div>`;
  const leaderFrame = chartFrame({
    title: "Leaderboard de agentes",
    subtitle: leaderMode === "graph" ? "ranking visual por ejecuciones" : "comparación por entidad · ordena cualquier columna",
    controls: `<button type="button" class="dv-table-toggle" data-agentes-leader-toggle>${leaderMode === "graph" ? "ver tabla" : "ver gráfico"}</button>`,
    body: `<div class="agent-leader-view" data-agent-leader-view="table"${leaderMode === "graph" ? " hidden" : ""}>${leaderTable}</div>
      <div class="agent-leader-view" data-agent-leader-view="graph"${leaderMode === "graph" ? "" : " hidden"}>${agentLeaderboardGraph(leaderRows)}</div>`,
  });
  // Default sort direction desc for tasks: dataTable defaults dir=1 (asc) — flip once.
  // (Handled by wrapping: we set defaultSort then the table starts ascending; users
  // click to toggle. To land on desc, we post-adjust below after injection.)

  // --- 2) Latencia por agente (percentiles) — dotRangePlot, fallback hbar ---
  const rangeRows = percentiles.map((p) => ({
    label: p.provider_name,
    seriesIndex: si(p.provider_name),
    p50: Number(p.p50_latency_ms || 0),
    p90: Number(p.p90_latency_ms || 0),
    p99: Number(p.p99_latency_ms || 0),
  })).sort((a, b) => b.p50 - a.p50);
  let latencyBody;
  if (rangeRows.length) {
    latencyBody = dotRangePlot({ rows: rangeRows, valueFormat: (v) => dvNum(Math.round(v)), unit: " ms" });
  } else if (rows.length) {
    // Fallback: grouped-ish hbar of avg latency per agent when no percentiles.
    latencyBody = hbarChart({
      rows: rows.map((r) => ({ label: r.provider, value: r.avgLatency, seriesIndex: r.seriesIndex })),
      valueFormat: (v) => `${dvNum(v)} ms`, maxLabelWidth: 160,
    });
  } else {
    latencyBody = `<div class="chart-empty">sin datos de latencia</div>`;
  }
  const latencyFrame = chartFrame({
    title: "Latencia por agente",
    subtitle: rangeRows.length ? "percentiles p50 · p90 · p99 (ms)" : "latencia media (ms) · percentiles no disponibles",
    body: latencyBody,
    table: rangeRows.length ? dataTable({
      columns: [
        { key: "label", label: "Agente", dot: true },
        { key: "p50", label: "p50 (ms)", numeric: true, format: (v) => dvNum(Math.round(v)) },
        { key: "p90", label: "p90 (ms)", numeric: true, format: (v) => dvNum(Math.round(v)) },
        { key: "p99", label: "p99 (ms)", numeric: true, format: (v) => dvNum(Math.round(v)) },
      ],
      rows: rangeRows,
    }) : null,
  });

  const skillsFrame = chartFrame({
    title: "Skills por prompt en el tiempo",
    subtitle: "clic en una tarea para ver matriz skill × agente",
    body: agentSkillsTimeline(tasks, nodes),
  });

  el.innerHTML = `
    <div class="agentes-kpis">${kpis}</div>
    <div class="agentes-analytics-row">${leaderFrame}${latencyFrame}</div>
    ${skillsFrame}`;

  // Land the leaderboard on ejecuciones DESC (dataTable starts a fresh sort asc).
  const lead = el.querySelector(".agentes-analytics-row .dv-frame:first-child .dv-table[data-dv-table]");
  if (lead) {
    const th = lead.querySelector('th[data-dv-sort="tasks"]');
    if (th) { dvSortTable(th); } // asc→ now desc handled by toggle logic on re-entry
  }
}

function agentLeaderboardGraph(rows) {
  const clean = (rows || []).slice().sort((a, b) => Number(b.tasks || 0) - Number(a.tasks || 0));
  if (!clean.length) return `<div class="chart-empty">sin ejecuciones registradas</div>`;
  const maxTasks = Math.max(1, ...clean.map((r) => Number(r.tasks || 0)));
  const maxLatency = Math.max(1, ...clean.map((r) => Number(r.avgLatency || 0)));
  const rowH = 58;
  const top = 50;
  const left = 235;
  const right = 230;
  const width = 980;
  const plotW = width - left - right;
  const height = top + clean.length * rowH + 58;
  const taskTicks = [0, Math.ceil(maxTasks / 2), maxTasks];
  const latencyTicks = [0, Math.ceil(maxLatency / 2), maxLatency];
  const taskTickHtml = taskTicks.map((v) => {
    const x = left + (v / maxTasks) * plotW;
    return `<g>
      <line class="agent-chart-grid" x1="${x}" y1="${top - 18}" x2="${x}" y2="${height - 50}"></line>
      <text class="agent-chart-tick" x="${x}" y="${top - 25}" text-anchor="middle">${dvEsc(dvNum(v))}</text>
    </g>`;
  }).join("");
  const latencyTickHtml = latencyTicks.map((v) => {
    const x = left + (v / maxLatency) * plotW;
    return `<g>
      <line class="agent-chart-lat-grid" x1="${x}" y1="${top - 18}" x2="${x}" y2="${height - 50}"></line>
      <text class="agent-chart-tick latency" x="${x}" y="${height - 22}" text-anchor="middle">${dvEsc(dvNum(v))}</text>
    </g>`;
  }).join("");
  const rowsHtml = clean.map((r, index) => {
    const y = top + index * rowH;
    const barW = Math.max(3, (Number(r.tasks || 0) / maxTasks) * plotW);
    const latencyX = left + (Number(r.avgLatency || 0) / maxLatency) * plotW;
    const color = dvSeries(r.seriesIndex);
    const label = r.provider.length > 26 ? `${r.provider.slice(0, 25)}…` : r.provider;
    const success = Math.max(0, Math.min(100, Number(r._success || 0) * 100));
    return `<g class="agent-chart-row">
      <text class="agent-chart-rank" x="20" y="${y + 22}">#${index + 1}</text>
      <circle cx="58" cy="${y + 18}" r="4.5" fill="${color}"></circle>
      <text class="agent-chart-label" x="72" y="${y + 22}">${dvEsc(label)}</text>
      <rect class="agent-chart-track" x="${left}" y="${y + 8}" width="${plotW}" height="16" rx="4"></rect>
      <rect class="agent-chart-bar" x="${left}" y="${y + 8}" width="${barW.toFixed(1)}" height="16" rx="4" fill="${color}"></rect>
      <line class="agent-chart-lat-line" x1="${latencyX.toFixed(1)}" y1="${y + 2}" x2="${latencyX.toFixed(1)}" y2="${y + 30}"></line>
      <circle class="agent-chart-lat-dot" cx="${latencyX.toFixed(1)}" cy="${y + 16}" r="4.2"></circle>
      <text class="agent-chart-small-label" x="${left}" y="${y + 39}">éxito</text>
      <rect class="agent-chart-success-track" x="${left + 40}" y="${y + 34}" width="96" height="6" rx="3"></rect>
      <rect class="agent-chart-success" x="${left + 40}" y="${y + 34}" width="${(success * 0.96).toFixed(1)}" height="6" rx="3"></rect>
      <text class="agent-chart-meta" x="${left + 145}" y="${y + 38}">${dvEsc(r.successPct)}</text>
      <text class="agent-chart-value" x="${left + plotW + 18}" y="${y + 14}">${dvEsc(dvNum(r.tasks))} ejec.</text>
      <text class="agent-chart-meta" x="${left + plotW + 18}" y="${y + 34}">${dvNum(r.avgLatency)} ms</text>
      <text class="agent-chart-cost" x="${width - 14}" y="${y + 14}" text-anchor="end">$${Number(r.cost || 0).toFixed(4)}</text>
      <text class="agent-chart-meta" x="${width - 14}" y="${y + 34}" text-anchor="end">$${Number(r.costPer || 0).toFixed(4)}/ejec.</text>
    </g>`;
  }).join("");
  return `<div class="agent-leader-chart" role="img" aria-label="Gráfica de doble eje X del leaderboard de agentes: ejecuciones, latencia, éxito y coste">
    <svg viewBox="0 0 ${width} ${height}" style="height:${height}px" preserveAspectRatio="xMidYMin meet">
      <text class="agent-chart-axis-title" x="${left}" y="14">Ejecuciones</text>
      <text class="agent-chart-axis-title latency" x="${left}" y="${height - 36}">Latencia media (ms)</text>
      <text class="agent-chart-axis-title cost" x="${width - 14}" y="14" text-anchor="end">Coste</text>
      ${taskTickHtml}
      ${latencyTickHtml}
      ${rowsHtml}
    </svg>
    <div class="agent-chart-legend">
      <span><i class="bar"></i> ejecuciones</span>
      <span><i class="dot"></i> latencia media</span>
      <span><i class="success"></i> éxito</span>
      <span>coste total y coste/ejec. a la derecha</span>
    </div>
  </div>`;
}

function taskSkillSet(task) {
  const c = task?.classification || {};
  const skills = new Set((c.recommended_skills || []).filter(Boolean));
  (c.subtasks || []).forEach((sub) => {
    if (sub?.recommended_skill) skills.add(sub.recommended_skill);
  });
  return [...skills].sort();
}

function taskPromptLabel(task) {
  const c = task?.classification || {};
  const text = task?.prompt || c.original_prompt || c.prompt || c.intent || task?.task_id || "Tarea";
  return String(text).replace(/\s+/g, " ").trim();
}

function taskAgentSkillCounts(task) {
  const c = task?.classification || {};
  const subtasks = c.subtasks || [];
  const bySubtask = new Map(subtasks.map((sub) => [sub.id, sub]));
  const counts = {};
  const add = (agent, skill, n = 1) => {
    if (!agent || !skill) return;
    counts[agent] ||= {};
    counts[agent][skill] = (counts[agent][skill] || 0) + n;
  };
  (task?.delegation?.executions || []).forEach((ex) => {
    const agent = ex.model_used || ex.backend || "sin agente";
    const sub = bySubtask.get(ex.subtask_id);
    if (sub?.recommended_skill) add(agent, sub.recommended_skill);
    else taskSkillSet(task).forEach((skill) => add(agent, skill, 0));
  });
  if (!Object.keys(counts).length) {
    const agent = c.classified_by || c.recommended_model || "sin ejecución";
    taskSkillSet(task).forEach((skill) => add(agent, skill));
  }
  return counts;
}

function skillMatrixFromTasks(tasks, selectedTaskId) {
  const selected = selectedTaskId ? tasks.find((task) => task.task_id === selectedTaskId) : null;
  const source = selected ? [selected] : tasks;
  const counts = {};
  source.forEach((task) => {
    const taskCounts = taskAgentSkillCounts(task);
    Object.entries(taskCounts).forEach(([agent, skills]) => {
      counts[agent] ||= {};
      Object.entries(skills).forEach(([skill, value]) => {
        counts[agent][skill] = (counts[agent][skill] || 0) + Number(value || 0);
      });
    });
  });
  const rows = Object.keys(counts).sort();
  const cols = [...new Set(rows.flatMap((row) => Object.keys(counts[row] || {})))].sort();
  const matrix = rows.map((row) => cols.map((col) => Number(counts[row]?.[col] || 0)));
  return { rows, cols, matrix, selected };
}

function agentSkillsTimeline(tasks, nodes = []) {
  const withSkills = (tasks || [])
    .filter((task) => task && task.task_id && taskSkillSet(task).length)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  if (!withSkills.length) {
    const skillNodes = (nodes || []).filter((n) => n.skill_usage && Object.keys(n.skill_usage).length);
    const skillCols = [...new Set(skillNodes.flatMap((n) => Object.keys(n.skill_usage)))].sort();
    if (!skillNodes.length || !skillCols.length) return `<div class="chart-empty">aún no se han usado skills</div>`;
    const hmRows = skillNodes.map((n) => n.name || n.active_model || "—");
    const matrix = skillNodes.map((n) => skillCols.map((s) => Number(n.skill_usage[s] || 0)));
    return heatmap({ rows: hmRows, cols: skillCols, matrix, valueFormat: (v) => dvNum(v) });
  }
  if (state.agentesSkillTask && !withSkills.some((task) => task.task_id === state.agentesSkillTask)) {
    state.agentesSkillTask = null;
  }
  const selectedId = state.agentesSkillTask || withSkills[withSkills.length - 1].task_id;
  state.agentesSkillTask = selectedId;
  const allSkills = [...new Set(withSkills.flatMap(taskSkillSet))].sort();
  const width = Math.max(880, 160 + withSkills.length * 96);
  const height = 320;
  const pad = { l: 58, r: 28, t: 24, b: 78 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const xAt = (i) => pad.l + (withSkills.length === 1 ? plotW / 2 : (plotW * i) / (withSkills.length - 1));
  const countsByTask = withSkills.map((task) => {
    const counts = {};
    const taskCounts = taskAgentSkillCounts(task);
    Object.values(taskCounts).forEach((skills) => {
      Object.entries(skills).forEach(([skill, value]) => {
        counts[skill] = (counts[skill] || 0) + Number(value || 0);
      });
    });
    taskSkillSet(task).forEach((skill) => { if (!counts[skill]) counts[skill] = 1; });
    return counts;
  });
  const maxY = Math.max(1, ...countsByTask.flatMap((counts) => Object.values(counts)));
  const yAt = (v) => pad.t + plotH * (1 - (Number(v) || 0) / maxY);
  const yTicks = [0, Math.ceil(maxY / 2), maxY];
  const grid = yTicks.map((v) => {
    const y = yAt(v);
    return `<g><line class="agent-skill-grid" x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}"></line><text class="agent-skill-axis" x="${pad.l - 10}" y="${y}" text-anchor="end">${dvEsc(dvNum(v))}</text></g>`;
  }).join("");
  const lines = allSkills.map((skill, si2) => {
    const points = countsByTask.map((counts, i) => `${xAt(i).toFixed(1)},${yAt(counts[skill] || 0).toFixed(1)}`).join(" ");
    const color = dvSeries(si2);
    const circles = countsByTask.map((counts, i) => {
      const x = xAt(i), y = yAt(counts[skill] || 0);
      const active = withSkills[i].task_id === selectedId;
      return `<circle class="agent-skill-point${active ? " active" : ""}" data-agent-skill-task="${dvEsc(withSkills[i].task_id)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${active ? 5.4 : 4.2}" fill="${color}"><title>${dvEsc(skill)} · ${dvEsc(taskPromptLabel(withSkills[i]))}: ${dvNum(counts[skill] || 0)}</title></circle>`;
    }).join("");
    return `<g><polyline class="agent-skill-line" points="${points}" style="stroke:${color}"></polyline>${circles}</g>`;
  }).join("");
  const xLabels = withSkills.map((task, i) => {
    const x = xAt(i);
    const label = taskPromptLabel(task);
    const short = label.length > 18 ? `${label.slice(0, 17)}…` : label;
    const active = task.task_id === selectedId;
    return `<g class="agent-skill-xlabel${active ? " active" : ""}" data-agent-skill-task="${dvEsc(task.task_id)}">
      <line class="agent-skill-xmark" x1="${x}" y1="${pad.t + plotH}" x2="${x}" y2="${pad.t + plotH + 6}"></line>
      <text class="agent-skill-axis x" x="${x}" y="${pad.t + plotH + 20}" text-anchor="middle">${dvEsc(String(task.created_at || "").slice(5, 10) || "—")}</text>
      <text class="agent-skill-axis prompt" x="${x}" y="${pad.t + plotH + 38}" text-anchor="middle">${dvEsc(short)}</text>
    </g>`;
  }).join("");
  const legend = allSkills.map((skill, i) => `<span><i style="background:${dvSeries(i)}"></i>${dvEsc(skill)}</span>`).join("");
  const { rows, cols, matrix, selected } = skillMatrixFromTasks(withSkills, selectedId);
  const matrixHtml = rows.length && cols.length
    ? heatmap({ rows, cols, matrix, valueFormat: (v) => dvNum(v) })
    : `<div class="chart-empty">sin matriz para esta tarea</div>`;
  return `<div class="agent-skill-workbench">
    <div class="agent-skill-linechart">
      <svg viewBox="0 0 ${width} ${height}" style="width:${width}px;height:${height}px" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Uso de skills por prompt en el tiempo">
        <text class="agent-skill-title" x="${pad.l}" y="12">Uso por prompt</text>
        <text class="agent-skill-axis" x="10" y="${pad.t + 4}">usos</text>
        ${grid}
        <line class="agent-skill-base" x1="${pad.l}" y1="${pad.t + plotH}" x2="${width - pad.r}" y2="${pad.t + plotH}"></line>
        ${lines}
        ${xLabels}
      </svg>
      <div class="agent-skill-legend">${legend}</div>
    </div>
    <div class="agent-skill-matrix">
      <div class="agent-skill-matrix-head">
        <span class="eyebrow">Matriz skill × agente</span>
        <b>${dvEsc(selected ? taskPromptLabel(selected) : "Todas las tareas")}</b>
      </div>
      ${matrixHtml}
    </div>
  </div>`;
}

// ---- Tareas sub-view (Phase D) ---------------------------------------------
// Task analytics band + FTS search + a full-width, Langfuse-style audit/trace
// drill-down, all composed from the Phase A dataviz library (theme-aware,
// colourblind-safe). Rides the refreshMonitor() fetch bundle so SSE/poll keep
// the KPIs + table + any open drill-down live. The open drill-down
// (state.tareasOpenTask) survives a background refresh — the user is never
// yanked out of an audit view when a task_changed/run_completed event fires.

const _TAREAS_TONE = {
  completed: "good", succeeded: "good", success: "good",
  failed: "critical", error: "critical",
  delegated: "warning", classified: "warning", queued: "warning", running: "warning",
  waiting_human: "serious", requires_human_review: "serious", blocked: "serious",
};

function tareasTone(status) { return _TAREAS_TONE[String(status || "").toLowerCase()] || null; }

function tareasPillColor(status) { const st = dvStatus(tareasTone(status)); return st ? st.v : "var(--muted)"; }

function tareasPill(status) {
  const st = dvStatus(tareasTone(status));
  return `<span class="tareas-pill" style="--pc:${st ? st.v : "var(--muted)"}">${st ? `<span class="dv-status-ico">${st.icon}</span>` : ""}${dvEsc(status || "—")}</span>`;
}

function taskCost(t) { return Number((t.delegation || {}).total_estimated_cost_usd || 0); }

function taskLatency(t) { return Number((t.delegation || {}).total_latency_ms || 0); }

const _tLevelShort = (lvl) => String(lvl || "").replace("level_", "N").replace(/_.*/, "");

async function renderTareas(pre) {
  const el = $("#tareasView");
  if (!el) return;
  initTareas();
  let metrics, tasks, performance;
  if (pre && Array.isArray(pre.tasks)) {
    ({ metrics, tasks, performance } = pre);
  } else {
    [metrics, tasks, performance] = await Promise.all([
      api("/metrics").catch(() => ({})),
      api("/tasks").catch(() => []),
      api("/agents/performance").catch(() => []),
    ]);
  }
  metrics = metrics || {};
  tasks = Array.isArray(tasks) ? tasks : [];
  performance = performance || [];
  state.tasks = tasks;
  if (!state.resumenAnalytics) {
    state.resumenAnalytics = await api("/analytics/dashboard?days=30").catch(() => null);
  }
  const analytics = state.resumenAnalytics;

  const band = tareasBand(tasks, metrics, analytics);

  // Keep the task table as the primary surface. When a task is open, the view
  // splits 50/50: list on the left, trace/detail on the right.
  let openTask = null;
  if (state.tareasOpenTask) {
    openTask = tasks.find((t) => t.task_id === state.tareasOpenTask) || null;
    if (!openTask) state.tareasOpenTask = null;
  }
  const listPane = `<div class="tareas-list-pane">${tareasList(tasks)}</div>`;
  const detailPane = openTask ? `<aside class="tareas-detail-pane">${tareasDetailShell(openTask)}</aside>` : "";
  el.innerHTML = `${band}<div id="tareasMain" class="tareas-main${openTask ? " has-detail" : ""}">${listPane}${detailPane}</div>`;

  if (openTask) {
    const selectedRow = $(`.tareas-idlink[data-task="${CSS.escape(openTask.task_id)}"]`)?.closest("tr");
    selectedRow?.classList.add("selected");
    renderTareasDetail(openTask).catch(() => {});
  } else {
    const input = $("#tareasSearch");
    if (input && state.tareasQuery) input.value = state.tareasQuery;
  }
}

// --- Analytics band: KPI tiles + compact analytics KPIs ----------------------
function tareasBand(tasks, metrics, analytics) {
  const total = tasks.length;
  const byStatus = {};
  let costSum = 0, latSum = 0, latN = 0;
  tasks.forEach((t) => {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    costSum += taskCost(t);
    const l = taskLatency(t);
    if (l > 0) { latSum += l; latN += 1; }
  });
  const completed = byStatus.completed || 0;
  const failed = byStatus.failed || 0;
  const humanReview = Number(metrics.human_review_required || 0);
  const avgLat = latN ? Math.round(latSum / latN) : 0;
  // Volumen en el tiempo (runs_over_time, else task created_at bucketed by day)
  // as a compact KPI instead of a chart/table.
  const rot = (analytics && analytics.runs_over_time) || [];
  let volumeTotal = 0, volumeSub = "sin actividad", volumeDelta = null;
  if (rot.length) {
    volumeTotal = rot.reduce((acc, b) => acc + Number(b.run_count || 0), 0);
    const volumeLast = Number(rot[rot.length - 1]?.run_count || 0);
    const prev = Number(rot[rot.length - 2]?.run_count || 0);
    volumeDelta = volumeLast - prev;
    volumeSub = `${rot.length} días activos · último ${String(rot[rot.length - 1]?.bucket || "").slice(5, 10)}`;
  } else {
    const buckets = {};
    tasks.forEach((t) => { const d = String(t.created_at || "").slice(0, 10); if (d) buckets[d] = (buckets[d] || 0) + 1; });
    const days = Object.keys(buckets).sort();
    volumeTotal = days.reduce((acc, d) => acc + buckets[d], 0);
    volumeSub = days.length ? `${days.length} días activos · tareas creadas` : "sin actividad";
  }

  // Distribución por estado as a KPI: dominant status + concise spread.
  const statusRows = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n], i) => ({ label: s, value: n, status: tareasTone(s), seriesIndex: i }));
  const topStatus = statusRows[0];
  const statusSub = statusRows.slice(0, 3).map((r) => `${r.label} ${r.value}`).join(" · ") || "sin tareas";

  // Éxito por tipo de tarea as a KPI: weighted success across all task types.
  const sbt = (analytics && analytics.success_rate_by_task_type) || [];
  const totalRuns = sbt.reduce((acc, r) => acc + Number(r.run_count || 0), 0);
  const weightedOk = sbt.reduce((acc, r) => acc + Number(r.run_count || 0) * Number(r.success_rate || 0), 0);
  const successPct = totalRuns ? Math.round((weightedOk / totalRuns) * 100) : null;
  const bestType = sbt.slice().sort((a, b) => Number(b.run_count || 0) - Number(a.run_count || 0))[0];
  const summaryItems = [
    { label: "Tareas", value: dvNum(total), sub: `${dvNum(metrics.total_subtasks || 0)} subtareas` },
    { label: "Completadas", value: dvNum(completed), sub: total ? `${Math.round((completed / total) * 100)}% del total` : "sin base" },
    { label: "Fallidas", value: dvNum(failed), sub: failed > 0 ? "requiere revisión" : "sin fallos", tone: failed > 0 ? "critical" : "good" },
    { label: "Revisión humana", value: dvNum(humanReview), sub: humanReview > 0 ? "pendiente" : "al día", tone: humanReview > 0 ? "serious" : "good" },
    { label: "Coste", value: `$${costSum.toFixed(4)}`, sub: "acumulado" },
    { label: "Latencia media", value: `${dvNum(avgLat)} ms`, sub: `${latN} con ejecución` },
  ];
  const insightItems = [
    {
      label: "Volumen",
      value: dvNum(volumeTotal),
      sub: `${volumeSub}${volumeDelta == null ? "" : ` · ${volumeDelta >= 0 ? "+" : ""}${volumeDelta}`}`,
      tone: volumeDelta == null || volumeDelta >= 0 ? "good" : "warning",
    },
    {
      label: "Estado dominante",
      value: topStatus ? topStatus.label : "—",
      sub: statusSub,
      tone: topStatus ? tareasTone(topStatus.label) : null,
    },
    {
      label: "Éxito por tipo",
      value: successPct == null ? "—" : `${successPct}%`,
      sub: bestType ? `${bestType.task_type} · ${bestType.run_count} ejec.` : "analítica no disponible",
      tone: successPct == null ? null : successPct >= 90 ? "good" : successPct >= 70 ? "warning" : "critical",
    },
  ];
  const itemHtml = (item) => {
    const st = dvStatus(item.tone);
    return `<div class="tareas-summary-item${st ? " tone" : ""}"${st ? ` style="--pc:${st.v}"` : ""}>
      <span>${dvEsc(item.label)}</span>
      <b>${dvEsc(item.value)}</b>
      <small>${dvEsc(item.sub || "")}</small>
    </div>`;
  };

  return `<section class="tareas-summary-panel">
    <div class="tareas-summary-head">
      <div>
        <span class="eyebrow">Monitor de tareas</span>
        <h2>Operación y trazabilidad</h2>
      </div>
      <p>La tabla es la fuente principal; los indicadores resumen estado, volumen y calidad.</p>
    </div>
    <div class="tareas-summary-grid">${summaryItems.concat(insightItems).map(itemHtml).join("")}</div>
  </section>`;
}

// --- List mode: FTS search box above a full-width, sortable tasks table ------
function tareasList(tasks) {
  const rows = tasks.map((t) => {
    const c = t.classification || {};
    return {
      task_id: t.task_id,
      _short: t.task_id.length > 16 ? `${t.task_id.slice(0, 16)}…` : t.task_id,
      tipo: c.intent || "—",
      nivel: `${_tLevelShort(c.complexity_level)} · ${dvNum(c.complexity_score)}`,
      modelo: TIER_LABEL[c.recommended_model] || c.recommended_model || "—",
      status: t.status,
      coste: taskCost(t),
      latencia: taskLatency(t),
      creada: String(t.created_at || "").slice(0, 10),
    };
  });
  const table = dataTable({
    columns: [
      { key: "_short", label: "ID", format: (v, row) => `<button type="button" class="tareas-idlink" data-task="${dvEsc(row.task_id)}"><code>${dvEsc(v)}</code></button>` },
      { key: "tipo", label: "Tipo / Intención" },
      { key: "nivel", label: "Nivel" },
      { key: "modelo", label: "Modelo" },
      { key: "status", label: "Estado", format: (v) => tareasPill(v) },
      { key: "coste", label: "Coste", numeric: true, format: (v) => `$${Number(v).toFixed(4)}` },
      { key: "latencia", label: "Latencia", numeric: true, format: (v) => (v ? `${dvNum(v)} ms` : "—") },
      { key: "creada", label: "Creada" },
    ],
    rows,
    defaultSort: "creada",
  });
  // Merged toolbar + table: one cohesive surface (title + count on the left,
  // full-text search on the right) instead of two stacked cards.
  return `<section class="card tareas-panel">
    <header class="tareas-panel-h">
      <div class="tareas-panel-title">
        <span class="tareas-panel-name">Tareas</span>
        <span class="tareas-panel-count">${tasks.length} en el registro · clic para abrir detalle</span>
      </div>
      <div class="tareas-search">
        <span class="tareas-search-ico" aria-hidden="true">⌕</span>
        <input type="text" id="tareasSearch" class="tareas-search-input" placeholder="Buscar por título, tipo o prompt…" autocomplete="off" spellcheck="false" aria-label="Buscar tareas" />
        <div id="tareasSearchResults" class="tareas-search-results" hidden></div>
      </div>
    </header>
    <div class="tareas-table">${table}</div>
  </section>`;
}

// --- Drill-down shell (synchronous): header + clasificación + subtareas, with
// async placeholders for the runs trace and the harness decisions. -----------
function tareasDetailShell(task) {
  const c = task.classification || {};
  const cost = taskCost(task), lat = taskLatency(task);
  const rhr = c.requires_human_review;
  const dt = (s) => dvEsc(String(s || "").slice(0, 19).replace("T", " "));
  const header = `<div class="tareas-detail-head">
    <div class="tareas-detail-topline">
      <button type="button" class="tareas-back">Cerrar detalle</button>
      ${tareasPill(task.status)}
      ${rhr ? `<span class="tareas-flag">▲ revisión humana</span>` : ""}
    </div>
    <div class="tareas-detail-id"><code>${dvEsc(task.task_id)}</code></div>
    <p class="tareas-detail-prompt">${dvEsc(task.prompt || "")}</p>
    <div class="tareas-detail-meta">
      <span><b>${dvEsc(_tLevelShort(c.complexity_level))}</b> · complejidad ${dvNum(c.complexity_score)}</span>
      <span>coste <b>$${cost.toFixed(4)}</b></span>
      <span>latencia <b>${lat ? `${dvNum(lat)} ms` : "—"}</b></span>
      <span>creada ${dt(task.created_at)}</span>
      <span>actualizada ${dt(task.updated_at)}</span>
    </div>
  </div>`;

  const critRows = Object.entries(c.criteria || {}).map(([k, v], i) => ({ label: k, value: Number(v), seriesIndex: i }));
  const clasKv = `<div class="tareas-kv">
    <div><span>Dominios</span><b>${dvEsc((c.domain || []).join(", ") || "—")}</b></div>
    <div><span>Intención</span><b>${dvEsc(c.intent || "—")}</b></div>
    <div><span>Estrategia</span><b>${dvEsc(c.recommended_strategy || "—")}</b></div>
    <div><span>Clasificado por</span><b>${dvEsc(c.classified_by || "—")}</b></div>
    <div><span>Modelo</span><b>${dvEsc(TIER_LABEL[c.recommended_model] || c.recommended_model || "—")}</b></div>
    <div class="tareas-skills"><span>Skills</span><span>${(c.recommended_skills || []).map((s) => `<span class="tag">${dvEsc(s)}</span>`).join("") || "—"}</span></div>
  </div>${c.reason ? `<p class="tareas-reason">${dvEsc(c.reason)}</p>` : ""}`;
  const clasFrame = chartFrame({
    title: "Clasificación",
    subtitle: "criterios 0–5 · driver dominante",
    body: `${clasKv}<div class="tareas-crit">${critRows.length ? hbarChart({ rows: critRows, valueFormat: (v) => Number(v).toFixed(1), maxLabelWidth: 160 }) : `<div class="chart-empty">sin criterios</div>`}</div>`,
  });

  const execs = new Map((task.delegation?.executions || []).map((e) => [e.subtask_id, e]));
  const subs = c.subtasks || [];
  const subBody = subs.length ? subs.map((s) => {
    const ex = execs.get(s.id);
    const meta = ex
      ? `${dvEsc(ex.backend)}:${dvEsc(ex.model_used)} · ${dvNum(ex.latency_ms)} ms · $${Number(ex.estimated_cost_usd || 0).toFixed(5)}`
      : `${dvEsc(TIER_LABEL[s.recommended_model] || s.recommended_model || "")} · pendiente`;
    return `<div class="tareas-subtask">
      <div class="tareas-subtask-h"><code>${dvEsc(s.id)}</code> <b>${dvEsc(s.name)}</b>${ex ? ` ${tareasPill(ex.status)}` : ""}</div>
      <div class="tareas-subtask-meta">${meta}${s.recommended_skill ? ` · skill: ${dvEsc(s.recommended_skill)}` : ""}</div>
      ${s.validation ? `<div class="tareas-subtask-val">✓ ${dvEsc(s.validation)}</div>` : ""}
    </div>`;
  }).join("") : `<div class="chart-empty">sin subtareas</div>`;
  const subFrame = chartFrame({ title: "Subtareas", subtitle: `${subs.length}`, body: `<div class="tareas-subtasks">${subBody}</div>` });

  const runsFrame = chartFrame({ title: "Timeline de ejecuciones", subtitle: "traza por run · modelo · coste · latencia", body: `<div id="tareasRuns" class="tareas-timeline"><div class="chart-empty">cargando ejecuciones…</div></div>` });
  const decFrame = chartFrame({ title: "Decisiones del harness", subtitle: "log de auditoría append-only", body: `<div id="tareasDecisions" class="tareas-decisions"><div class="chart-empty">cargando decisiones…</div></div>` });

  return `${header}${clasFrame}${runsFrame}${subFrame}${decFrame}`;
}

// Fetch the stable Fase-1 runs (the trace) + the harness decision log, inject.
async function renderTareasDetail(task) {
  const [runs, decisions] = await Promise.all([
    api(`/tasks/${task.task_id}/runs`).catch(() => []),
    api(`/tasks/${task.task_id}/decisions`).catch(() => []),
  ]);
  if (state.tareasOpenTask !== task.task_id) return; // user navigated away mid-fetch
  const runsEl = $("#tareasRuns");
  if (runsEl) runsEl.innerHTML = tareasRunsHtml(Array.isArray(runs) ? runs : [], task);
  const decEl = $("#tareasDecisions");
  if (decEl) {
    const rhr = task.classification?.requires_human_review && task.status === "delegated";
    const approve = rhr ? `<button class="approve-review tareas-approve" data-approve="${dvEsc(task.task_id)}">Aprobar revisión humana</button>` : "";
    const list = (Array.isArray(decisions) ? decisions : []);
    decEl.innerHTML = (list.length ? list.map((d) => `<div class="tareas-dec">
      <span class="tareas-dec-phase">${dvEsc(d.phase)}</span>
      <div class="tareas-dec-body"><div class="tareas-dec-decision">${dvEsc(d.decision)}</div>${d.reason ? `<div class="tareas-dec-reason">${dvEsc(d.reason)}</div>` : ""}</div>
      ${d.score != null ? `<span class="tareas-dec-score">${dvNum(d.score)}</span>` : ""}
    </div>`).join("") : `<div class="chart-empty">sin decisiones registradas</div>`) + approve;
  }
}

// The trace: one card per run (stable /runs data), merged with executions for
// the output/error text (runs carry timing/cost/model, executions carry output).
function tareasRunsHtml(runs, task) {
  const execs = task.delegation?.executions || [];
  let items = [];
  if (runs.length) {
    items = runs.map((r, i) => {
      const ex = execs[i] || execs.find((e) => e.subtask_id === r.subtask_id) || null;
      return {
        index: r.run_index != null ? r.run_index : i,
        provider: r.provider_name || r.model_id || "—",
        model: r.model_id || (ex && ex.model_used) || "",
        backend: r.backend || "",
        status: r.status,
        latency: r.latency_ms,
        cost: r.estimated_cost_usd,
        inTok: r.input_tokens,
        outTok: r.output_tokens,
        entity: r.routing_entity_name_snapshot || "",
        output: ex ? ex.output : "",
        error: r.error || (ex && ex.error) || "",
      };
    });
  } else if (execs.length) {
    items = execs.map((ex, i) => ({
      index: i,
      provider: (ex.model_used || "").split(":")[0] || ex.backend || "—",
      model: ex.model_used || "",
      backend: ex.backend || "",
      status: ex.status,
      latency: ex.latency_ms,
      cost: ex.estimated_cost_usd,
      inTok: ex.input_tokens,
      outTok: ex.output_tokens,
      entity: "",
      output: ex.output,
      error: ex.error,
    }));
  }
  if (!items.length) return `<div class="chart-empty">sin ejecuciones registradas</div>`;
  return items.map((it) => {
    const out = it.error ? it.error : (it.output || "");
    const isErr = !!it.error;
    const trunc = out && out.length > 260;
    const shown = trunc ? out.slice(0, 260) : out;
    const outHtml = out ? `<div class="tareas-run-out${isErr ? " err" : ""}">
      <pre class="tareas-run-pre" data-full="${dvEsc(out)}">${dvEsc(shown)}${trunc ? "…" : ""}</pre>
      ${trunc ? `<button type="button" class="tareas-out-toggle">expandir</button>` : ""}
    </div>` : "";
    return `<div class="tareas-run">
      <div class="tareas-run-rail"><span class="tareas-run-dot" style="--pc:${tareasPillColor(it.status)}"></span></div>
      <div class="tareas-run-card">
        <div class="tareas-run-h">
          <span class="tareas-run-idx">#${dvEsc(it.index)}</span>
          <b>${dvEsc(it.provider)}</b>
          ${it.model ? `<code>${dvEsc(it.model)}</code>` : ""}
          ${it.backend ? `<span class="tareas-run-be">${dvEsc(it.backend)}</span>` : ""}
          ${tareasPill(it.status)}
        </div>
        ${it.entity ? `<div class="tareas-run-entity">${dvEsc(it.entity)}</div>` : ""}
        <div class="tareas-run-metrics">
          <span>latencia <b>${it.latency != null ? `${dvNum(it.latency)} ms` : "—"}</b></span>
          <span>coste <b>$${Number(it.cost || 0).toFixed(5)}</b></span>
          <span>tokens <b>${dvNum(it.inTok || 0)}↓ ${dvNum(it.outTok || 0)}↑</b></span>
        </div>
        ${outHtml}
      </div>
    </div>`;
  }).join("");
}

function openTareasTask(taskId) {
  if (!taskId) return;
  state.tareasOpenTask = taskId;
  hideTareasSearch();
  const input = $("#tareasSearch");
  if (input) { input.value = ""; state.tareasQuery = ""; }
  renderTareas({ metrics: state.lastMetrics, tasks: state.tasks, performance: state.agentPerformance }).catch(() => {});
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeTareasTask() {
  state.tareasOpenTask = null;
  renderTareas({ metrics: state.lastMetrics, tasks: state.tasks, performance: state.agentPerformance }).catch(() => {});
}

function hideTareasSearch() {
  const box = $("#tareasSearchResults");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

async function runTareasSearch(q) {
  const box = $("#tareasSearchResults");
  if (!box) return;
  let data;
  try {
    data = await api(`/search/tasks?q=${encodeURIComponent(q)}&limit=20`);
  } catch (err) {
    box.hidden = false;
    box.innerHTML = `<div class="tareas-search-empty">${dvEsc(err.message)}</div>`;
    return;
  }
  const results = data.results || [];
  box.hidden = false;
  if (!results.length) {
    box.innerHTML = `<div class="tareas-search-empty">Sin resultados para “${dvEsc(q)}”.</div>`;
    return;
  }
  box.innerHTML = `<div class="tareas-search-count">${data.count} resultado${data.count === 1 ? "" : "s"}</div>` +
    results.map((r) => {
      const id = r.legacy_task_id || r.id || "";
      const created = r.created_at ? String(r.created_at).slice(0, 10) : "";
      return `<button type="button" class="tareas-search-item" data-task="${dvEsc(id)}">
        <b>${dvEsc(r.title || id || "tarea")}</b>
        <span>${dvEsc(r.task_type || "—")} · ${dvEsc(r.status || "")} · ${created}</span>
      </button>`;
    }).join("");
}

// One-time delegated wiring (idempotent): drill-down open/close, output expand,
// and the FTS search input (debounced).
function initTareas() {
  if (document._tareasBound) return;
  document._tareasBound = true;
  document.addEventListener("click", (e) => {
    const idlink = e.target.closest?.(".tareas-idlink[data-task]");
    if (idlink) { openTareasTask(idlink.dataset.task); return; }
    const searchItem = e.target.closest?.(".tareas-search-item[data-task]");
    if (searchItem) { openTareasTask(searchItem.dataset.task); return; }
    if (e.target.closest?.(".tareas-back")) { closeTareasTask(); return; }
    const tog = e.target.closest?.(".tareas-out-toggle");
    if (tog) {
      const pre = tog.closest(".tareas-run-out")?.querySelector(".tareas-run-pre");
      if (pre) { pre.textContent = pre.getAttribute("data-full") || pre.textContent; tog.remove(); }
      return;
    }
    if (!e.target.closest?.(".tareas-search")) hideTareasSearch();
  });
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === "tareasSearch") {
      state.tareasQuery = e.target.value;
      clearTimeout(state._tareasSearchTimer);
      const q = e.target.value.trim();
      if (!q) { hideTareasSearch(); return; }
      state._tareasSearchTimer = setTimeout(() => runTareasSearch(q), 300);
    }
  });
}

// System Health: a summary ring + a sparkline of recent load, replacing the
// older "health-compact/health-orbit" layout (renamed to health-summary* to
// avoid colliding with dead pre-redesign CSS of the same old names).
function renderSystemHealth(health) {
  if (!$("#systemHealth")) return; // Phase D removed the legacy Tareas health card.
  if (!health) {
    $("#systemHealth").innerHTML = `<div class="chart-empty">sin datos</div>`;
    return;
  }
  const status = health.status === "healthy" ? "ok" : health.status === "error" ? "bad" : "warn";
  const healthPct = health.observed_nodes ? Math.round((health.healthy_nodes / health.observed_nodes) * 100) : 0;
  state.healthHistory ||= [];
  state.healthHistory.push(healthPct);
  if (state.healthHistory.length > 24) state.healthHistory.shift();
  $("#systemHealth").innerHTML = `
    <div class="health-summary">
      <div class="health-summary-ring">${svgDonut(healthPct, { tone: status, sub: "salud" })}</div>
      <div class="health-summary-meta">
        <span class="pill ${status}">${escapeHtml(health.status)}</span>
        <b>${health.observed_nodes}</b>
        <small>nodos observados</small>
      </div>
    </div>
    ${svgSparkline(state.healthHistory, { tone: status, w: 220, h: 34 })}
    <div class="health-strip">
      <span><b>${health.healthy_nodes}</b><small>healthy</small></span>
      <span><b>${health.warning_nodes}</b><small>warn</small></span>
      <span><b>${health.error_nodes}</b><small>err</small></span>
      <span><b>${health.active_tasks}</b><small>act.</small></span>
      <span><b>${health.blocked_tasks}</b><small>block</small></span>
      <span><b>${health.avg_latency_ms || 0}ms</b><small>lat.</small></span>
    </div>`;
}

export function setMonitorSide(open) {
  state.monitorSideOpen = open;
  const shell = $(".monitor-shell");
  const side = $("#monitorSide");
  const button = $("#toggleMonitorSide");
  shell?.classList.toggle("side-collapsed", !open);
  side?.classList.toggle("collapsed", !open);
  if (button) {
    button.textContent = open ? "◧" : "◨";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("title", open ? "Ocultar panel lateral" : "Mostrar panel lateral");
  }
}

function applyMonitorSplit() {
  document.documentElement.style.setProperty("--monitor-side-width", `${state.monitorSideWidth}px`);
}

export function initMonitorSplitter() {
  const stored = Number(localStorage.getItem("karajan-monitor-side-width"));
  if (Number.isFinite(stored)) state.monitorSideWidth = Math.min(560, Math.max(300, stored));
  applyMonitorSplit();
  const splitter = $("#monitorSplitter");
  if (!splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";
  splitter.addEventListener("pointerdown", (event) => {
    if (!state.monitorSideOpen) return;
    event.preventDefault();
    state.resizingMonitorSide = true;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-monitor");
    document.addEventListener("pointermove", onMonitorResize);
    document.addEventListener("pointerup", stopMonitorResize, { once: true });
  });
}

function onMonitorResize(event) {
  if (!state.resizingMonitorSide) return;
  const shell = $(".monitor-shell");
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  const maxWidth = Math.min(640, rect.width * 0.48);
  state.monitorSideWidth = Math.round(Math.min(maxWidth, Math.max(300, rect.right - event.clientX)));
  localStorage.setItem("karajan-monitor-side-width", String(state.monitorSideWidth));
  applyMonitorSplit();
}

function stopMonitorResize() {
  state.resizingMonitorSide = false;
  $("#monitorSplitter")?.classList.remove("dragging");
  document.body.classList.remove("resizing-monitor");
  document.removeEventListener("pointermove", onMonitorResize);
}

export function setHumanSide(open) {
  state.humanSideOpen = open;
  const grid = $("#humanHomeGrid");
  const button = $("#toggleHumanSide");
  grid?.classList.toggle("side-collapsed", !open);
  if (button) {
    button.textContent = open ? "◧" : "◨";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("title", open ? "Ocultar conexiones de agentes" : "Mostrar conexiones de agentes");
  }
}

export function syncHumanSideOffset() {
  const grid = $("#humanHomeGrid");
  if (!grid) return;
  document.documentElement.style.setProperty("--human-side-offset", "0px");
  requestAnimationFrame(syncHumanSideHeight);
}

export function syncHumanSideHeight() {
  const main = $(".human-home-main");
  if (!main) return;
  const height = Math.max(360, Math.round(main.getBoundingClientRect().height));
  document.documentElement.style.setProperty("--human-side-height", `${height}px`);
}

function applyHumanSplit() {
  document.documentElement.style.setProperty("--human-side-width", `${state.humanSideWidth}px`);
}

export function setAgentsSide(open) {
  state.agentsSideOpen = open;
  const windowEl = $("#agentsWindow");
  const side = $("#agentsSide");
  const button = $("#toggleAgentsSide");
  windowEl?.classList.toggle("side-collapsed", !open);
  side?.classList.toggle("collapsed", !open);
  if (button) {
    button.textContent = open ? "◧" : "◨";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("title", open ? "Ocultar detalle del agente" : "Mostrar detalle del agente");
  }
}

function applyAgentsSplit() {
  document.documentElement.style.setProperty("--agents-side-width", `${state.agentsSideWidth}px`);
  $("#agentsWindow")?.style.setProperty("--agents-side-width", `${state.agentsSideWidth}px`);
}

export function initAgentsSplitter() {
  const stored = Number(localStorage.getItem("karajan-agents-side-width"));
  if (Number.isFinite(stored)) state.agentsSideWidth = Math.min(640, Math.max(340, stored));
  applyAgentsSplit();
  const splitter = $("#agentsSplitter");
  if (!splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";
  splitter.addEventListener("pointerdown", (event) => {
    if (!state.agentsSideOpen) return;
    event.preventDefault();
    state.resizingAgentsSide = true;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-agents");
    document.addEventListener("pointermove", onAgentsResize);
    document.addEventListener("pointerup", stopAgentsResize, { once: true });
  });
}

function onAgentsResize(event) {
  if (!state.resizingAgentsSide) return;
  const shell = $("#agentsWindow");
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  const maxWidth = Math.min(720, rect.width * 0.48);
  state.agentsSideWidth = Math.round(Math.min(maxWidth, Math.max(340, rect.right - event.clientX)));
  localStorage.setItem("karajan-agents-side-width", String(state.agentsSideWidth));
  applyAgentsSplit();
}

function stopAgentsResize() {
  state.resizingAgentsSide = false;
  $("#agentsSplitter")?.classList.remove("dragging");
  document.body.classList.remove("resizing-agents");
  document.removeEventListener("pointermove", onAgentsResize);
}

export function initHumanSplitter() {
  const stored = Number(localStorage.getItem("karajan-human-side-width"));
  if (Number.isFinite(stored)) state.humanSideWidth = Math.min(620, Math.max(340, stored));
  applyHumanSplit();
  const splitter = $("#humanSplitter");
  if (!splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";
  splitter.addEventListener("pointerdown", (event) => {
    if (!state.humanSideOpen) return;
    event.preventDefault();
    state.resizingHumanSide = true;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-human");
    document.addEventListener("pointermove", onHumanResize);
    document.addEventListener("pointerup", stopHumanResize, { once: true });
  });
}

function onHumanResize(event) {
  if (!state.resizingHumanSide) return;
  const grid = $("#humanHomeGrid");
  if (!grid) return;
  const rect = grid.getBoundingClientRect();
  const maxWidth = Math.min(720, rect.width * 0.55);
  state.humanSideWidth = Math.round(Math.min(maxWidth, Math.max(340, rect.right - event.clientX)));
  localStorage.setItem("karajan-human-side-width", String(state.humanSideWidth));
  applyHumanSplit();
}

function stopHumanResize() {
  state.resizingHumanSide = false;
  $("#humanSplitter")?.classList.remove("dragging");
  document.body.classList.remove("resizing-human");
  document.removeEventListener("pointermove", onHumanResize);
}

function applyMonitorBlockOrder() {
  const stack = $("#monitorBlockStack");
  if (!stack) return;
  const stored = localStorage.getItem("karajan-monitor-block-order");
  if (stored) {
    const order = stored.split(",").filter(Boolean);
    if (order.length) state.monitorBlockOrder = order;
  }
  state.monitorBlockOrder.forEach((key) => {
    const block = stack.querySelector(`[data-monitor-block="${key}"]`);
    if (block) stack.appendChild(block);
  });
}

function saveMonitorBlockOrder() {
  const order = $$("#monitorBlockStack [data-monitor-block]").map((block) => block.dataset.monitorBlock);
  state.monitorBlockOrder = order;
  localStorage.setItem("karajan-monitor-block-order", order.join(","));
}

function clearMonitorDropState() {
  $$("#monitorBlockStack .monitor-block").forEach((block) => {
    block.classList.remove("drop-before", "drop-after");
  });
}

export function initMonitorBlocks() {
  const stack = $("#monitorBlockStack");
  if (!stack || stack.dataset.bound) return;
  stack.dataset.bound = "1";
  applyMonitorBlockOrder();
  stack.addEventListener("dragstart", (event) => {
    const block = event.target.closest("[data-monitor-block]");
    if (!block) return;
    block.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", block.dataset.monitorBlock);
  });
  stack.addEventListener("dragover", (event) => {
    const dragging = stack.querySelector(".dragging");
    const target = event.target.closest("[data-monitor-block]");
    if (!dragging || !target || target === dragging) return;
    event.preventDefault();
    clearMonitorDropState();
    const rect = target.getBoundingClientRect();
    target.classList.add(event.clientX < rect.left + rect.width / 2 ? "drop-before" : "drop-after");
  });
  stack.addEventListener("drop", (event) => {
    const dragging = stack.querySelector(".dragging");
    const target = event.target.closest("[data-monitor-block]");
    if (!dragging || !target || target === dragging) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    if (event.clientX < rect.left + rect.width / 2) {
      stack.insertBefore(dragging, target);
    } else {
      stack.insertBefore(dragging, target.nextSibling);
    }
    clearMonitorDropState();
    saveMonitorBlockOrder();
  });
  stack.addEventListener("dragend", () => {
    stack.querySelector(".dragging")?.classList.remove("dragging");
    clearMonitorDropState();
  });
}

function renderSelectedAgentUsage(nodes, flow, audit) {
  const node = nodes.find((item) => item.id === state.selectedNodeId) || nodes[0];
  if (!node) {
    $("#selectedAgentUsage").innerHTML = `<div class="chart-empty">sin agente seleccionado</div>`;
    return;
  }
  const related = [...flow, ...audit]
    .filter((event) => event.source_node === node.name || event.target_node === node.name || event.summary?.includes(node.name))
    .slice(0, 5);
  const caps = (node.active_capabilities || []).map((cap) => `<span>${escapeHtml(cap)}</span>`).join("");
  const levels = (node.levels || []).map((level) => LEVEL_FULL[level] || level).join(" · ") || "sin niveles";
  $("#selectedAgentUsage").innerHTML = `<div class="selected-agent-head">
      <div><b>${escapeHtml(node.name)}</b><small>${escapeHtml(node.role)} · ${escapeHtml(node.status)}</small></div>
      <span class="pill ${node.status === "error" ? "bad" : node.status === "idle" || node.status === "completed" ? "ok" : "warn"}">${escapeHtml(node.provider)}</span>
    </div>
    <div class="selected-agent-model">${escapeHtml(node.active_model)}</div>
    <div class="selected-agent-stats">
      <span><b>${node.task_count}</b><small>tasks</small></span>
      <span><b>${node.error_count}</b><small>errors</small></span>
      <span><b>${node.latency_ms || 0}ms</b><small>lat.</small></span>
      <span><b>$${Number(node.estimated_cost || 0).toFixed(4)}</b><small>coste</small></span>
    </div>
    <div class="node-role">${escapeHtml(levels)}</div>
    <div class="node-caps">${caps || "<span>sin capacidades</span>"}</div>
    <div class="selected-agent-log">
      ${related.length ? eventList(related, "") : `<div class="chart-empty">sin eventos directos recientes</div>`}
    </div>`;
}

// ---- Agent detail panel (role-specific metrics) ----------------------------

const ROLE_METRIC_DEFS = {
  agent: [
    { key: "extra.classified_tasks", label: "Clasificadas", fmt: (n) => n ?? 0 },
    { key: "extra.delegated_tasks",  label: "Delegadas",    fmt: (n) => n ?? 0 },
    { key: "_delegation_rate",       label: "Tasa deleg.",  fmt: (n) => `${n}%` },
    { key: "confidence",             label: "Confianza",    fmt: (n) => n != null ? `${Math.round(n * 100)}%` : "—" },
    { key: "_caps_count",            label: "Caps.",        fmt: (n) => n ?? 0 },
    { key: "model_tier",             label: "Tier",         fmt: (n) => TIER_LABEL[n] || n || "—" },
  ],
  worker: [
    { key: "task_count",    label: "Subtareas",   fmt: (n) => n ?? 0 },
    { key: "_error_rate",  label: "Tasa error",  fmt: (n) => `${n}%` },
    { key: "latency_ms",   label: "Latencia",    fmt: (n) => `${n || 0}ms` },
    { key: "estimated_cost", label: "Coste",     fmt: (n) => `$${Number(n || 0).toFixed(4)}` },
    { key: "model_tier",   label: "Tier",        fmt: (n) => TIER_LABEL[n] || n || "—" },
    { key: "_levels",      label: "Niveles",     fmt: (n) => n || "sin niveles" },
  ],
  backup: "worker",
  guardian: [
    { key: "task_count",   label: "Revisiones",  fmt: (n) => n ?? 0 },
    { key: "error_count",  label: "Detectados",  fmt: (n) => n ?? 0 },
    { key: "_approval_rate", label: "Aprobación", fmt: (n) => `${n}%` },
    { key: "latency_ms",   label: "Latencia",    fmt: (n) => `${n || 0}ms` },
    { key: "_skills",      label: "Skills",      fmt: (n) => n || "—" },
    { key: "provider",     label: "Provider",    fmt: (n) => n || "—" },
  ],
  validator: "guardian",
  memory: [
    { key: "task_count",   label: "Eventos",     fmt: (n) => n ?? 0 },
    { key: "error_count",  label: "Errores",     fmt: (n) => n ?? 0 },
    { key: "latency_ms",   label: "Latencia",    fmt: (n) => `${n || 0}ms` },
    { key: "status",       label: "Estado",      fmt: (n) => n || "idle" },
    { key: "_skills",      label: "Skills",      fmt: (n) => n || "—" },
    { key: "provider",     label: "Provider",    fmt: (n) => n || "—" },
  ],
  monitor: "memory",
};

function _nodeMetricValue(node, usage, key) {
  if (key === "_delegation_rate") {
    const classified = Number(node.extra?.classified_tasks || 0);
    const delegated = Number(node.extra?.delegated_tasks || 0);
    return classified ? Math.round((delegated / classified) * 100) : 0;
  }
  if (key === "_error_rate") {
    const total = Number(node.task_count || 0);
    return total ? Math.round((Number(node.error_count || 0) / total) * 100) : 0;
  }
  if (key === "_approval_rate") {
    const total = Number(node.task_count || 0);
    const errors = Number(node.error_count || 0);
    return total ? Math.round(((total - errors) / total) * 100) : 100;
  }
  if (key === "_caps") return (node.active_capabilities || []).join(", ") || "—";
  if (key === "_caps_count") return (node.active_capabilities || []).length;
  if (key === "_levels") return (node.levels || []).map((l) => _LEVEL_SHORT[l] || LEVEL_FULL[l] || l).join(" · ") || "sin niveles";
  if (key === "_skills") return (node.skills || []).slice(0, 3).join(", ") || "—";
  if (key.startsWith("extra.")) return node.extra?.[key.slice(6)];
  return node[key];
}

function renderAgentDetailPanel(node, usageByModel) {
  const el = $("#agentDetailPanel");
  if (!el) return;
  if (!node) { el.innerHTML = `<div class="agent-detail-empty">Selecciona un nodo para ver sus métricas</div>`; return; }

  const usage = usageByModel.get(node.active_model);
  const roleKey = (node.role || "").toLowerCase();
  let defs = ROLE_METRIC_DEFS[roleKey];
  if (typeof defs === "string") defs = ROLE_METRIC_DEFS[defs];
  if (!defs) defs = ROLE_METRIC_DEFS.memory;

  const statusCls = node.status === "error" ? "bad" : (node.status === "idle" || node.status === "completed") ? "ok" : "warn";

  // Common base row: tasks, errors, latency, cost (from usage if available, else node)
  const baseCells = [
    ["Tasks", node.task_count ?? 0],
    ["Errores", node.error_count ?? 0],
    ["Latencia", `${usage?.latency_ms ?? node.latency_ms ?? 0}ms`],
    ["Coste", `$${Number(usage?.estimated_cost ?? node.estimated_cost ?? 0).toFixed(4)}`],
    ["Llamadas", usage?.calls ?? node.task_count ?? 0],
    ["Tokens", node.total_tokens || (node.input_tokens || 0) + (node.output_tokens || 0) || 0],
  ];

  const roleGrid = defs.map(({ key, label, fmt }) => {
    const raw = _nodeMetricValue(node, usage, key);
    return `<div class="agent-role-cell"><small>${escapeHtml(label)}</small><b>${escapeHtml(fmt(raw))}</b></div>`;
  }).join("");

  const caps = (node.active_capabilities || []).map((c) => `<span>${escapeHtml(c)}</span>`).join("");
  const skills = (node.skills || []).map((s) => `<span>${escapeHtml(s)}</span>`).join("");

  el.innerHTML = `
    <div class="agent-detail-identity">
      <div class="agent-detail-name">
        <span class="bubble-dot ${statusCls}"></span>
        <b>${escapeHtml(node.name)}</b>
        <span class="pill ${statusCls}">${escapeHtml(node.role)}</span>
        <small>${escapeHtml(node.active_model || "auto")}</small>
      </div>
    </div>
    <div class="agent-detail-base">
      ${baseCells.map(([l, v]) => `<div class="agent-base-cell"><small>${escapeHtml(l)}</small><b>${escapeHtml(String(v))}</b></div>`).join("")}
    </div>
    <div class="agent-detail-section-label">Métricas de rol · ${escapeHtml(node.role)}</div>
    <div class="agent-role-grid">${roleGrid}</div>
    ${caps ? `<div class="agent-detail-tags"><span class="agent-detail-tag-label">Capacidades</span>${caps}</div>` : ""}
    ${skills ? `<div class="agent-detail-tags"><span class="agent-detail-tag-label">Skills</span>${skills}</div>` : ""}
  `;
}

// ---- Monitor side panel (workflow events for selected agent) ----------------

function renderMonitorSidePanel(node, flow, audit) {
  const headerEl = $("#sideAgentHeader");
  const activityEl = $("#sideActivityList");
  if (!headerEl) return;

  if (!node) {
    headerEl.innerHTML = `<div class="side-empty">Sin nodo seleccionado</div>`;
    if (activityEl) activityEl.innerHTML = "";
    return;
  }

  const statusCls = node.status === "error" ? "bad" : (node.status === "idle" || node.status === "completed") ? "ok" : "warn";
  headerEl.innerHTML = `
    <div class="side-identity-card">
      <div class="side-identity-top">
        <span class="bubble-dot ${statusCls}"></span>
        <div class="side-identity-name">
          <b>${escapeHtml(node.name)}</b>
          <span class="pill ${statusCls}">${escapeHtml(node.status)}</span>
        </div>
      </div>
      <div class="side-identity-row"><small>Rol</small><span>${escapeHtml(node.role)}</span></div>
      <div class="side-identity-row"><small>Modelo</small><span class="mono">${escapeHtml(node.active_model || "auto")}</span></div>
      <div class="side-identity-row"><small>Provider</small><span>${escapeHtml(node.provider || "—")}</span></div>
      ${(node.levels || []).length ? `<div class="side-identity-row"><small>Niveles</small><span>${node.levels.map((l) => LEVEL_FULL[l] || l).join(" · ")}</span></div>` : ""}
      <div class="side-identity-stats">
        <span><b>${node.task_count ?? 0}</b><small>tasks</small></span>
        <span><b>${node.error_count ?? 0}</b><small>err.</small></span>
        <span><b>${node.latency_ms || 0}ms</b><small>lat.</small></span>
        <span><b>$${Number(node.estimated_cost || 0).toFixed(4)}</b><small>coste</small></span>
      </div>
    </div>
  `;

  const relatedActivity = [...(flow || []), ...(audit || [])]
    .filter((ev) => ev.source_node === node.name || ev.target_node === node.name || ev.summary?.includes(node.name))
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, 8);
  if (activityEl) activityEl.innerHTML = eventList(relatedActivity, "Sin actividad para este nodo.");
}

function renderExecutionFlow(events) {
  const el = $("#executionFlow"); // Phase D removed the legacy Tareas flow strip.
  if (!el) return;
  el.innerHTML = eventList(events.slice(0, 4), "Sin flujo de ejecución.");
}

const _LEVEL_SHORT = { level_1_simple:"N1", level_2_moderate:"N2", level_3_intermediate:"N3", level_4_complex:"N4", level_5_critical:"N5" };

// ---- Inline-SVG chart primitives (zero dependency, theme-driven) ------------
function fmtTokens(n) {
  const value = Number(n || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function svgDonut(pct, { label = "", sub = "", tone = "accent", size = 84 } = {}) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const r = 33, circ = 2 * Math.PI * r, off = circ * (1 - p / 100), cx = size / 2;
  return `<svg class="svg-donut tone-${tone}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(label)} ${p}%">
    <circle class="donut-track" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="9"/>
    <circle class="donut-fill" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="9"
      stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 ${cx} ${cx})" stroke-linecap="round"/>
    <text class="donut-num" x="${cx}" y="${cx - 1}" text-anchor="middle">${p}%</text>
    ${sub ? `<text class="donut-sub" x="${cx}" y="${cx + 13}" text-anchor="middle">${escapeHtml(sub)}</text>` : ""}
  </svg>`;
}

function svgSparkline(values, { tone = "accent", w = 120, h = 32 } = {}) {
  const pts = (values || []).map(Number).filter(Number.isFinite);
  if (pts.length < 2) return `<div class="spark-empty">sin histórico todavía</div>`;
  const max = Math.max(...pts), min = Math.min(...pts), span = max - min || 1;
  const step = w / (pts.length - 1);
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return `<svg class="svg-spark tone-${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true">
    <polygon class="spark-area" points="0,${h} ${line} ${w},${h}"/>
    <polyline class="spark-line" points="${line}" fill="none"/>
  </svg>`;
}

function svgTokenRing(consumed, budget) {
  if (!budget) {
    return `<div class="token-plain"><b>${fmtTokens(consumed)}</b><small>tokens usados</small></div>`;
  }
  const pct = (consumed / budget) * 100;
  const remaining = Math.max(0, budget - consumed);
  const tone = pct > 90 ? "bad" : pct > 70 ? "warn" : "ok";
  return `<div class="token-ring">${svgDonut(pct, { tone, sub: "usado" })}
    <div class="token-ring-meta"><b>${fmtTokens(remaining)}</b><small>tokens restantes*</small>
      <span>${fmtTokens(consumed)} / ${fmtTokens(budget)}</span></div></div>`;
}

// ---- Dataviz component library (Redesign) ----------------------------------
// Reusable, theme-aware, accessible chart primitives. Zero libraries; every
// mark colour is driven by the CSS custom properties defined in styles.css
// (--series-1..8 categorical, --status-* reserved, --dv-ramp-0..5 sequential),
// so light/dark/amber themes recolour automatically. Marks follow the method:
// thin marks, 4px rounded data-ends anchored to the baseline, 2px surface gaps,
// 2px lines, ≥8px hover markers, recessive grid/axes, legend for ≥2 series,
// text always in ink tokens (--text/--muted) never the series colour, status
// colours reserved + always shipped with an icon/label.

let _dvSeq = 0;

const dvId = (prefix = "dv") => `${prefix}-${++_dvSeq}`;

const dvEsc = escapeHtml;

// Categorical colour by ENTITY/seriesIndex, never by rank. >8 series cycle as a
// last resort (the method prefers grouping/small-multiples past 8).
const dvSeries = (i) => `var(--series-${((Number(i) || 0) % 8) + 1})`;

const _DV_STATUS = {
  good: { v: "var(--status-good)", icon: "●", label: "OK" },
  warning: { v: "var(--status-warning)", icon: "▲", label: "Aviso" },
  serious: { v: "var(--status-serious)", icon: "◆", label: "Grave" },
  critical: { v: "var(--status-critical)", icon: "■", label: "Crítico" },
};

const dvStatus = (s) => _DV_STATUS[s] || null;

function dvNum(v, fmt) {
  if (typeof fmt === "function") return fmt(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return n.toLocaleString("es-ES");
  return n.toLocaleString("es-ES", { maximumFractionDigits: 2 });
}

// -- Reusable positioned tooltip (single element, show/hide helpers) ----------
let _dvTip = null;

function dvTooltipEl() {
  if (!_dvTip) {
    _dvTip = document.createElement("div");
    _dvTip.className = "dv-tooltip";
    _dvTip.setAttribute("role", "status");
    _dvTip.hidden = true;
    document.body.appendChild(_dvTip);
  }
  return _dvTip;
}

function dvShowTip(html, x, y) {
  const t = dvTooltipEl();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let left = x + pad, top = y + pad;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}

function dvHideTip() { if (_dvTip) _dvTip.hidden = true; }

// -- statTile / statTileRow: hero KPI tiles -----------------------------------
function statTile({ label, value, sub, delta, status } = {}) {
  const st = dvStatus(status);
  let deltaHtml = "";
  if (delta != null && delta !== "") {
    const up = Number(delta) >= 0;
    const arrow = up ? "▲" : "▼";
    const cls = up ? "up" : "down";
    const txt = typeof delta === "number"
      ? `${up ? "+" : ""}${dvNum(delta)}`
      : dvEsc(delta);
    // Colour is never the sole signal: an arrow glyph + signed token accompany it.
    deltaHtml = `<span class="dv-delta ${cls}">${arrow}<span>${txt}</span></span>`;
  }
  const badge = st ? `<span class="dv-status-badge" style="--sc:${st.v}"><span class="dv-status-ico">${st.icon}</span>${st.label}</span>` : "";
  return `<div class="dv-stat-tile">
    <div class="dv-stat-label">${dvEsc(label ?? "")}${badge}</div>
    <div class="dv-stat-value">${dvEsc(value ?? "—")}</div>
    ${sub != null && sub !== "" ? `<div class="dv-stat-sub">${dvEsc(sub)}</div>` : ""}
    ${deltaHtml}
  </div>`;
}

function statTileRow(tiles = []) {
  return `<div class="dv-stat-row">${tiles.map((t) => statTile(t)).join("")}</div>`;
}

// -- hbarChart: horizontal bars for magnitude/identity ------------------------
// Thin bars, 4px rounded ONLY on the data-end (anchored to the left baseline),
// a 2px surface gap between rows, direct right-aligned tabular-nums values,
// recessive baseline, per-bar hover tooltip. Colour by series when comparing
// entities, or a single accent for one series.
function hbarChart({ rows = [], valueFormat, maxLabelWidth = 120, single = false } = {}) {
  if (!rows.length) return `<div class="chart-empty">sin datos</div>`;
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  const ticks = [0, max / 2, max].map((v) => dvNum(v, valueFormat));
  const body = rows.map((r) => {
    const val = Number(r.value) || 0;
    const pct = Math.max(0, (val / max) * 100);
    const st = dvStatus(r.status);
    const color = st ? st.v : single ? "var(--accent)" : dvSeries(r.seriesIndex);
    const fmt = dvNum(val, valueFormat);
    const tip = `${dvEsc(r.label)}: ${fmt}`;
    return `<div class="dv-hbar-row${val === 0 ? " is-zero" : ""}" style="--bar-color:${color}">
      <span class="dv-hbar-label" style="max-width:${maxLabelWidth}px" title="${dvEsc(r.label)}">${st ? `<span class="dv-status-ico" style="color:${st.v}">${st.icon}</span>` : ""}${dvEsc(r.label)}</span>
      <span class="dv-hbar-track" data-dv-tip="${dvEsc(tip)}"><span class="dv-hbar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
      <span class="dv-hbar-val">${dvEsc(fmt)}</span>
    </div>`;
  }).join("");
  return `<div class="dv-hbar">
    <div class="dv-hbar-scale" aria-hidden="true"><span>${dvEsc(ticks[0])}</span><span>${dvEsc(ticks[1])}</span><span>${dvEsc(ticks[2])}</span></div>
    ${body}
  </div>`;
}

// -- lineChart: single-y time-series with crosshair + tooltip -----------------
// 2px non-scaling lines, recessive gridlines, ONE y-axis only (two scales →
// two charts / small multiples), markers appear ≥8px only on hover under the
// crosshair. Legend for ≥2 series; ≤4 series also get direct end-labels; a
// single series needs no legend. Text uses ink tokens, never the series colour.
const _dvLineReg = {};

let _dvActiveLine = null;

function lineChart({ series = [], xFormat, yFormat, yLabel, small = false, legendAlways = false } = {}) {
  const clean = series.filter((s) => (s.points || []).length);
  if (!clean.length) return `<div class="chart-empty">sin datos</div>`;
  const n = Math.max(...clean.map((s) => s.points.length));
  const allY = clean.flatMap((s) => s.points.map((p) => Number(p.y) || 0));
  let min = Math.min(...allY), max = Math.max(...allY);
  if (min === max) { max = max + 1; min = min - 1; }
  min = Math.min(min, 0) === 0 && min >= 0 ? 0 : min; // anchor to zero when non-negative
  if (max > 0) max += (max - min || max) * 0.08;
  const span = max - min || 1;
  const VBW = 640, VBH = small ? 150 : 240;
  const P = { l: 48, r: 16, t: 12, b: 26 };
  const pw = VBW - P.l - P.r, ph = VBH - P.t - P.b;
  const xAt = (i) => P.l + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
  const yAt = (v) => P.t + ph * (1 - (Number(v) - min) / span);
  const id = dvId("line");
  const xLabels = (clean[0].points || []).map((p, i) =>
    typeof xFormat === "function" ? xFormat(p.x, i) : String(p.x ?? i));

  // Registry for hover: fractions of the full svg box (preserveAspectRatio=none
  // makes the mapping linear on both axes).
  const reg = { n, xFrac: [], series: [], xLabels, yFormat: (v) => dvNum(v, yFormat) };
  for (let i = 0; i < n; i++) reg.xFrac.push(xAt(i) / VBW);

  // Gridlines live in the SVG (non-scaling-stroke keeps them 1px under the
  // stretched preserveAspectRatio=none). Axis labels are crisp HTML overlays —
  // SVG <text> would be distorted by the non-uniform scaling.
  const gridY = 4;
  let grid = "";
  const yTicks = [];
  for (let g = 0; g <= gridY; g++) {
    const v = min + (span * g) / gridY;
    const y = yAt(v);
    grid += `<line class="dv-grid" x1="${P.l}" y1="${y.toFixed(1)}" x2="${VBW - P.r}" y2="${y.toFixed(1)}"/>`;
    yTicks.push({ topPct: (y / VBH) * 100, label: dvNum(v, yFormat) });
  }
  const zeroY = min <= 0 && max >= 0 ? yAt(0) : null;
  const baseline = zeroY == null ? "" : `<line class="dv-baseline" x1="${P.l}" y1="${zeroY.toFixed(1)}" x2="${VBW - P.r}" y2="${zeroY.toFixed(1)}"/>`;
  const gutterPct = (P.l / VBW) * 100;
  const yAxisHtml = yTicks.map((t) =>
    `<span class="dv-axis-y" style="top:${t.topPct.toFixed(2)}%;width:${gutterPct.toFixed(2)}%">${dvEsc(t.label)}</span>`).join("");
  const xAxisHtml = `<span class="dv-axis-x" style="left:${gutterPct.toFixed(2)}%">${dvEsc(xLabels[0] ?? "")}</span>` +
    (n > 1 ? `<span class="dv-axis-x end">${dvEsc(xLabels[n - 1] ?? "")}</span>` : "");

  const paths = clean.map((s) => {
    const color = dvSeries(s.seriesIndex);
    const pts = s.points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(" ");
    const area = clean.length === 1 && zeroY != null
      ? `<polygon class="dv-line-area" points="${P.l.toFixed(1)},${zeroY.toFixed(1)} ${pts} ${xAt(s.points.length - 1).toFixed(1)},${zeroY.toFixed(1)}" style="fill:${color}"/>`
      : "";
    reg.series.push({
      name: s.name || "",
      color,
      yFrac: s.points.map((p) => yAt(p.y) / VBH),
      values: s.points.map((p) => Number(p.y) || 0),
    });
    const singlePoint = s.points.length === 1
      ? `<circle class="dv-line-single" cx="${xAt(0).toFixed(1)}" cy="${yAt(s.points[0].y).toFixed(1)}" r="3.5" style="fill:${color}"/>`
      : "";
    return `${area}<polyline class="dv-line" points="${pts}" style="stroke:${color}"/>${singlePoint}`;
  }).join("");

  // Direct end-labels for ≤4 series (ink token, positioned by fraction as HTML).
  let endLabels = "";
  if (clean.length >= 2 && clean.length <= 4 && n > 1) {
    endLabels = clean.map((s) => {
      const last = s.points[s.points.length - 1];
      const top = (yAt(last.y) / VBH) * 100;
      return `<span class="dv-endlabel" style="top:${top.toFixed(2)}%">${dvEsc(s.name || "")}</span>`;
    }).join("");
  }
  _dvLineReg[id] = reg;

  const legend = clean.length >= 2 || legendAlways
    ? chartLegend({ series: clean.map((s) => ({ name: s.name, seriesIndex: s.seriesIndex })) })
    : "";
  const yLab = yLabel ? `<div class="dv-ylabel">${dvEsc(yLabel)}</div>` : "";

  return `${yLab}<div class="dv-linechart${small ? " small" : ""}" data-dv-chart="${id}">
    <svg class="dv-line-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="none" role="img" aria-label="${dvEsc(yLabel || (clean[0].name || "serie"))}">
      ${grid}${baseline}${paths}
    </svg>
    <div class="dv-axes">${yAxisHtml}${xAxisHtml}${endLabels}</div>
    <div class="dv-crosshair"></div>
    <div class="dv-markers"></div>
  </div>${legend}`;
}

function dvLineHover(chart, e) {
  const reg = _dvLineReg[chart.dataset.dvChart];
  if (!reg) return;
  const rect = chart.getBoundingClientRect();
  const xf = (e.clientX - rect.left) / rect.width;
  let idx = 0, best = Infinity;
  for (let i = 0; i < reg.n; i++) {
    const d = Math.abs(reg.xFrac[i] - xf);
    if (d < best) { best = d; idx = i; }
  }
  const px = reg.xFrac[idx] * 100;
  const cross = chart.querySelector(".dv-crosshair");
  if (cross) { cross.style.left = `${px}%`; cross.style.display = "block"; }
  const mk = chart.querySelector(".dv-markers");
  if (mk) {
    mk.innerHTML = reg.series.map((s) => s.yFrac[idx] == null ? "" :
      `<span class="dv-marker" style="left:${px}%;top:${(s.yFrac[idx] * 100).toFixed(2)}%;background:${s.color}"></span>`).join("");
  }
  const rows = reg.series.map((s) =>
    `<div class="dv-tt-row"><span class="dv-swatch" style="background:${s.color}"></span><span class="dv-tt-name">${dvEsc(s.name)}</span><b>${dvEsc(reg.yFormat(s.values[idx]))}</b></div>`).join("");
  dvShowTip(`<div class="dv-tt-title">${dvEsc(reg.xLabels[idx] ?? "")}</div>${rows}`, e.clientX, e.clientY);
  _dvActiveLine = chart;
}

function dvClearLineHover() {
  if (!_dvActiveLine) return;
  const cross = _dvActiveLine.querySelector(".dv-crosshair");
  if (cross) cross.style.display = "none";
  const mk = _dvActiveLine.querySelector(".dv-markers");
  if (mk) mk.innerHTML = "";
  _dvActiveLine = null;
}

// -- smallMultiples: grid of mini lineCharts (no dual axes) --------------------
function smallMultiples({ charts = [] } = {}) {
  if (!charts.length) return `<div class="chart-empty">sin datos</div>`;
  const body = charts.map((c) => `<div class="dv-sm-cell">
      <div class="dv-sm-title">${dvEsc(c.title || "")}</div>
      ${lineChart({ ...c, small: true })}
    </div>`).join("");
  return `<div class="dv-smallmultiples">${body}</div>`;
}

// -- dotRangePlot: latency percentiles per agent (p50→p99 range) --------------
// Thin range line with distinct markers at p50 (filled), p90 (ring), p99
// (diamond); tabular-nums labels; hover tooltip per marker.
function dotRangePlot({ rows = [], valueFormat, unit = "ms" } = {}) {
  if (!rows.length) return `<div class="chart-empty">sin datos</div>`;
  const max = Math.max(1, ...rows.map((r) => Number(r.p99) || 0));
  const pos = (v) => `${Math.max(0, Math.min(100, (Number(v) / max) * 100))}%`;
  const fmt = (v) => dvNum(v, valueFormat);
  const body = rows.map((r) => {
    const color = dvSeries(r.seriesIndex);
    const tip = `${dvEsc(r.label)} · p50 ${fmt(r.p50)}${unit} · p90 ${fmt(r.p90)}${unit} · p99 ${fmt(r.p99)}${unit}`;
    return `<div class="dv-range-row">
      <span class="dv-range-label" title="${dvEsc(r.label)}">${dvEsc(r.label)}</span>
      <span class="dv-range-track" data-dv-tip="${dvEsc(tip)}">
        <span class="dv-range-line" style="left:${pos(r.p50)};right:calc(100% - ${pos(r.p99)});background:${color}"></span>
        <span class="dv-dot p50" style="left:${pos(r.p50)};--c:${color}" title="p50 ${fmt(r.p50)}${unit}"></span>
        <span class="dv-dot p90" style="left:${pos(r.p90)};--c:${color}" title="p90 ${fmt(r.p90)}${unit}"></span>
        <span class="dv-dot p99" style="left:${pos(r.p99)};--c:${color}" title="p99 ${fmt(r.p99)}${unit}"></span>
      </span>
      <span class="dv-range-vals"><b>${dvEsc(fmt(r.p50))}</b><span>${dvEsc(fmt(r.p90))}</span><span>${dvEsc(fmt(r.p99))}</span></span>
    </div>`;
  }).join("");
  return `<div class="dv-rangeplot">
    <div class="dv-range-head"><span></span><span></span><span class="dv-range-vals dv-range-legend"><b>p50</b><span>p90</span><span>p99</span></span></div>
    ${body}
  </div>`;
}

// -- heatmap: 2D magnitude matrix on the sequential blue ramp -----------------
// Sequential ramp (light→dark = low→high), 2px surface gap between cells,
// near-zero cells recede toward the surface, per-cell tooltip, compact colorbar.
function dvRampStep(v, max) {
  if (!max || v <= 0) return 0;
  const t = Math.max(0, Math.min(1, v / max));
  return Math.max(1, Math.min(5, Math.round(t * 5)));
}

function heatmap({ rows = [], cols = [], matrix = [], valueFormat } = {}) {
  if (!rows.length || !cols.length) return `<div class="chart-empty">sin datos</div>`;
  const max = Math.max(1, ...matrix.flat().map((v) => Number(v) || 0));
  const fmt = (v) => dvNum(v, valueFormat);
  const head = `<div class="dv-hm-cell dv-hm-corner"></div>` +
    cols.map((c) => `<div class="dv-hm-col" title="${dvEsc(c)}">${dvEsc(c)}</div>`).join("");
  const body = rows.map((rlab, ri) => {
    const cells = cols.map((clab, ci) => {
      const v = Number(matrix[ri]?.[ci]) || 0;
      const step = dvRampStep(v, max);
      const tip = `${dvEsc(rlab)} × ${dvEsc(clab)}: ${fmt(v)}`;
      return `<div class="dv-hm-cell dv-ramp-${step}" data-dv-tip="${dvEsc(tip)}">${v > 0 ? dvEsc(fmt(v)) : ""}</div>`;
    }).join("");
    return `<div class="dv-hm-row" style="grid-template-columns:var(--hm-rowlabel) repeat(${cols.length}, 1fr)"><div class="dv-hm-rowlabel" title="${dvEsc(rlab)}">${dvEsc(rlab)}</div>${cells}</div>`;
  }).join("");
  const bar = [0, 1, 2, 3, 4, 5].map((s) => `<span class="dv-ramp-${s}"></span>`).join("");
  return `<div class="dv-heatmap" style="--hm-cols:${cols.length}" role="img" aria-label="Mapa de calor de ${dvEsc(rows.length)} filas por ${dvEsc(cols.length)} columnas; valor máximo ${dvEsc(fmt(max))}">
    <div class="dv-hm-grid" style="grid-template-columns:var(--hm-rowlabel) repeat(${cols.length}, 1fr)">${head}</div>
    <div class="dv-hm-rows">${body}</div>
    <div class="dv-hm-legend"><span>0</span><span class="dv-hm-bar">${bar}</span><span>${dvEsc(fmt(max))}</span></div>
  </div>`;
}

// -- scatterPlot: 2D efficiency plot (x/y numeric, radius∝volume, hue∝series) --
// Uniform scaling (preserveAspectRatio=meet) so bubbles stay round; grid, axes,
// tick + axis-title text are SVG-native so they scale crisply with the plot.
// Every bubble carries a data-dv-tip for the shared hover tooltip.
function scatterPlot({ points = [], xLabel = "", yLabel = "", xFormat, yFormat } = {}) {
  const pts = points.filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  if (!pts.length) return `<div class="chart-empty">sin datos</div>`;
  const xs = pts.map((p) => Number(p.x)), ys = pts.map((p) => Number(p.y));
  let xmin = Math.min(...xs), xmax = Math.max(...xs);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  xmin = xmin >= 0 ? 0 : xmin; ymin = ymin >= 0 ? 0 : ymin; // anchor non-neg axes to 0
  if (xmax === xmin) xmax = xmin + 1;
  if (ymax === ymin) ymax = ymin + 1;
  xmax += (xmax - xmin) * 0.06; ymax += (ymax - ymin) * 0.08; // headroom for bubbles
  const xspan = xmax - xmin, yspan = ymax - ymin;
  const VBW = 720, VBH = 340;
  const P = { l: 64, r: 18, t: 16, b: 44 };
  const pw = VBW - P.l - P.r, ph = VBH - P.t - P.b;
  const xAt = (v) => P.l + pw * ((Number(v) - xmin) / xspan);
  const yAt = (v) => P.t + ph * (1 - (Number(v) - ymin) / yspan);
  const maxVol = Math.max(1, ...pts.map((p) => Number(p.size) || 1));
  const rOf = (v) => 5 + 13 * Math.sqrt((Number(v) || 1) / maxVol); // 5..18 user units
  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const mx = median(xs), my = median(ys);
  const mxPos = xAt(mx), myPos = yAt(my);
  const G = 4;
  let grid = "", ticks = "";
  for (let g = 0; g <= G; g++) {
    const vy = ymin + (yspan * g) / G, y = yAt(vy);
    grid += `<line class="dv-sc-grid" x1="${P.l}" y1="${y.toFixed(1)}" x2="${VBW - P.r}" y2="${y.toFixed(1)}"/>`;
    ticks += `<text class="dv-sc-tick dv-sc-tick-y" x="${P.l - 8}" y="${(y + 3.5).toFixed(1)}">${dvEsc(dvNum(vy, yFormat))}</text>`;
    const vx = xmin + (xspan * g) / G, x = xAt(vx);
    ticks += `<text class="dv-sc-tick dv-sc-tick-x" x="${x.toFixed(1)}" y="${VBH - P.b + 18}">${dvEsc(dvNum(vx, xFormat))}</text>`;
  }
  // Larger bubbles first so small ones stay visible/hoverable on top.
  const dots = pts.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0)).map((p) => {
    const cx = xAt(p.x), cy = yAt(p.y), r = rOf(p.size);
    const color = p.color || dvSeries(p.seriesIndex);
    return `<circle class="dv-sc-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" style="fill:${color}" data-dv-tip="${dvEsc(p.tip || p.label || "")}"/>`;
  }).join("");
  const axisTitles = `
    <text class="dv-sc-axis-title" x="${((P.l + (VBW - P.r)) / 2).toFixed(1)}" y="${VBH - 6}">${dvEsc(xLabel)}</text>
    <text class="dv-sc-axis-title" transform="translate(16 ${((P.t + (VBH - P.b)) / 2).toFixed(1)}) rotate(-90)" x="0" y="0">${dvEsc(yLabel)}</text>`;
  const refs = pts.length > 2 ? `
      <line class="dv-sc-ref" x1="${mxPos.toFixed(1)}" y1="${P.t}" x2="${mxPos.toFixed(1)}" y2="${VBH - P.b}"/>
      <line class="dv-sc-ref" x1="${P.l}" y1="${myPos.toFixed(1)}" x2="${VBW - P.r}" y2="${myPos.toFixed(1)}"/>
      <text class="dv-sc-ref-label" x="${(mxPos + 5).toFixed(1)}" y="${P.t + 12}">mediana</text>` : "";
  return `<div class="dv-scatter">
    <svg class="dv-sc-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${dvEsc(yLabel)} vs ${dvEsc(xLabel)}">
      ${grid}
      ${refs}
      <line class="dv-sc-axis" x1="${P.l}" y1="${P.t}" x2="${P.l}" y2="${VBH - P.b}"/>
      <line class="dv-sc-axis" x1="${P.l}" y1="${VBH - P.b}" x2="${VBW - P.r}" y2="${VBH - P.b}"/>
      ${ticks}${axisTitles}${dots}
    </svg>
  </div>`;
}

// -- sankeyChart: multi-column flow diagram (Tipo → Agente → Estado) -----------
// columns: [{ title, nodes:[{id,label,color?}] }, ...]; links: [{from,to,value,color?}].
// Node height ∝ throughput (max of in/out), shared scale across columns; ribbons
// are filled cubic beziers stacked on both endpoints. SVG-native labels.
function sankeyChart({ columns = [], links = [] } = {}) {
  const cols = columns.filter((c) => (c.nodes || []).length);
  if (cols.length < 2) return `<div class="chart-empty">sin datos de flujo</div>`;
  const idIndex = new Map();
  cols.forEach((c, ci) => c.nodes.forEach((n) => idIndex.set(n.id, { col: ci, node: n })));
  const goodLinks = links.filter((l) => idIndex.has(l.from) && idIndex.has(l.to) && Number(l.value) > 0);
  if (!goodLinks.length) return `<div class="chart-empty">sin datos de flujo</div>`;
  const outSum = {}, inSum = {};
  goodLinks.forEach((l) => {
    outSum[l.from] = (outSum[l.from] || 0) + Number(l.value);
    inSum[l.to] = (inSum[l.to] || 0) + Number(l.value);
  });
  const valueOf = (id) => Math.max(outSum[id] || 0, inSum[id] || 0);
  const VBW = 760, VBH = 360, NODE_W = 13, PAD_T = 10, PAD_B = 10, GAP = 10;
  const colTotals = cols.map((c) => c.nodes.reduce((a, n) => a + valueOf(n.id), 0));
  const maxNodes = Math.max(...cols.map((c) => c.nodes.length));
  const usableH = VBH - PAD_T - PAD_B - (maxNodes - 1) * GAP;
  const scale = usableH / Math.max(1, ...colTotals); // shared vertical scale
  const colX = (ci) => cols.length === 1 ? 0 : (VBW - NODE_W) * (ci / (cols.length - 1));
  const layout = new Map();
  cols.forEach((c, ci) => {
    const heights = c.nodes.map((n) => Math.max(2, valueOf(n.id) * scale));
    const totalH = heights.reduce((a, h) => a + h, 0) + (c.nodes.length - 1) * GAP;
    let y = PAD_T + (VBH - PAD_T - PAD_B - totalH) / 2;
    c.nodes.forEach((n, i) => {
      layout.set(n.id, { x: colX(ci), y, h: heights[i], node: n, outAt: y, inAt: y });
      y += heights[i] + GAP;
    });
  });
  const ribbons = goodLinks.slice().sort((a, b) => Number(b.value) - Number(a.value)).map((l) => {
    const s = layout.get(l.from), t = layout.get(l.to);
    const th = Math.max(1, Number(l.value) * scale);
    const sy = s.outAt + th / 2, ty = t.inAt + th / 2;
    s.outAt += th; t.inAt += th;
    const x1 = s.x + NODE_W, x2 = t.x, xm = (x1 + x2) / 2;
    const color = l.color || s.node.color || "var(--muted)";
    return `<path class="dv-sk-link" d="M${x1.toFixed(1)},${sy.toFixed(1)} C${xm.toFixed(1)},${sy.toFixed(1)} ${xm.toFixed(1)},${ty.toFixed(1)} ${x2.toFixed(1)},${ty.toFixed(1)}" style="stroke:${color};stroke-width:${th.toFixed(1)}" data-dv-tip="${dvEsc(`${s.node.label} → ${t.node.label}: ${dvNum(l.value)}`)}"/>`;
  }).join("");
  const nodes = [...layout.values()].map(({ x, y, h, node }) => {
    const color = node.color || "var(--muted)";
    const atRight = x > VBW * 0.6;
    const tx = atRight ? x - 6 : x + NODE_W + 6;
    return `<g data-dv-tip="${dvEsc(`${node.label}: ${dvNum(valueOf(node.id))}`)}">
      <rect class="dv-sk-node" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${NODE_W}" height="${h.toFixed(1)}" rx="2" style="fill:${color}"/>
      <text class="dv-sk-label" x="${tx.toFixed(1)}" y="${(y + h / 2 + 3.5).toFixed(1)}" text-anchor="${atRight ? "end" : "start"}">${dvEsc(node.label)}</text>
    </g>`;
  }).join("");
  const heads = cols.map((c, ci) => `<text class="dv-sk-head" x="${(colX(ci) + NODE_W / 2).toFixed(1)}" y="8" text-anchor="${ci === 0 ? "start" : ci === cols.length - 1 ? "end" : "middle"}">${dvEsc(c.title || "")}</text>`).join("");
  return `<div class="dv-sankey">
    <svg class="dv-sk-svg" viewBox="0 -6 ${VBW} ${VBH + 12}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Flujo tipo de tarea a agente a estado">
      ${heads}<g class="dv-sk-links">${ribbons}</g><g class="dv-sk-nodes">${nodes}</g>
    </svg>
  </div>`;
}

// -- dataTable: sortable table (doubles as the accessible table view) ---------
const _dvTables = {};

function dataTable({ columns = [], rows = [], sortable = true, defaultSort } = {}) {
  const id = dvId("tbl");
  _dvTables[id] = { columns, rows, sort: defaultSort || null, dir: 1 };
  return `<div class="dv-table-wrap"><table class="dv-table" data-dv-table="${id}">
    <thead>${dvTableHead(id)}</thead>
    <tbody>${dvTableBody(id)}</tbody>
  </table></div>`;
}

function dvTableHead(id) {
  const t = _dvTables[id];
  return `<tr>${t.columns.map((c) => {
    const align = c.align || (c.numeric ? "right" : "left");
    const sortable = t.sortableCols !== false;
    const active = t.sort === c.key;
    const arrow = active ? (t.dir > 0 ? " ▲" : " ▼") : "";
    return `<th class="al-${align}${c.numeric ? " num" : ""}"${sortable ? ` data-dv-sort="${dvEsc(c.key)}"` : ""}>${dvEsc(c.label ?? c.key)}<span class="dv-sort-ico">${arrow}</span></th>`;
  }).join("")}</tr>`;
}

function dvTableBody(id) {
  const t = _dvTables[id];
  let rows = t.rows.slice();
  if (t.sort) {
    const col = t.columns.find((c) => c.key === t.sort);
    rows.sort((a, b) => {
      const av = a[t.sort], bv = b[t.sort];
      const na = Number(av), nb = Number(bv);
      const both = Number.isFinite(na) && Number.isFinite(nb);
      const cmp = both ? na - nb : String(av ?? "").localeCompare(String(bv ?? ""));
      return cmp * t.dir;
    });
  }
  return rows.map((row) => `<tr>${t.columns.map((c) => {
    const align = c.align || (c.numeric ? "right" : "left");
    const raw = row[c.key];
    const val = typeof c.format === "function" ? c.format(raw, row) : dvEsc(raw ?? "");
    const dot = c.dot && row.seriesIndex != null
      ? `<span class="dv-idot" style="background:${dvSeries(row.seriesIndex)}"></span>` : "";
    return `<td class="al-${align}${c.numeric ? " num" : ""}">${dot}${val}</td>`;
  }).join("")}</tr>`).join("");
}

function dvSortTable(th) {
  const table = th.closest(".dv-table");
  const id = table?.dataset.dvTable;
  const t = _dvTables[id];
  if (!t) return;
  const key = th.dataset.dvSort;
  if (t.sort === key) t.dir = -t.dir; else { t.sort = key; t.dir = 1; }
  table.querySelector("thead").innerHTML = dvTableHead(id);
  table.querySelector("tbody").innerHTML = dvTableBody(id);
}

// -- chartLegend: reusable legend (ink text, series-coloured swatches) --------
function chartLegend({ series = [] } = {}) {
  if (!series.length) return "";
  return `<div class="dv-legend">${series.map((s) => {
    const st = dvStatus(s.status);
    const color = st ? st.v : (s.color || dvSeries(s.seriesIndex));
    return `<span class="dv-legend-item"><span class="dv-swatch" style="background:${color}"></span>${dvEsc(s.name ?? "")}</span>`;
  }).join("")}</div>`;
}

// -- chartFrame: consistent .card wrapper with optional "ver tabla" toggle -----
function chartFrame({ title, subtitle, controls, body, table } = {}) {
  const id = dvId("frame");
  const toggle = table
    ? `<button type="button" class="dv-table-toggle" data-dv-table-toggle="${id}">ver tabla</button>`
    : "";
  return `<section class="card dv-frame" data-dv-frame="${id}">
    <header class="card-h">
      <span class="dv-frame-title">${dvEsc(title ?? "")}${subtitle ? ` <span class="hint">${dvEsc(subtitle)}</span>` : ""}</span>
      <span class="dv-frame-controls">${controls || ""}${toggle}</span>
    </header>
    <div class="dv-frame-body">
      <div class="dv-frame-chart">${body || ""}</div>
      ${table ? `<div class="dv-frame-table" hidden>${table}</div>` : ""}
    </div>
  </section>`;
}

function dvToggleTable(btn) {
  const frame = btn.closest(".dv-frame");
  if (!frame) return;
  const chart = frame.querySelector(".dv-frame-chart");
  const table = frame.querySelector(".dv-frame-table");
  if (!table) return;
  const showTable = table.hidden;
  table.hidden = !showTable;
  chart.hidden = showTable;
  btn.textContent = showTable ? "ver gráfico" : "ver tabla";
}

// One-time delegated interaction wiring for every dataviz component instance.
export function initDataviz() {
  if (document._dvBound) return;
  document._dvBound = true;
  document.addEventListener("pointermove", (e) => {
    const chart = e.target.closest?.(".dv-linechart[data-dv-chart]");
    if (chart) { dvLineHover(chart, e); return; }
    dvClearLineHover();
    const tipEl = e.target.closest?.("[data-dv-tip]");
    if (tipEl) dvShowTip(tipEl.getAttribute("data-dv-tip"), e.clientX, e.clientY);
    else dvHideTip();
  }, { passive: true });
  document.addEventListener("pointerleave", () => { dvClearLineHover(); dvHideTip(); }, true);
  document.addEventListener("click", (e) => {
    const th = e.target.closest?.(".dv-table th[data-dv-sort]");
    if (th) { dvSortTable(th); return; }
    const hmMetric = e.target.closest?.("[data-resumen-hm-metric]");
    if (hmMetric) { updateResumenHeatmap(hmMetric.dataset.resumenHmMetric); return; }
    const leaderToggle = e.target.closest?.("[data-agentes-leader-toggle]");
    if (leaderToggle) {
      const frame = leaderToggle.closest(".dv-frame");
      const tableView = frame?.querySelector('[data-agent-leader-view="table"]');
      const graphView = frame?.querySelector('[data-agent-leader-view="graph"]');
      const showGraph = graphView?.hidden;
      if (tableView && graphView) {
        tableView.hidden = !!showGraph;
        graphView.hidden = !showGraph;
      }
      state.agentesLeaderboardMode = showGraph ? "graph" : "table";
      localStorage.setItem("karajan-agentes-leaderboard-mode", state.agentesLeaderboardMode);
      leaderToggle.textContent = showGraph ? "ver tabla" : "ver gráfico";
      return;
    }
    const skillNode = e.target.closest?.("[data-agent-skill-task]");
    if (skillNode) {
      state.agentesSkillTask = skillNode.dataset.agentSkillTask || null;
      renderAgentes({ metrics: state.lastMetrics, tasks: state.tasks, observability: state.lastObservability, performance: state.agentPerformance }).catch(() => {});
      return;
    }
    const tog = e.target.closest?.("[data-dv-table-toggle]");
    if (tog) dvToggleTable(tog);
  });
}

function nodeActivitySeries(nodeId) {
  state.nodeActivityHistory ||= {};
  const node = (state.lastObservability?.nodes || []).find((item) => item.id === nodeId);
  const series = (state.nodeActivityHistory[nodeId] ||= []);
  series.push(node?.task_count || 0);
  if (series.length > 24) series.shift();
  return series;
}

// Skill usage across the system: how much each skill was used and by which agents.
function renderSkillUsagePanel(nodes) {
  const totals = {};
  const agentsBySkill = {};
  nodes.forEach((node) => {
    const usage = node.skill_usage || {};
    Object.entries(usage).forEach(([skill, count]) => {
      totals[skill] = (totals[skill] || 0) + Number(count || 0);
      (agentsBySkill[skill] ||= new Set()).add(node.name.split("(")[0].trim().split(",")[0].trim());
    });
  });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) {
    return `<section class="skill-usage-panel"><h4>Uso de skills</h4><div class="chart-empty">Aún no se ha usado ninguna skill.</div></section>`;
  }
  const max = Math.max(...entries.map(([, v]) => v), 1);
  return `<section class="skill-usage-panel">
    <h4>Uso de skills · por agente</h4>
    ${entries
      .map(([skill, count]) => {
        const pct = Math.max(6, Math.round((count / max) * 100));
        const agents = [...(agentsBySkill[skill] || [])];
        return `<div>
          <div class="skill-usage-row">
            <span title="${escapeHtml(skill)}">${escapeHtml(skill)}</span>
            <div class="skill-usage-bar"><i style="width:${pct}%"></i></div>
            <b>${count}</b>
          </div>
          <div class="skill-usage-agents">${agents.map((a) => `<em>${escapeHtml(a)}</em>`).join("") || "<em>—</em>"}</div>
        </div>`;
      })
      .join("")}
  </section>`;
}

// `detail=true` (the single-agent filtered view) folds the node's own spec
// (model/provider) and its own skill usage into this same card, instead of
// stacking the separate system-wide skill-usage/performance panels above it —
// one compact card per node instead of three sections for one node.
function agentChartCard(node, { selected, detail = false } = {}) {
  const status = node.status === "error" ? "bad" : (node.status === "completed" || node.status === "idle") ? "ok" : "warn";
  const shortName = (node.name || "Nodo").split("(")[0].trim().split(",")[0].trim();
  const total = Math.max(1, node.task_count || 0);
  const successPct = node.task_count ? Math.round(((node.task_count - (node.error_count || 0)) / total) * 100) : 100;
  const successTone = successPct >= 90 ? "ok" : successPct >= 60 ? "warn" : "bad";
  const tokens = node.total_tokens || 0;
  // Prefer the shared /agents/performance aggregate (stable per provider_name)
  // for coste/latencia; fall back to the observability node's own values when no
  // matching run aggregate exists so behaviour never regresses.
  const perf = (state.agentPerformance || []).find((p) => p.provider_name && node.provider && p.provider_name === node.provider);
  const cost = perf ? Number(perf.total_cost || 0) : Number(node.estimated_cost || 0);
  const latency = perf ? Math.round(perf.avg_latency_ms || 0) : (node.latency_ms || 0);
  const activity = nodeActivitySeries(node.id);
  const caps = (node.active_capabilities || []).slice(0, 4).map((c) => `<em>${escapeHtml(c)}</em>`).join("");
  const skillEntries = Object.entries(node.skill_usage || {}).sort((a, b) => b[1] - a[1]);
  const specLine = detail
    ? `<div class="agent-chart-spec"><span>${escapeHtml(node.active_model || "auto")}</span><span>${escapeHtml(node.provider || "—")}</span></div>`
    : "";
  const skillChips = detail && skillEntries.length
    ? `<div class="agent-chart-skills">${skillEntries
        .map(([skill, count]) => `<span class="skill-chip">${escapeHtml(skill)} <b>${count}</b></span>`)
        .join("")}</div>`
    : "";
  return `<article class="agent-chart-card ${selected ? "selected" : ""} ${detail ? "detail" : ""}" data-node="${escapeHtml(node.id)}">
    <div class="agent-chart-head">
      <span class="status-dot ${status}"></span>
      <b>${escapeHtml(shortName)}</b>
      <span class="agent-chart-role">${escapeHtml(node.role)}</span>
    </div>
    ${specLine}
    <div class="agent-chart-rings">
      <div class="agent-chart-ring-label">${svgDonut(successPct, { tone: successTone, sub: "éxito" })}<span>tasa de éxito</span></div>
      <div class="agent-chart-ring-label" style="align-items:flex-start">${svgTokenRing(tokens, node.token_budget)}</div>
    </div>
    <div class="agent-chart-activity">
      <small>Actividad (tareas en el tiempo)</small>
      ${svgSparkline(activity, { tone: status })}
    </div>
    <div class="agent-chart-stats">
      <span><small>Pila</small><b>${node.task_count || 0}</b></span>
      <span><small>Errores</small><b>${node.error_count || 0}</b></span>
      <span><small>Coste</small><b>$${cost.toFixed(4)}</b></span>
      <span><small>Latencia</small><b>${latency}ms</b></span>
    </div>
    ${caps ? `<div class="agent-chart-caps">${caps}</div>` : ""}
    ${skillChips}
    ${node.token_budget ? `<div class="agent-chart-note">* consumo acumulado del histórico, no mensual.</div>` : ""}
  </article>`;
}

// Compact "performance" card: model tier / task status breakdown. Sits side by
// side with the skill-usage panel; the wider per-model usage list (below,
// full width) needs more room than a half-width column allows.
function renderPerformancePanel(metrics) {
  const modelEntries = Object.entries(metrics?.by_model || {}).slice(0, 6);
  const statusEntries = Object.entries(metrics?.by_status || {});
  return `<section class="skill-usage-panel">
    <h4>Rendimiento</h4>
    <div class="monitor-graph-grid">
      ${miniBarPanel("Tier de modelo", modelEntries, TIER_LABEL)}
      ${miniBarPanel("Estado de tareas", statusEntries)}
    </div>
  </section>`;
}

function renderModelUsagePanel(modelUsage) {
  const usageRows = modelUsage.length
    ? modelUsage
        .map(
          (item) => `<div class="usage-row">
            <div><b>${escapeHtml(item.model)}</b><span>${escapeHtml(item.provider)}</span></div>
            <span>${item.calls} llamadas</span>
            <span>${item.latency_ms || 0}ms</span>
            <strong>$${Number(item.estimated_cost || 0).toFixed(4)}</strong>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">sin llamadas a modelo</div>`;
  return `<section class="skill-usage-panel">
    <h4>Uso por modelo</h4>
    <div class="usage-list">${usageRows}</div>
  </section>`;
}

// Monitor's per-agent cost/latency table, backed by GET /agents/performance
// (stable GROUP BY provider_name over `runs`) — the audit surface's replacement
// for each view recomputing these numbers independently.
//
// Exported (in addition to its normal use inside this module's own views):
// it's a pure function of `perf` writing to no fixed DOM id, which makes it
// reusable as-is by the `karajan.agent-performance` UI object
// (`src/objects/agent-performance.js`) — see registry-bootstrap.js.
export function renderAgentPerformancePanel(perf = state.agentPerformance || []) {
  const rows = perf.length
    ? perf
        .slice()
        .sort((a, b) => (b.task_count || 0) - (a.task_count || 0))
        .map(
          (p) => `<div class="usage-row">
            <div><b>${escapeHtml(p.provider_name)}</b><span>${p.task_count || 0} ejec. · ${p.error_count || 0} err.</span></div>
            <span>${p.avg_latency_ms != null ? Math.round(p.avg_latency_ms) : 0}ms</span>
            <span>${p.total_tokens || 0} tok</span>
            <strong>$${Number(p.total_cost || 0).toFixed(4)}</strong>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">sin ejecuciones registradas</div>`;
  return `<section class="skill-usage-panel">
    <h4>Rendimiento por agente <span class="cost-tag">coste · latencia</span></h4>
    <div class="usage-list">${rows}</div>
  </section>`;
}

// ---- Analítica (Fase 3: DuckDB) --------------------------------------------
// Fetched on Monitor view entry (enterView), NOT on the 20s poll — analytics
// trends don't need sub-second reactivity, so this stays off the hot refresh
// path. Degrades to a friendly "no disponible" state when DuckDB is absent
// (`available:false`, HTTP 200) instead of throwing.
export async function renderAnalyticsSection() {
  const body = $("#analyticsBody");
  if (!body) return;
  let data;
  try {
    data = await api("/analytics/dashboard?days=30");
  } catch (error) {
    $("#analyticsWindow").textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Analítica no disponible</b><span>${escapeHtml(error.message)}</span></div>`;
    return;
  }
  if (!data || data.available === false) {
    $("#analyticsWindow").textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Analítica no disponible</b><span>${escapeHtml((data && data.reason) || "DuckDB no está instalado (extra opcional).")}</span></div>`;
    return;
  }
  $("#analyticsWindow").textContent = `últimos ${data.window_days} días`;
  body.innerHTML = `
    <div class="monitor-panels-row">
      ${renderTrendCard(data.runs_over_time || [])}
      ${renderCostByProviderCard(data.cost_by_provider_by_day || [])}
    </div>
    <div class="monitor-panels-row">
      ${renderSuccessByTypePanel(data.success_rate_by_task_type || [])}
      ${renderLeaderboardPanel(data.provider_leaderboard || [])}
    </div>`;
}

function renderTrendCard(over) {
  if (!over.length) {
    return `<section class="skill-usage-panel"><h4>Actividad en el tiempo</h4><div class="chart-empty">sin ejecuciones en la ventana</div></section>`;
  }
  const runs = over.map((b) => Number(b.run_count || 0));
  const cost = over.map((b) => Number(b.total_cost || 0));
  const lat = over.map((b) => Math.round(b.avg_latency_ms || 0));
  const totalRuns = runs.reduce((a, b) => a + b, 0);
  const totalCost = cost.reduce((a, b) => a + b, 0);
  return `<section class="skill-usage-panel">
    <h4>Actividad en el tiempo <span class="cost-tag">${totalRuns} ejec · $${totalCost.toFixed(4)}</span></h4>
    <div class="analytics-spark-row">
      <div class="analytics-spark"><small>Ejecuciones</small>${svgSparkline(runs, { tone: "accent" })}</div>
      <div class="analytics-spark"><small>Coste (USD)</small>${svgSparkline(cost, { tone: "ok" })}</div>
      <div class="analytics-spark"><small>Latencia media (ms)</small>${svgSparkline(lat, { tone: "warn" })}</div>
    </div>
    <div class="analytics-buckets">
      ${over
        .map(
          (b) => `<div class="analytics-bucket">
            <span>${escapeHtml(String(b.bucket || "").slice(0, 10))}</span>
            <b>${b.run_count || 0} ejec</b>
            <em>$${Number(b.total_cost || 0).toFixed(4)} · ${Math.round(b.avg_latency_ms || 0)}ms</em>
          </div>`
        )
        .join("")}
    </div>
  </section>`;
}

function renderCostByProviderCard(rows) {
  const totals = {};
  rows.forEach((r) => {
    totals[r.provider_name] = (totals[r.provider_name] || 0) + Number(r.total_cost || 0);
  });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1e-9, ...entries.map(([, v]) => v));
  const rowsHtml = entries.length
    ? entries
        .map(([name, v]) => {
          const pct = Math.max(4, Math.round((v / max) * 100));
          return `<div class="skill-usage-row">
            <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <div class="skill-usage-bar"><i style="width:${pct}%"></i></div>
            <b>$${v.toFixed(4)}</b>
          </div>`;
        })
        .join("")
    : `<div class="chart-empty">sin coste registrado en la ventana</div>`;
  return `<section class="skill-usage-panel"><h4>Coste por proveedor</h4>${rowsHtml}</section>`;
}

function renderSuccessByTypePanel(rows) {
  const list = rows.length
    ? rows
        .map((r) => {
          const pct = Math.round((r.success_rate || 0) * 100);
          const tone = pct >= 90 ? "ok" : pct >= 60 ? "warn" : "bad";
          return `<div class="usage-row">
            <div><b>${escapeHtml(r.task_type || "—")}</b><span>${r.run_count || 0} ejec · ${Math.round(r.avg_latency_ms || 0)}ms</span></div>
            <span class="pill ${tone}">${pct}%</span>
            <strong>$${Number(r.total_cost || 0).toFixed(4)}</strong>
          </div>`;
        })
        .join("")
    : `<div class="chart-empty">sin datos por tipo de tarea</div>`;
  return `<section class="skill-usage-panel"><h4>Éxito por tipo de tarea</h4><div class="usage-list">${list}</div></section>`;
}

function renderLeaderboardPanel(rows) {
  const list = rows.length
    ? rows
        .map((r) => {
          const errPct = Math.round((r.error_rate || 0) * 100);
          return `<div class="usage-row">
            <div><b>${escapeHtml(r.provider_name || "—")}</b><span>${r.run_count || 0} ejec · ${errPct}% err · ${Math.round(r.avg_latency_ms || 0)}ms</span></div>
            <span>$${Number(r.avg_cost_per_run || 0).toFixed(4)}/ejec</span>
            <strong>$${Number(r.total_cost || 0).toFixed(4)}</strong>
          </div>`;
        })
        .join("")
    : `<div class="chart-empty">sin ejecuciones registradas</div>`;
  return `<section class="skill-usage-panel">
    <h4>Ranking de proveedores <span class="cost-tag">coste · latencia · error</span></h4>
    <div class="usage-list">${list}</div>
  </section>`;
}

// ---- Predicciones (Fase 4: XGBoost) ----------------------------------------
// The expected normal state right now is meets_gate=false (production has ~42
// usable runs vs the 200 gate) — that renders as informative progress, never an
// error. meets_gate + untrained → offer training; trained → a compact predict form.
export async function renderPredictionsPanel() {
  const body = $("#predictionsBody");
  if (!body) return;
  const hint = $("#predictionsHint");
  let s;
  try {
    s = await api("/analytics/predictions/status");
  } catch (error) {
    if (hint) hint.textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Predicciones no disponibles</b><span>${escapeHtml(error.message)}</span></div>`;
    return;
  }
  state.predictionStatus = s;
  const min = s.min_required || 200;
  const samples = s.samples || 0;
  const pct = Math.min(100, Math.round((samples / min) * 100));
  const remaining = Math.max(0, min - samples);

  if (s.reason && !s.trained && !s.meets_gate) {
    // ML libs (xgboost) unavailable — treated distinctly from "not enough data".
    if (hint) hint.textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Predicciones no disponibles</b><span>${escapeHtml(s.reason)}</span></div>`;
    return;
  }
  if (s.trained) {
    if (hint) hint.textContent = "modelos entrenados";
    body.innerHTML = renderPredictForm(s);
    $("#predictBtn")?.addEventListener("click", runPrediction);
    return;
  }
  if (s.meets_gate) {
    if (hint) hint.textContent = "listo para entrenar";
    body.innerHTML = `<div class="predict-progress">
      <div class="predict-progress-head"><b>${samples}/${min} ejecuciones</b><span>umbral alcanzado</span></div>
      <div class="predict-bar"><i style="width:${pct}%"></i></div>
      <p>Hay datos suficientes. Entrena los modelos de éxito, coste y latencia.</p>
      <button type="button" class="primary" id="trainModelsBtn">Entrenar modelos</button>
    </div>`;
    $("#trainModelsBtn")?.addEventListener("click", trainPredictiveModels);
    return;
  }
  if (hint) hint.textContent = `${remaining} restantes`;
  body.innerHTML = `<div class="predict-progress">
    <div class="predict-progress-head"><b>${samples}/${min} ejecuciones</b><span>${remaining} más para activar predicciones</span></div>
    <div class="predict-bar"><i style="width:${pct}%"></i></div>
    <p>Las predicciones (éxito, coste, latencia y anomalías) se activan al alcanzar ${min} ejecuciones completadas. Sigue ejecutando tareas para acumular historial.</p>
  </div>`;
}

async function trainPredictiveModels() {
  const btn = $("#trainModelsBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Entrenando…";
  }
  try {
    await api("/analytics/train", { method: "POST" });
    toast("Modelos entrenados.");
  } catch (error) {
    toast(`Entrenamiento: ${error.message}`);
  } finally {
    renderPredictionsPanel().catch(() => {});
  }
}

const PREDICT_CRITERIA = [
  "ambiguity",
  "context_required",
  "reasoning_depth",
  "autonomy_required",
  "operational_risk",
  "validation_difficulty",
];

function renderPredictForm(s) {
  return `<div class="predict-form">
    <p>Modelos entrenados sobre ${s.samples || 0} ejecuciones. Estima éxito, coste y latencia de una tarea borrador.</p>
    <div class="predict-criteria">
      <label class="predict-field"><span>intención</span><input type="text" id="pfIntent" value="implement" /></label>
      <label class="predict-field"><span>complejidad (0-1)</span><input type="number" id="pfComplexity" min="0" max="1" step="0.1" value="0.5" /></label>
      ${PREDICT_CRITERIA.map(
        (k) => `<label class="predict-field"><span>${k}</span><input type="number" class="pf-crit" data-crit="${k}" min="0" max="5" step="0.5" value="2.5" /></label>`
      ).join("")}
    </div>
    <button type="button" class="primary" id="predictBtn">Predecir</button>
    <div id="predictResult"></div>
  </div>`;
}

async function runPrediction() {
  const criteria = {};
  $$(".pf-crit").forEach((i) => (criteria[i.dataset.crit] = Number(i.value) || 0));
  const payload = {
    intent: ($("#pfIntent")?.value || "implement").trim() || "implement",
    criteria,
    complexity_score: Number($("#pfComplexity")?.value) || 0,
  };
  const out = $("#predictResult");
  if (out) out.innerHTML = `<div class="chart-empty">Prediciendo…</div>`;
  try {
    const r = await api("/predict/task", { method: "POST", body: JSON.stringify(payload) });
    if (out)
      out.innerHTML = `<div class="predict-out">
        <div><small>Prob. de éxito</small><b>${Math.round((r.predicted_success_prob || 0) * 100)}%</b></div>
        <div><small>Coste estimado</small><b>$${Number(r.predicted_cost_usd || 0).toFixed(4)}</b></div>
        <div><small>Latencia estimada</small><b>${Math.round(r.predicted_latency_ms || 0)}ms</b></div>
        <div><small>Anomalía</small><b>${r.is_anomaly ? "sí" : "no"}</b></div>
      </div>`;
  } catch (error) {
    if (out) out.innerHTML = `<div class="chart-empty">${escapeHtml(error.message)}</div>`;
  }
}

// ---- Búsqueda de tareas (Fase 3: FTS5) -------------------------------------
// Debounced full-text search over /search/tasks; a result selects/scrolls-to the
// matching row in the tasks table when it's currently loaded.
let taskSearchTimer = null;

export function initTaskSearch() {
  const input = $("#taskSearch");
  if (!input) return;
  input.addEventListener("input", () => {
    clearTimeout(taskSearchTimer);
    const q = input.value.trim();
    if (!q) {
      hideTaskSearchResults();
      return;
    }
    taskSearchTimer = setTimeout(() => runTaskSearch(q), 300);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".task-search")) hideTaskSearchResults();
  });
}

function hideTaskSearchResults() {
  const box = $("#taskSearchResults");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
}

async function runTaskSearch(q) {
  const box = $("#taskSearchResults");
  if (!box) return;
  let data;
  try {
    data = await api(`/search/tasks?q=${encodeURIComponent(q)}&limit=20`);
  } catch (error) {
    box.hidden = false;
    box.innerHTML = `<div class="task-search-empty">${escapeHtml(error.message)}</div>`;
    return;
  }
  const results = data.results || [];
  box.hidden = false;
  if (!results.length) {
    box.innerHTML = `<div class="task-search-empty">Sin resultados para “${escapeHtml(q)}”.</div>`;
    return;
  }
  box.innerHTML =
    `<div class="task-search-count">${data.count} resultado${data.count === 1 ? "" : "s"}</div>` +
    results
      .map((r) => {
        const created = r.created_at ? String(r.created_at).slice(0, 10) : "";
        return `<button type="button" class="task-search-item" data-legacy="${escapeHtml(r.legacy_task_id || "")}">
          <b>${escapeHtml(r.title || r.legacy_task_id || r.id || "tarea")}</b>
          <span>${escapeHtml(r.task_type || "—")} · ${escapeHtml(r.status || "")} · ${created}</span>
        </button>`;
      })
      .join("");
  $$(".task-search-item", box).forEach((btn) =>
    btn.addEventListener("click", () => selectSearchResult(btn.dataset.legacy))
  );
}

function selectSearchResult(legacyId) {
  hideTaskSearchResults();
  const input = $("#taskSearch");
  if (input) input.value = "";
  if (!legacyId) {
    toast("La tarea no tiene id legacy asociado.");
    return;
  }
  const row = $(`#taskRows tr[data-id="${CSS.escape(legacyId)}"]`);
  if (row) {
    row.click();
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("search-flash");
    setTimeout(() => row.classList.remove("search-flash"), 1200);
  } else {
    toast("La tarea no está en la lista visible actual.");
  }
}

// "Todos" shows every agent's chart card; picking one agent filters the same
// grid down to just that card instead of routing to a second, separate detail
// surface — one render path, no duplicated logic between the two views.
function renderNodeFilterTabs(nodes) {
  const active = nodes.some((n) => n.id === state.nodeFilter) ? state.nodeFilter : "__all__";
  const chip = (id, label, selected) =>
    `<button type="button" class="node-filter-chip ${selected ? "active" : ""}" data-node-filter="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
  return `<div class="node-filter-tabs">
    ${chip("__all__", "Todos", active === "__all__")}
    ${nodes
      .map((node) => chip(node.id, (node.name || "Nodo").split("(")[0].trim().split(",")[0].trim(), active === node.id))
      .join("")}
  </div>`;
}

function renderNodeOverview(nodes, metrics, modelUsage = []) {
  const target = $("#nodeOverview");
  if (!target) return;
  if (!nodes.length) {
    target.innerHTML = `<div class="chart-empty">Sin nodos observados todavía.</div>`;
    return;
  }
  const active = nodes.some((n) => n.id === state.nodeFilter) ? state.nodeFilter : "__all__";
  const visible = active === "__all__" ? nodes : nodes.filter((n) => n.id === active);
  // "Todos" keeps the system-wide skill-usage/performance panels above the
  // grid; a single agent instead gets one condensed spec+stats card (detail
  // mode) so its spec isn't spread across three stacked sections.
  target.innerHTML =
    active === "__all__"
      ? `${renderNodeFilterTabs(nodes)}
    <div class="monitor-panels-row">
      ${renderSkillUsagePanel(nodes)}
      ${renderPerformancePanel(metrics)}
    </div>
    ${renderModelUsagePanel(modelUsage)}
    ${renderAgentPerformancePanel()}
    <div class="agent-chart-grid">
      ${visible.map((node) => agentChartCard(node, { selected: node.id === state.selectedNodeId })).join("")}
    </div>`
      : `${renderNodeFilterTabs(nodes)}
    <div class="agent-chart-grid single">
      ${visible.map((node) => agentChartCard(node, { selected: true, detail: true })).join("")}
    </div>`;

  $$("#nodeOverview .node-filter-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      state.nodeFilter = chip.dataset.nodeFilter;
      if (state.nodeFilter !== "__all__") state.selectedNodeId = state.nodeFilter;
      setMonitorSide(true);
      renderNodeOverview(nodes, metrics, modelUsage);
      _renderAgentPanels(nodes, state.lastObservability?.execution_flow || [], state.lastObservability?.audit_timeline || []);
    })
  );
  $$("#nodeOverview .agent-chart-card").forEach((card) =>
    card.addEventListener("click", () => {
      state.selectedNodeId = card.dataset.node;
      setMonitorSide(true);
      renderNodeOverview(nodes, metrics, modelUsage);
      _renderAgentPanels(nodes, state.lastObservability?.execution_flow || [], state.lastObservability?.audit_timeline || []);
    })
  );
}

function miniBarPanel(title, entries, labelMap = {}) {
  const max = Math.max(1, ...entries.map(([, value]) => Number(value || 0)));
  const rows = entries.length
    ? entries
        .map(([key, value], index) => {
          const pct = Math.max(4, Math.round((Number(value || 0) / max) * 100));
          return `<div class="mini-bar-row" style="--bar-color:${dvSeries(index)}"><span>${escapeHtml(labelMap[key] || key)}</span><b>${value}</b><i style="width:${pct}%"></i></div>`;
        })
        .join("")
    : `<div class="chart-empty">sin datos</div>`;
  return `<section class="mini-graph-card"><h4>${escapeHtml(title)}</h4>${rows}</section>`;
}

function latencyPanel(health) {
  const latency = Number(health?.avg_latency_ms || 0);
  const pct = Math.min(100, Math.round((latency / 2000) * 100));
  return `<section class="mini-graph-card latency-card">
    <h4>Latencia media</h4>
    <div class="latency-ring" style="--pct:${pct}%">${svgDonut(pct, { label: "Latencia media", sub: "2s SLA", tone: pct > 80 ? "bad" : pct > 55 ? "warn" : "ok", size: 92 })}<b>${latency}ms</b><span>media</span></div>
    <p>${health?.blocked_tasks || 0} bloqueadas · $${Number(health?.total_cost || 0).toFixed(4)} coste</p>
  </section>`;
}

export async function showProviderSetup(name) {
  const targets = $$(`[data-provider-setup-target="${CSS.escape(name)}"]`);
  if (!targets.length) return;
  targets.forEach((target) => {
    target.hidden = false;
    target.innerHTML = `<div class="human-home-empty">Cargando pasos de configuración…</div>`;
  });
  try {
    const setup = await api(`/providers/${encodeURIComponent(name)}/setup`);
    const html = `<div class="provider-setup-box">
      ${(setup.steps || []).map((step) => `<div><span>${escapeHtml(step)}</span></div>`).join("") || "<div><span>Sin pasos disponibles.</span></div>"}
    </div>`;
    targets.forEach((target) => (target.innerHTML = html));
  } catch (error) {
    const html = `<div class="provider-setup-box"><div><span>${escapeHtml(error.message)}</span></div></div>`;
    targets.forEach((target) => (target.innerHTML = html));
  }
}

// Single source of truth for provider cost/latency: GET /agents/performance
// (Fase 1, GROUP BY provider_name over `runs`). Views consume this cached
// aggregate instead of each recomputing coste/latencia from /metrics+/observability.
function computeCostLatency(perf = state.agentPerformance || []) {
  let totalCost = 0, tasks = 0, errors = 0, tokens = 0, latSum = 0, latWeight = 0;
  perf.forEach((p) => {
    const weight = Number(p.task_count || 0) || 1;
    totalCost += Number(p.total_cost || 0);
    tasks += Number(p.task_count || 0);
    errors += Number(p.error_count || 0);
    tokens += Number(p.total_tokens || 0);
    if (p.avg_latency_ms != null) { latSum += Number(p.avg_latency_ms) * weight; latWeight += weight; }
  });
  return { totalCost, tasks, errors, tokens, avgLatency: latWeight ? Math.round(latSum / latWeight) : 0, hasData: perf.length > 0 };
}

function renderSummaryMetrics(metrics, tasks, observability) {
  if (!$("#summaryMetrics")) return; // Phase D removed the legacy Tareas summary card.
  const nodes = observability.nodes || [];
  const usage = observability.model_usage || [];
  const totalCalls = usage.reduce((acc, item) => acc + Number(item.calls || 0), 0);
  const perf = computeCostLatency();
  // /agents/performance is authoritative for coste/latencia; fall back to the
  // legacy /metrics+/observability numbers only while `runs` has no rows yet.
  const avgLatency = perf.hasData ? perf.avgLatency : (observability.health?.avg_latency_ms || 0);
  const totalCost = perf.hasData ? perf.totalCost : Number(metrics.total_estimated_cost_usd || 0);
  const completed = metrics.by_status?.completed || 0;
  const delegated = metrics.by_status?.delegated || metrics.delegated_tasks || 0;
  const items = [
    ["Nodos", nodes.length || observability.health?.observed_nodes || 0],
    ["Llamadas", totalCalls],
    ["Completadas", completed],
    ["Delegadas", delegated],
    ["Latencia media", `${avgLatency}ms`],
    ["Coste total", `$${Number(totalCost).toFixed(4)}`],
  ];
  $("#summaryMetrics").innerHTML = `<div class="summary-hero">
      <span>Actividad total</span>
      <b>${metrics.total_subtasks || totalCalls || tasks.length}</b>
      <small>${delegated} delegadas · ${completed} completadas</small>
    </div>
    <div class="summary-grid">
      ${items
        .map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`)
        .join("")}
    </div>`;
}

function renderAuditTimeline(events) {
  const target = $("#auditTimeline");
  if (!target) return;
  const node = (state.lastObservability?.nodes || []).find((item) => item.id === state.selectedNodeId);
  if (!node) {
    target.innerHTML = `<div class="chart-empty">Selecciona un agente.</div>`;
    return;
  }
  const total = Math.max(1, node.task_count || 0);
  const errors = Math.min(total, node.error_count || 0);
  const ok = Math.max(0, total - errors);
  const cost = Number(node.estimated_cost || 0);
  const latency = Number(node.latency_ms || 0);
  target.innerHTML = `<div class="agent-usage-panel">
    <div class="usage-split">
      <span style="--w:${Math.round((ok / total) * 100)}%"><b>${ok}</b><small>ok</small></span>
      <span style="--w:${Math.round((errors / total) * 100)}%"><b>${errors}</b><small>err.</small></span>
    </div>
    <div class="side-mini-grid">
      <span><b>${latency}ms</b><small>latencia</small></span>
      <span><b>$${cost.toFixed(4)}</b><small>coste</small></span>
      <span><b>${(node.active_capabilities || []).length}</b><small>capacidades</small></span>
      <span><b>${(node.skills || []).length}</b><small>skills</small></span>
    </div>
    <div class="side-tags">${(node.active_capabilities || []).map((cap) => `<em>${escapeHtml(cap)}</em>`).join("") || "<em>sin capacidades</em>"}</div>
  </div>`;
}

function eventList(events, emptyText) {
  return events.length
    ? events
        .map(
          (event) => `<div class="event-row ${escapeHtml(event.status || "")}">
            <span class="event-dot" aria-hidden="true"></span>
            <div class="event-main">
              <div class="event-line">
                <time>${formatTime(event.timestamp)}</time>
                <b>${escapeHtml(friendlyEventType(event.event_type))}</b>
                <em>${event.cost ? `$${Number(event.cost).toFixed(4)}` : event.latency_ms ? `${event.latency_ms}ms` : ""}</em>
              </div>
              <span>${escapeHtml(cleanEventSummary(event.summary))}</span>
              <small>${escapeHtml(event.source_node || "Agent")}${event.target_node ? ` → ${escapeHtml(event.target_node)}` : ""}${event.model ? ` · ${escapeHtml(TIER_LABEL[event.model] || event.model)}` : ""}</small>
            </div>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">${emptyText}</div>`;
}

function friendlyEventType(type = "") {
  const map = {
    prompt_received: "Solicitud recibida",
    task_classified: "Clasificación",
    task_assigned: "Asignación",
    task_delegated: "Delegación",
    provider_fallback: "Reserva de proveedor",
    task_reassigned: "Reasignación",
    validation: "Validación",
    validator_approved: "Validación aprobada",
    validator_rejected: "Validación rechazada",
    task_queued: "En cola",
    waiting_for_agent: "Esperando agente libre",
    tier_escalated: "Escalado de nivel",
    validator_escalated_to_root: "Escalado a raíz",
    task_revised: "Revisión solicitada",
    error_detected: "Error detectado",
    execution: "Ejecución",
  };
  return map[type] || type.replace(/_/g, " ");
}

function cleanEventSummary(summary = "") {
  return String(summary)
    .replace(/\bsub_\d+\s*[:·-]?\s*/gi, "")
    .replace(/\bmodel=[^;\s]+;?/gi, "")
    .replace(/\bstrategy=[^;\s]+;?/gi, "")
    .replace(/\bts(?:k)?_[a-z0-9]+/gi, "")
    .replace(/\s*[·;]\s*$/g, "")
    .trim();
}

function renderModelUsage(items) {
  $("#modelUsage").innerHTML = items.length
    ? items
        .map(
          (item) => `<div class="usage-row">
            <div><b>${escapeHtml(item.model)}</b><span>${escapeHtml(item.provider)}</span></div>
            <span>${item.calls} llamadas</span>
            <span>${item.latency_ms || 0}ms</span>
            <strong>$${Number(item.estimated_cost || 0).toFixed(4)}</strong>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">sin llamadas a modelo</div>`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// KPIs de `/metrics`, en 7 tarjetas con sparkline decorativo. Toma un
// `container` opcional (por defecto `#kpis`, el legacy) para poder usarse
// también desde el objeto UI `karajan.task-metrics`
// (`src/objects/task-metrics.js`), que lo monta en un contenedor propio.
export function renderKpis(metrics, container = $("#kpis")) {
  if (!container) return;
  const topModel = Object.entries(metrics.by_model).sort((a, b) => b[1] - a[1])[0];
  const cells = [
    ["Tareas", metrics.total_tasks, "M0,15 L20,12 L40,18 L60,8 L80,14 L100,10"],
    ["Delegadas", metrics.delegated_tasks ?? 0, "M0,18 L20,15 L40,10 L60,12 L80,5 L100,8"],
    ["Subtareas", metrics.total_subtasks ?? 0, "M0,15 L20,15 L40,15 L60,5 L80,10 L100,5"],
    ["Score medio", metrics.average_complexity_score.toFixed(2), "M0,15 L20,13 L40,11 L60,10 L80,9 L100,10"],
    ["Revisión humana", metrics.human_review_required, "M0,18 L70,18 L100,5"],
    ["Coste est.", `$${metrics.total_estimated_cost_usd.toFixed(4)}`, "M0,15 L20,16 L40,17 L60,14 L80,12 L100,10"],
    ["Modelo top", topModel ? TIER_LABEL[topModel[0]] || topModel[0] : "—", "M0,10 L100,10"],
  ];
  container.innerHTML = cells
    .map(
      ([label, value, path]) => `<div class="kpi"><span>${label}</span><b>${escapeHtml(value)}</b>
        <svg viewBox="0 0 100 22" aria-hidden="true"><path d="${path}" vector-effect="non-scaling-stroke"></path></svg>
      </div>`
    )
    .join("");
}

// inline SVG horizontal bar chart — no external lib
function barCard(title, entries, labelMap) {
  const rows = entries.length
    ? hbarChart({
        rows: entries.map(([key, value], index) => ({
          label: labelMap ? labelMap[key] || key : key,
          value,
          seriesIndex: index,
        })),
        valueFormat: (v) => dvNum(v),
        maxLabelWidth: 128,
      })
    : `<div class="chart-empty">sin datos</div>`;
  return `<section class="chart-card"><header class="card-h">${title}</header><div class="chart-body">${rows}</div></section>`;
}

function renderCharts(metrics) {
  const byLevel = LEVELS.map(([key]) => [key, metrics.by_level[key] || 0]).filter(([, v]) => v || true);
  const reviewRatio = metrics.total_tasks
    ? Math.round((metrics.human_review_required / metrics.total_tasks) * 100)
    : 0;
  const gauge = `<section class="chart-card"><header class="card-h">Revisión humana</header>
    <div class="gauge"><div class="gauge-num">${reviewRatio}%</div>
      <div class="gauge-track"><div class="gauge-fill" style="width:${reviewRatio}%"></div></div>
      <div class="gauge-sub">${metrics.human_review_required}/${metrics.total_tasks} tareas · score medio ${metrics.average_complexity_score.toFixed(
        2
      )}</div></div></section>`;
  $("#charts").innerHTML =
    barCard("Por nivel de complejidad", byLevel, LEVEL_FULL) +
    barCard("Por modelo / tier", Object.entries(metrics.by_model), TIER_LABEL) +
    barCard("Por backend", Object.entries(metrics.by_backend)) +
    barCard("Por estado", Object.entries(metrics.by_status || {})) +
    barCard("Por skill", Object.entries(metrics.by_skill || {})) +
    gauge;
}

function statusPill(status) {
  const cls = status === "completed" ? "ok" : status === "failed" ? "bad" : "warn";
  return `<span class="pill ${cls}">${status}</span>`;
}

function renderTaskRows(tasks) {
  // Phase D replaced the legacy Tareas table with renderTareas(); this legacy
  // renderer no-ops when its old targets are gone so refreshMonitor() stays safe.
  if (!$("#taskRows")) return;
  $("#taskCount").textContent = tasks.length ? `${tasks.length}` : "";
  $("#taskRows").innerHTML = tasks
    .map((task) => {
      const c = task.classification;
      const level = c.complexity_level.replace("level_", "L").replace(/_.*/, "");
      const sel = task.task_id === state.selected ? "selected" : "";
      return `<tr class="${sel}" data-id="${task.task_id}">
        <td>${task.task_id}</td><td>${level} · ${c.complexity_score}</td>
        <td>${TIER_LABEL[c.recommended_model] || c.recommended_model}</td>
        <td>${statusPill(task.status)}</td></tr>`;
    })
    .join("");
  $$("#taskRows tr").forEach((row) =>
    row.addEventListener("click", () => {
      state.selected = row.dataset.id;
      $$("#taskRows tr").forEach((r) => r.classList.toggle("selected", r === row));
      const task = state.tasks.find((t) => t.task_id === row.dataset.id);
      if (task) renderDetail(task);
    })
  );
}

async function renderDetail(task) {
  // Phase D replaced this cramped side-card with the full-width Tareas drill-down
  // (renderTareasDetail). Kept + guarded so refreshMonitor()'s call is a no-op.
  if (!$("#detail")) return;
  const c = task.classification;
  $("#detailEmpty").hidden = true;
  $("#detail").hidden = false;
  $("#dId").textContent = task.task_id;
  $("#dIntent").textContent = c.intent;
  $("#dDomains").textContent = c.domain.join(", ");
  $("#dStrategy").textContent = c.recommended_strategy;
  $("#dBy").textContent = c.classified_by;
  $("#dReason").textContent = c.reason;
  $("#dSkills").innerHTML = (c.recommended_skills || [])
    .map((skill) => `<span class="tag">${escapeHtml(skill)}</span>`)
    .join("");

  $("#dCriteria").innerHTML = Object.entries(c.criteria)
    .map(([name, value]) => {
      const pct = Math.round((Number(value) / 5) * 100);
      return `<div class="bar-row"><div class="bar-label"><span>${name}</span><span>${Number(value).toFixed(1)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></div>`;
    })
    .join("");

  const execs = new Map((task.delegation?.executions || []).map((e) => [e.subtask_id, e]));
  $("#dSubtasks").innerHTML = c.subtasks
    .map((sub) => {
      const ex = execs.get(sub.id);
      const meta = ex
        ? `${ex.backend}:${ex.model_used} · ${ex.status} · ${ex.latency_ms}ms · $${ex.estimated_cost_usd.toFixed(5)}`
        : `${TIER_LABEL[sub.recommended_model] || sub.recommended_model} · pendiente`;
      const skill = sub.recommended_skill ? ` · skill: ${escapeHtml(sub.recommended_skill)}` : "";
      return `<div class="subtask"><code>${sub.id}</code> <b>${escapeHtml(sub.name)}</b>
        <div class="meta">${escapeHtml(meta)}${skill}</div></div>`;
    })
    .join("");

  try {
    const decisions = await api(`/tasks/${task.task_id}/decisions`);
    const approval = task.status === "delegated" && c.requires_human_review
      ? `<button class="approve-review" data-approve="${task.task_id}">Aprobar revisión humana</button>`
      : "";
    $("#dDecisions").innerHTML =
      decisions
        .map(
          (d) =>
            `<div class="row"><b>[${d.phase}]</b> ${escapeHtml(d.decision)}${
              d.reason ? ` — ${escapeHtml(d.reason)}` : ""
            }</div>`
        )
        .join("") + approval || `<div class="row">Sin decisiones registradas.</div>${approval}`;
  } catch {
    $("#dDecisions").innerHTML = `<div class="row">No disponible.</div>`;
  }
}
