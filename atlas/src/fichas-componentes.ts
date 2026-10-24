import { join } from 'node:path';

import { UMBRALES_AB } from './ab';
import { aislarActivo, equipo } from './aislar-git';
import { UMBRALES_CURADOR } from './curador';
import { MAX_SOBRECOSTE_EFICIENCIA, SKILLS_EFICIENCIA } from './eficiencia';
import { MAX_SOBRECOSTE_METODO, SKILLS_METODO } from './metodo';
import { MAX_SOBRECOSTE_PROMPTS, SKILLS_PROMPTS } from './prompts';
import type { Configuracion } from './heuristica';
import { rutaLimites, umbralClaude, type Limites } from './limites';
import { ESTADOS_ACEPTADA, type Modo } from './modo';
import { PESOS as PESOS_ACIERTO, VENTANA_MS } from './produccion';
import { buscarBinario, PROVEEDORES } from './proveedores';
import type { Perfil } from './reglas';
import type { EstadoRotador } from './rotador';
import { PESOS_SELECTOR } from './skills-seleccion';

/**
 * La ficha de cada componente para la ventana de Atlas dev: qué hace, cómo (entradas → pasos → salidas, con el fichero que
 * implementa cada paso), las reglas que cumple y la configuración con la que corre AHORA. Todo sale del código de `atlas/src/`
 * y de docs/laboratorio/componentes.md; `especificado: false` marca los componentes que aún no tienen código (solo el borrador
 * que los traerá), cuya ficha es corta a propósito.
 */
export type ValorConfig = string | number | boolean | string[];

/** Lo que una ficha puede leer para dar su configuración viva. Solo lectura: nada de aquí escribe. */
export interface ContextoFicha {
  version: string; modo: Modo;
  /** Carpeta de datos efectiva (`task_logs.db`, `modo.json`, perfiles) y la del laboratorio. */
  dirDatos: string; dirLab: string;
  config(): Configuracion;
  /** El perfil POR DEFECTO (el que ejecuta), o null si no se puede leer. */
  perfil(): Perfil | null;
  rotador: { leerEstado(): EstadoRotador };
  limites(): Limites | null;
  pasarela: { leer(): Record<string, unknown> };
  biblioteca: { disponible: boolean; ruta: string | null };
}

export interface FichaComponente {
  /** false: el componente aún no tiene código; la ficha sale de su borrador. */
  especificado: boolean;
  resumen: string;
  como_funciona: { entradas: string[]; pasos: string[]; salidas: string[] };
  reglas?: string[];
  configuracion(ctx: ContextoFicha): Record<string, ValorConfig>;
}

const N = (nivel: string) => `N${/([1-5])/.exec(nivel)?.[1] ?? '?'}`;
const sinConfig = () => ({});
const borrador = (nombre: string, resumen: string, entradas: string[], salidas: string[]): FichaComponente => ({
  especificado: false, resumen, como_funciona: { entradas, pasos: [`Aún sin código: lo trae el borrador «${nombre}» (docs/laboratorio/componentes.md §7)`], salidas }, configuracion: sinConfig,
});

export const FICHAS: Record<string, FichaComponente> = {
  // ── Decisión ──
  clasificador: {
    especificado: true,
    resumen: 'Clasifica un prompt sin LLM: detecta dominio e intención por palabras, puntúa seis criterios, pondera la complejidad y de ahí saca el nivel (N1–N5), el modelo lógico, las skills sugeridas, las subtareas y si hace falta revisión humana.',
    como_funciona: {
      entradas: ['Texto del prompt', 'Configuración activa (pesos de criterios, umbrales de nivel, nivel→modelo, política de revisión) de active_config.json'],
      pasos: [
        'Normaliza a minúsculas y cuenta palabras (heuristica.ts · clasificar)',
        'Detecta dominios por palabras clave: security, devops, programming, data, documents, product; «general» si ninguno (heuristica.ts · detectarDominios)',
        'Detecta la intención: diagnose_and_fix, implement_feature, analyze_or_review, transform_or_extract o classify_and_plan (heuristica.ts · detectarIntencion)',
        'Puntúa seis criterios de 0 a 5: ambigüedad, contexto, razonamiento, autonomía, riesgo operativo y dificultad de validación (heuristica.ts · ambiguedad … validacion)',
        'Complejidad = suma ponderada de los criterios con criteria_weights, redondeada a 2 decimales (heuristica.ts · calcularComplejidad)',
        'Nivel por umbrales [1.5, 2.5, 3.5, 4.3] y modelo lógico por level_to_model (heuristica.ts · nivelPara, modeloPara)',
        'Propone skills por dominio (+ repo-analyzer si diagnostica o revisa, + security-review en N5, + ponytail) y reparte 2–4 subtareas según nivel e intención (heuristica.ts · skillsRecomendadas, subtareas)',
        'Decide la revisión humana: nivel ≥ mínimo, riesgo ≥ umbral, dominio sensible o intención crítica (heuristica.ts · requiereRevision)',
      ],
      salidas: ['Clasificacion: task_id, dominios, intención, criterios, complejidad, nivel, modelo recomendado, estrategia, skills, subtareas, requires_human_review, razón y plan de validación'],
    },
    reglas: [
      'Es determinista: el mismo prompt da la misma clasificación (salvo task_id y fecha).',
      'No guarda nada: persistir la tarea es del delegador.',
      'Paridad con el original Python comprobada contra salidas grabadas (tests/paridad.test.ts).',
    ],
    configuracion: (c) => {
      const k = c.config();
      return {
        pesos_criterios: Object.entries(k.criteria_weights).map(([n, p]) => `${n} = ${p}`),
        umbrales_nivel: k.level_thresholds.map((u, i) => `N${i + 1} ≤ ${u}`),
        nivel_a_modelo: Object.entries(k.level_to_model).map(([n, m]) => `${N(n)} → ${m}`),
        dominios_sensibles: k.policy.sensitive_domains,
        intenciones_criticas: k.policy.critical_intents,
        revision_humana_desde_nivel: k.policy.human_review_min_level,
        revision_humana_riesgo_desde: k.policy.operational_risk_review_threshold,
      };
    },
  },
  delegador: {
    especificado: true,
    resumen: 'Elige qué agente (Claude Code, Codex o Qwen) hace cada subtarea con el perfil por defecto —primero sus reglas por dominio, luego sus niveles—, aplica el respaldo y el límite semanal de Claude, y puede ejecutarlo registrándolo todo.',
    como_funciona: {
      entradas: ['Prompt (clasificado por el clasificador y con las skills del selector)', 'Perfil por defecto de routing_layout.json (entidades y reglas)', 'Disponibilidad de los agentes en este equipo', 'Límites del plan (limites-plan.json)'],
      pasos: [
        'Clasifica el prompt y pide las skills al selector, que quedan en la primera subtarea (delegar.ts · planificar)',
        'Por subtarea, si se forzó una entidad la usa; si no, toma la PRIMERA regla activa que case por dominio (o área frontend/backend/oficina del texto), intención y nivel (reglas.ts · elegirRegla)',
        'Sin regla, la primera entidad cuyo nivel incluya el de la subtarea (delegar.ts · asignar)',
        'Si el agente no está disponible, respaldo en orden codex → claude-cli → ollama-qwen (con skills solo codex o claude-cli) (delegar.ts · asignar)',
        'Si Claude pasó su umbral semanal, lo suyo se va a Codex y se anota (delegar.ts · asignar, limites.ts · claudeExcedido)',
        'Delegar: guarda la tarea y las decisiones classify/validate/assign/fallback; una tarea con revisión humana queda bloqueada hasta aprobarla (delegar.ts · delegar)',
        'En segundo plano, por subtarea: espera turno según max_concurrent, trabaja en su worktree si está activo, repone la skill con el rotador y lanza el agente con 15 min de tiempo (delegar.ts · ejecutar)',
        'Registra cada run, cierra la rama git y deja la tarea como completed o failed (delegar.ts · ejecutar)',
      ],
      salidas: ['Plan: una asignación por subtarea (entidad, proveedor, modelo, regla o nivel que decidió, motivo)', 'Con delegar: tarea, decisiones y runs en task_logs.db'],
    },
    reglas: [
      'Cada decisión sale de una regla o de un nivel del perfil y queda explicada en el motivo.',
      'Se ejecuta el perfil por defecto (default_profile_id), no el que se esté editando.',
      'Qwen no recibe skills: si la subtarea las lleva, pasa a Codex o Claude.',
      'Planificar no ejecuta nada ni escribe en el registro.',
    ],
    configuracion: (c) => {
      const p = c.perfil();
      const reglas = p?.rules ?? [];
      return {
        perfil: p ? `${p.name} (${p.id})` : 'sin perfil',
        agentes: (p?.entities ?? []).map((e) => `${e.name || e.id} → ${e.provider ?? 'sin proveedor'}${(e.levels ?? []).length ? ` · ${(e.levels ?? []).map(N).join(' ')}` : ''}${e.max_concurrent ? ` · ${e.max_concurrent} a la vez` : ''}`),
        reglas_activas: reglas.filter((r) => r.enabled !== false).map((r) => `${r.name || r.id} → ${r.entity_id}`),
        reglas_desactivadas: reglas.filter((r) => r.enabled === false).length,
        umbral_claude_semanal: umbralClaude(),
        respaldo: ['codex', 'claude-cli', 'ollama-qwen'],
        tiempo_maximo_min: 15,
        aislar_git: aislarActivo(),
      };
    },
  },
  selector: {
    especificado: true,
    resumen: 'Elige hasta tres skills para un prompt puntuándolas contra las que hay en el equipo: nombre citado, alias, palabras del nombre y de la descripción, con un umbral mínimo.',
    como_funciona: {
      entradas: ['Texto del prompt', 'Skills del equipo: carpetas con SKILL.md instaladas (~/.claude, ~/.codex, ~/.agents) o en el almacén del rotador (nombre y descripción)'],
      pasos: [
        'Descubre las skills y lee su descripción de la cabecera de SKILL.md (skills-seleccion.ts · descubrirSkills)',
        'Si el prompt nombra la skill, 100 puntos; si no, suma alias (35 + 2 por alias, tope 10), 11 por palabra del nombre y 2 por palabra de la descripción (skills-seleccion.ts · puntuarSkills)',
        'Descarta las que no llegan al umbral (15 puntos) y las source-command-* sin alias (skills-seleccion.ts · puntuarSkills)',
        'Ordena: repo-analyzer primero, security-review al final, el resto por posición en el prompt y puntos (skills-seleccion.ts · puntuarSkills)',
        'Se queda con las tres primeras (skills-seleccion.ts · seleccionarSkills)',
      ],
      salidas: ['Lista de nombres de skill (con sus puntos si se pide el detalle)'],
    },
    reglas: [
      'Toda skill instalada debe salir si se nombra en el prompt (lo comprueba el escenario «explicitas»).',
      'Los pesos no se cambian solos: el laboratorio solo propone otros si mejoran el F1 en datos no vistos.',
    ],
    configuracion: () => ({
      peso_explicita: PESOS_SELECTOR.explicita, peso_alias: PESOS_SELECTOR.alias, peso_por_alias: PESOS_SELECTOR.porAlias, tope_alias: PESOS_SELECTOR.topeAlias,
      peso_por_nombre: PESOS_SELECTOR.porNombre, peso_por_descripcion: PESOS_SELECTOR.porDescripcion, umbral: PESOS_SELECTOR.umbral, maximo_skills: 3,
    }),
  },
  rotador: {
    especificado: true,
    resumen: 'Deja instaladas solo las skills que se usan: las demás se MUEVEN a un almacén local (nada se borra) y vuelven al instante cuando una delegación las necesita.',
    como_funciona: {
      entradas: ['Carpetas de skills instaladas y del almacén (~/.karajan/skills-almacen)', 'Último uso de cada skill: skills-uso.json de Atlas dev, ejecuciones de Karajan y reposiciones propias', 'rotador.json (días y skills protegidas)'],
      pasos: [
        'Recoge el último uso de cada skill de las tres fuentes (rotador.ts · ultimosUsos)',
        'Clasifica: núcleo si se usó en 14 días, frecuente en 45, instantánea si se repuso hace ≤ 3 días, inactiva el resto (rotador.ts · nivel)',
        'Plan: retirar las inactivas no protegidas; reponer las del almacén que vuelven a usarse (rotador.ts · plan)',
        'Aplicar mueve carpetas instaladas ⇄ almacén, solo con tarea aceptada en producción (rotador.ts · aplicar, servidor.ts · /skills/rotar)',
        'Antes de ejecutar una subtarea, el delegador pide asegurar la skill: si no está instalada, la repone (rotador.ts · asegurar)',
      ],
      salidas: ['Inventario con nivel por skill', 'Plan de rotación (retirar / reponer)', 'Skills instaladas y almacén actualizados al aplicar'],
    },
    reglas: ['Las protegidas (router, latex-template y las que se añadan) nunca se retiran.', 'Retirar es mover, no borrar.'],
    configuracion: (c) => {
      const e = c.rotador.leerEstado();
      return { dias_nucleo: e.config.nucleoDias, dias_frecuente: e.config.frecuenteDias, dias_instantanea: e.config.instantaneaDias, protegidas: e.config.protegidas, repuestas_recientes: Object.keys(e.repuestas).length };
    },
  },
  etiquetas: borrador('Componente etiquetas', 'Pondrá la cabecera «Atlas dev · tarea <id>» y el glosario de etiquetas al agente. Hoy vive en atlas-dev (server/src/tareas/formato.ts).', ['Tarea de Atlas dev'], ['Cabecera y glosario en el prompt del agente']),

  // ── Base ──
  almacen: {
    especificado: true,
    resumen: 'Guarda y lee el registro de tareas, decisiones, runs y revisiones en task_logs.db (SQLite en WAL), con el mismo esquema que el Karajan nativo.',
    como_funciona: {
      entradas: ['Tareas, decisiones y runs que escribe el delegador', 'Revisiones del baúl que envía Atlas dev'],
      pasos: [
        'Crea las tablas vacías si no existen para que un paquete recién instalado responda (almacen.ts · constructor)',
        'Lee tareas, runs y decisiones saltándose las filas dañadas, como Python (almacen.ts · listarTareas, aTarea)',
        'Agrega métricas y rendimiento por agente en SQL (almacen.ts · metricas, rendimientoAgentes)',
        'Aplana tareas con revisiones y decisiones para la analítica (almacen.ts · tareasPlanas)',
        'Escribe tarea, decisiones y runs de una delegación (almacen.ts · guardarTarea, registrarDecision, registrarRun)',
      ],
      salidas: ['Registros de tareas, runs y decisiones', 'Agregados para /metrics y /agents/performance'],
    },
    reglas: ['Comparte el fichero con el Karajan nativo cuando existe (SQLite en WAL admite los dos procesos).', 'Los redondeos y fechas replican a Python (redondeo.ts, paridad.test.ts).'],
    configuracion: (c) => ({ fichero: join(c.dirDatos, 'task_logs.db') }),
  },
  biblioteca: {
    especificado: true,
    resumen: 'Da la ficha de una skill (descripción, estrellas, repo, grupo de la taxonomía) leyendo resources.db en solo lectura, y busca en ella por texto.',
    como_funciona: {
      entradas: ['Nombre de la skill o texto de búsqueda', 'resources.db del Karajan nativo (ATLAS_KARAJAN_RESOURCES o <datos nativos>/resources.db)'],
      pasos: [
        'Abre resources.db en solo lectura; sin el fichero, la biblioteca figura como no disponible (biblioteca.ts · constructor)',
        'fichaDe: busca por slug, nombre o «…--nombre», prefiriendo la skill sobre la capacidad (biblioteca.ts · fichaDe)',
        'Marca las estrellas como heredadas si la skill es hija de una colección (biblioteca.ts · ficha)',
        'buscar: FTS5 por relevancia y, si no hay, LIKE sobre nombre y resumen (biblioteca.ts · buscar)',
      ],
      salidas: ['FichaRecurso: nombre, tipo, descripción, estrellas (y si son heredadas), repo, grupo y capacidades'],
    },
    reglas: ['Nunca escribe: la refrescan la ingesta y el refresco del Karajan nativo.', 'Las estrellas heredadas no dicen nada de la skill en concreto.'],
    configuracion: (c) => ({ disponible: c.biblioteca.disponible, fichero: c.biblioteca.ruta ?? 'sin resources.db' }),
  },
  modo: {
    especificado: true,
    resumen: 'Bloquea cualquier cambio de configuración sin una tarea aceptada de Atlas dev: en producción responde 423 y deja el cambio pedido como borrador.',
    como_funciona: {
      entradas: ['Petición de mutación (cabecera x-karajan-tarea o cuerpo.tarea)', '<datos>/modo.json', 'Estado de esa tarea en Atlas dev'],
      pasos: [
        'Lee el modo de modo.json; sin fichero o ilegible, producción (modo.ts · leerModo)',
        'En desarrollo deja pasar (modo.ts · Guardian.exigir)',
        'En producción busca el id de tarea en la cabecera o en el cuerpo (modo.ts · tareaDe)',
        'Si la tarea está encolada o ejecutando, deja pasar; si no, abre un borrador con la petición y responde 423 (modo.ts · exigir)',
      ],
      salidas: ['Paso libre con la tarea que lo autoriza, o error 423 con el borrador abierto'],
    },
    reglas: ['El modo NO se cambia por API: solo editando modo.json.', 'Clasificar, planificar, delegar, el feedback y el laboratorio siguen libres.'],
    configuracion: (c) => ({ modo: c.modo, fichero: join(c.dirDatos, 'modo.json'), tareas_que_autorizan: [...ESTADOS_ACEPTADA] }),
  },
  pasarela: {
    especificado: true,
    resumen: 'Convierte los hallazgos medios y altos en tareas BORRADOR de Atlas dev, sin duplicar lo ya abierto ni reabrir lo que la persona descartó.',
    como_funciona: {
      entradas: ['Hallazgo (clave, severidad, título, evidencia, propuesta, criterios) de un laboratorio o del guardián de modo', 'borradores.json'],
      pasos: [
        'Los hallazgos baja se quedan en el informe (pasarela-borradores.ts · proponer)',
        'Busca la clave «<componente>:<clave>» en borradores.json (pasarela-borradores.ts · proponer)',
        'Si la tarea sigue en borrador y cambió, la actualiza; si no cambió, no hace nada (pasarela-borradores.ts · proponer)',
        'Si fue descartada no la reabre; si ya se aceptó no la toca; si no existe, crea un borrador nuevo (pasarela-borradores.ts · proponer)',
        'El borrador lleva Evidencia, Propuesta, Criterios y «Origen: karajan:<componente>:<clave>» (pasarela-borradores.ts · especificacion)',
      ],
      salidas: ['Tarea borrador en la cola de Atlas dev', 'Registro clave → tarea en borradores.json'],
    },
    reglas: ['Es la única salida de Karajan en producción para proponer un cambio.', 'Idempotente por clave.'],
    configuracion: (c) => ({ severidades_con_borrador: ['alta', 'media'], borradores_registrados: Object.keys(c.pasarela.leer()).length, registro: join(c.dirLab, 'borradores.json') }),
  },
  laboratorio: {
    especificado: true,
    resumen: 'Es el motor que ejecuta los laboratorios de cada componente sobre tareas anonimizadas, guarda sus resultados en laboratorio.db y propone los hallazgos por la pasarela.',
    como_funciona: {
      entradas: ['Laboratorio del componente (escenarios contrato, replay o feedback)', 'Tareas de Atlas dev anonimizadas (hash con sal local; el prompt solo en memoria)', 'Calibraciones humanas (sí/no de «Preparando»)'],
      pasos: [
        'Anonimiza las tareas: hash con sal local, sin título, repo ni hoja, y sin las propuestas del propio Karajan (laboratorio.ts · anonimizar)',
        'Ejecuta cada escenario midiendo el tiempo y capturando el error (laboratorio.ts · ejecutarLaboratorio)',
        'Guarda muestra, suficiencia, métricas, hallazgos y detalle en lab_ejecuciones (laboratorio.ts · RegistroLab.guardar)',
        'Propone por la pasarela los hallazgos alta y media (laboratorio.ts · ejecutarLaboratorio)',
      ],
      salidas: ['Informe por escenario', 'Historial en laboratorio.db', 'Borradores en Atlas dev'],
    },
    reglas: ['No muta producción: los escenarios reciben el contexto en solo lectura.', 'Con muestra insuficiente da métricas pero no saca hallazgos.', 'Los resultados van a laboratorio.db, separada de task_logs.db.'],
    configuracion: (c) => ({ base_de_datos: join(c.dirLab, 'laboratorio.db'), proponer_por_defecto: true }),
  },

  // ── Ejecución ──
  proveedores: {
    especificado: true,
    resumen: 'Lanza el CLI del agente elegido (Claude Code, Codex o Qwen por Ollama) con el modelo que corresponde al nivel y devuelve su salida, el error y la latencia.',
    como_funciona: {
      entradas: ['Proveedor y modelo elegidos por el delegador', 'Instrucción (prompt + subtarea + skills preparadas)', 'Carpeta de trabajo y tiempo máximo'],
      pasos: [
        'Comprueba la disponibilidad: el binario en el PATH y, para Qwen, que Ollama responda y tenga el modelo (proveedores.ts · disponibilidad)',
        'Traduce el nivel lógico al modelo del proveedor (proveedores.ts · modeloPara)',
        'Lanza el CLI con sus argumentos y la instrucción, con tiempo máximo (proveedores.ts · ejecutarProveedor)',
        'Si falla, resume el motivo (proveedores.ts · motivoFallo)',
      ],
      salidas: ['Salida del agente, error si lo hubo, latencia y modelo usado'],
    },
    reglas: ['Qwen no admite skills.', 'Los proveedores solo se ejecutan desde la delegación real, nunca desde el laboratorio.'],
    configuracion: () => ({
      proveedores: PROVEEDORES.map((p) => `${p.nombre} (${p.binario}${p.gratis ? ', gratis' : ''})`),
      binarios_en_path: PROVEEDORES.filter((p) => buscarBinario(p.binario) !== null).map((p) => p.nombre),
      modelos: PROVEEDORES.map((p) => `${p.nombre}: ${[...new Set(Object.values(p.modelos))].join(', ')}`),
    }),
  },
  limites: {
    especificado: true,
    resumen: 'Dice si Claude ha pasado su umbral de uso semanal; si es así, el delegador manda lo suyo a Codex.',
    como_funciona: {
      entradas: ['limites-plan.json (lo escribe Atlas dev leyendo las CLIs)', 'KARAJAN_LIMITE_CLAUDE (50 % por defecto)'],
      pasos: [
        'Lee el fichero y descarta el dato si tiene más de dos horas (limites.ts · leerLimites)',
        'Compara el % semanal de Claude con el umbral (limites.ts · claudeExcedido)',
      ],
      salidas: ['El % semanal si supera el umbral, o null'],
    },
    reglas: ['Sin dato reciente no se limita nada.'],
    configuracion: (c) => {
      const l = c.limites();
      return { umbral_claude_semanal: umbralClaude(), edad_maxima_horas: 2, fichero: rutaLimites(), dato_reciente: l !== null, ...(l?.claude?.semanal !== undefined && l.claude.semanal !== null ? { claude_semanal: l.claude.semanal } : {}) };
    },
  },
  aislamiento: {
    especificado: true,
    resumen: 'Hace trabajar cada tarea en su propio worktree y rama agente/<id>; main solo cambia con la integración nocturna.',
    como_funciona: {
      entradas: ['Carpeta de trabajo de la tarea', 'Id de la tarea', 'KARAJAN_AISLAR_GIT=1'],
      pasos: [
        'Localiza el repo y excluye /.trabajo/ de su seguimiento (aislar-git.ts · aislar)',
        'Crea <repo>/.trabajo/<id> con la rama agente/<id> desde origin/main (o HEAD sin remoto) (aislar-git.ts · aislar)',
        'El agente trabaja ahí; al acabar se commitea con los trailers Equipo y Karajan-Tarea y se sube la rama (aislar-git.ts · cerrar)',
        'Se quita el worktree y la rama se queda (aislar-git.ts · cerrar)',
      ],
      salidas: ['Rama agente/<id> con el trabajo', 'Decisiones git:* en el registro'],
    },
    reglas: ['main no se toca nunca.', 'Fuera de un repo git no aísla nada.'],
    configuracion: () => ({ activo: aislarActivo(), equipo: equipo(), rama: 'agente/<id de la tarea>', carpeta: '<repo>/.trabajo/<id>' }),
  },

  // ── Observación ──
  analitica: {
    especificado: true,
    resumen: 'Cuenta las skills recomendadas, preparadas y usadas, sin deducir un uso de una recomendación.',
    como_funciona: {
      entradas: ['Tareas y runs del registro', 'Skills revisadas por la persona', 'Catálogo de skills conocidas', 'Ventana en días (30 por defecto)'],
      pasos: [
        'Por tarea reúne las skills recomendadas por la clasificación o por una subtarea (analitica.ts · construirAnaliticaSkills)',
        'Separa las preparadas y las usadas confirmadas en la ejecución, con las revisadas a mano mandando (analitica.ts · construirAnaliticaSkills)',
        'Agrega por skill: ejecuciones, éxitos, fallos, latencia, coste, agentes y última vez (analitica.ts · construirAnaliticaSkills)',
      ],
      salidas: ['Analítica por skill servida en /analytics/skills'],
    },
    reglas: ['Recomendada no es usada: solo cuenta como uso lo confirmado.', 'Port fiel de skill_analytics.py (tests/paridad.test.ts).'],
    configuracion: () => ({ dias_por_defecto: 30 }),
  },
  produccion: {
    especificado: true,
    resumen: 'Mide cómo va Karajan en producción: acierto, re-trabajo, flujo, eficiencia por agente, matriz de skills y la lista de «qué mejorar».',
    como_funciona: {
      entradas: ['Tareas aplanadas del registro (runs, decisiones, revisiones)', 'Catálogo de skills', 'Perfil por defecto (para filtrar agentes)'],
      pasos: [
        'Acierto por tarea = media ponderada de re-trabajo, completada, validación y revisión (produccion.ts · calcularAcierto)',
        'Re-trabajo: una tarea posterior en 24 h cita el prompt, vuelve sobre los mismos ficheros o pide corregir lo mismo (produccion.ts · motivoRetrabajo)',
        'Calcula flujo, eficiencia por agente y matriz de skills (produccion.ts · flujo, eficiencia, matrizSkills)',
        'Genera sugerencias y la salud del registro: agentes que fallan, revisiones pendientes, agentes sin niveles… (produccion.ts · sugerencias, salud)',
      ],
      salidas: ['KPI (tareas, acierto, re-trabajo), flujo, eficiencia, matriz y sugerencias en /analytics/*'],
    },
    reglas: ['Port de produccion.py con paridad comprobada contra salidas grabadas.', 'El re-trabajo mira el siguiente prompt aunque sea de otro agente o fuera del periodo.'],
    configuracion: () => ({ peso_retrabajo: PESOS_ACIERTO['retrabajo']!, peso_completada: PESOS_ACIERTO['completada']!, peso_validacion: PESOS_ACIERTO['validacion']!, peso_revision: PESOS_ACIERTO['revision']!, ventana_retrabajo_horas: VENTANA_MS / 3_600_000, dias_por_defecto: 0 }),
  },

  // ── Interfaz ──
  api: {
    especificado: true,
    resumen: 'Expone Karajan a Atlas dev: las rutas del paquete, con las formas de respuesta de la API de Karajan, más las del laboratorio y esta arquitectura.',
    como_funciona: {
      entradas: ['Peticiones de Atlas dev reenviadas desde /paquetes/karajan/api/* (sin ese prefijo)'],
      pasos: [
        'registrar() abre el registro, los perfiles, el rotador, el delegador y el laboratorio con la carpeta de datos (servidor.ts · registrar)',
        'Lecturas: /health, /metrics, /tasks, /analytics/*, /skills/rotacion, /providers, /laboratorio/* (servidor.ts)',
        'Mutaciones de configuración pasan por el guardián de modo (servidor.ts · guardian.exigir)',
        '/laboratorio/ejecutar mide y propone; /delegate-task ejecuta de verdad (servidor.ts)',
      ],
      salidas: ['JSON con las formas de la API de Karajan'],
    },
    reglas: ['Lo que no está portado responde 501.', 'Las lecturas no escriben.'],
    configuracion: (c) => ({ version: c.version, prefijo: '/paquetes/karajan/api', modo: c.modo }),
  },
  cli: {
    especificado: true,
    resumen: 'Maneja Karajan desde la terminal (kj): componentes, laboratorios, gráficas de texto, propuestas y modo.',
    como_funciona: {
      entradas: ['Argumentos de kj', 'KARAJAN_API o ATLAS_DEV_API, y ATLAS_DEV_TOKEN'],
      pasos: ['Pide a la API del paquete lo que corresponde al comando (cli.ts · pedir)', 'Pinta tablas, barras y sparklines, o el JSON tal cual con --json (cli.ts · ejecutar)'],
      salidas: ['Texto en terminal o JSON'],
    },
    reglas: ['Sin dependencias.'],
    configuracion: () => ({ api: process.env['KARAJAN_API'] ?? `${(process.env['ATLAS_DEV_API'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '')}/paquetes/karajan/api` }),
  },

  // ── Modificadores (aún sin código) ──
  curador: {
    especificado: true,
    resumen: 'Propone qué skills del equipo sobran con cuatro reglas inequívocas y evidencia comprobable. Solo propone: no borra, no mueve ni desinstala; cada propuesta sale como borrador de Atlas dev.',
    como_funciona: {
      entradas: ['Skills del equipo (instaladas y almacén, con su descripción)', 'Fichas de la biblioteca (estrellas, si son heredadas, grupo)', 'Último uso (rotador, skills-uso.json de Atlas dev, ejecuciones y revisiones) y recomendaciones del selector en el registro', 'Skills protegidas del rotador'],
      pasos: [
        'Descarta las protegidas y comprueba que el registro abarca la ventana de días sin uso (curador.ts · curar)',
        'sin-uso-ni-recomendacion: ni usada ni recomendada en la ventana, con registro suficiente → retirar (curador.ts · curar)',
        'duplicada: instalada y también en el almacén del mismo destino → revisar (curador.ts · curar)',
        'sin-descripcion: SKILL.md sin description → revisar (curador.ts · curar)',
        'superada-por-grupo: estrellas PROPIAS bajo el mínimo y otra instalada del mismo grupo, usada y con ≥ 10× estrellas propias → retirar (curador.ts · curar)',
        'Cada propuesta se convierte en un hallazgo con clave <regla>:<skill>, idempotente en la pasarela (curador.ts · aHallazgo, servidor.ts · /laboratorio/curador/proponer)',
      ],
      salidas: ['Propuestas {skill, regla, evidencia, accion}', 'Borradores en Atlas dev al pedirlo (POST /laboratorio/curador/proponer, kj curador --proponer)'],
    },
    reglas: ['Las protegidas del rotador (incluidas las del router) nunca se proponen.', 'Las estrellas heredadas de una colección nunca cuentan como evidencia.', 'Determinista: la misma entrada da las mismas propuestas.', 'Solo propone: retirar es del rotador y en producción todo cambio va como borrador.'],
    configuracion: () => ({ dias_sin_uso: UMBRALES_CURADOR.diasSinUso, estrellas_minimas: UMBRALES_CURADOR.estrellasMinimas, factor_estrellas: UMBRALES_CURADOR.factorEstrellas }),
  },
  comparador: borrador('Componente comparador', 'Comparará cada skill (y Karajan) con las mejores de su grupo de la taxonomía y señalará las funcionalidades que faltan.', ['Fichas y taxonomía de la biblioteca'], ['Informe comparativo por grupo']),
  eficiencia: {
    especificado: true,
    resumen: 'Modificador ponytail (mínimo código suficiente): añade a la instrucción que se delega un bloque con el criterio de la solución mínima y segura. Desactivado en producción y aún sin conectar al delegador.',
    como_funciona: {
      entradas: ['Instrucción que se delega', 'Modo (producción | desarrollo)', 'Nivel e intención de la tarea (del clasificador)'],
      pasos: [
        'Decide si aplica: solo en desarrollo, niveles 1 a 3 y intención de implementar o corregir (eficiencia.ts · aplica)',
        'Si no aplica, o la instrucción ya lleva la marca, la devuelve intacta (eficiencia.ts · aplicar)',
        'Si aplica, añade al final la marca y el bloque de eficiencia, sin tocar el texto original (eficiencia.ts · aplicar)',
        'El laboratorio comprueba el contrato y compara tareas con y sin ponytail en su hoja (lab/eficiencia.lab.ts · laboratorioModificador en ab.ts)',
      ],
      salidas: ['Instrucción modificada (en desarrollo) o la misma (en producción)'],
    },
    reglas: [
      'En producción devuelve la instrucción intacta; no está conectado a delegar.ts. El enlace eficiencia → delegador sigue «previsto» hasta que un borrador lo conecte solo en desarrollo.',
      'Idempotente, conserva el texto original y añade como máximo el sobrecoste acotado.',
      'El A/B es observacional, no aleatorizado: solo concluye con ambos brazos ≥ 20 tareas y los IC95 de Wilson sin solaparse; un hallazgo propone activar o retirar como borrador, nunca lo aplica.',
    ],
    configuracion: (c) => ({ activo: c.modo === 'desarrollo', skills_brazo_a: SKILLS_EFICIENCIA, sobrecoste_max_caracteres: MAX_SOBRECOSTE_EFICIENCIA, niveles: 'N1–N3', muestra_minima_por_brazo: UMBRALES_AB.muestraMinima }),
  },
  metodo: {
    especificado: true,
    resumen: 'Modificador de método (superpowers): añade a la instrucción un bloque de plan, TDD, ejecución en la rama o worktree de la tarea y verificación. Desactivado en producción y aún sin conectar al delegador.',
    como_funciona: {
      entradas: ['Instrucción que se delega', 'Modo (producción | desarrollo)', 'Nivel e intención de la tarea (del clasificador)'],
      pasos: [
        'Decide si aplica: solo en desarrollo, niveles 3 a 5 y intención de implementar o corregir (metodo.ts · aplica)',
        'Si no aplica, o la instrucción ya lleva la marca, la devuelve intacta (metodo.ts · aplicar)',
        'Si aplica, añade al final la marca y el bloque de método, sin tocar el texto original (metodo.ts · aplicar)',
        'El laboratorio comprueba el contrato y compara tareas con y sin las skills de superpowers en su hoja (lab/metodo.lab.ts · laboratorioModificador en ab.ts)',
      ],
      salidas: ['Instrucción modificada (en desarrollo) o la misma (en producción)'],
    },
    reglas: [
      'En producción devuelve la instrucción intacta; no está conectado a delegar.ts. El enlace metodo → delegador sigue «previsto» hasta que un borrador lo conecte solo en desarrollo.',
      'Idempotente, conserva el texto original y añade como máximo el sobrecoste acotado.',
      'El A/B es observacional, no aleatorizado: solo concluye con ambos brazos ≥ 20 tareas y los IC95 de Wilson sin solaparse; un hallazgo propone activar o retirar como borrador, nunca lo aplica.',
    ],
    configuracion: (c) => ({ activo: c.modo === 'desarrollo', skills_brazo_a: SKILLS_METODO, sobrecoste_max_caracteres: MAX_SOBRECOSTE_METODO, niveles: 'N3–N5', muestra_minima_por_brazo: UMBRALES_AB.muestraMinima }),
  },
  prompts: {
    especificado: true,
    resumen: 'Modificador de prompts (karpathy-skills, dspy, promptfoo): añade a la instrucción criterios de éxito comprobables y la petición de explicitar suposiciones. Desactivado en producción y aún sin conectar al delegador.',
    como_funciona: {
      entradas: ['Instrucción que se delega', 'Modo (producción | desarrollo)', 'Nivel de la tarea (del clasificador)'],
      pasos: [
        'Decide si aplica: solo en desarrollo y a partir del nivel 2 (prompts.ts · aplica)',
        'Si no aplica, o la instrucción ya lleva la marca, la devuelve intacta (prompts.ts · aplicar)',
        'Si aplica, añade al final la marca y el bloque de criterios, sin tocar el texto original (prompts.ts · aplicar)',
        'El laboratorio comprueba el contrato y compara tareas con y sin karpathy-skills, dspy o promptfoo en su hoja (lab/prompts.lab.ts · laboratorioModificador en ab.ts)',
      ],
      salidas: ['Instrucción modificada (en desarrollo) o la misma (en producción)'],
    },
    reglas: [
      'En producción devuelve la instrucción intacta; no está conectado a delegar.ts. El enlace prompts → delegador sigue «previsto» hasta que un borrador lo conecte solo en desarrollo.',
      'Idempotente, conserva el texto original y añade como máximo el sobrecoste acotado.',
      'El A/B es observacional, no aleatorizado: solo concluye con ambos brazos ≥ 20 tareas y los IC95 de Wilson sin solaparse; un hallazgo propone activar o retirar como borrador, nunca lo aplica.',
    ],
    configuracion: (c) => ({ activo: c.modo === 'desarrollo', skills_brazo_a: SKILLS_PROMPTS, sobrecoste_max_caracteres: MAX_SOBRECOSTE_PROMPTS, niveles: 'N2–N5', muestra_minima_por_brazo: UMBRALES_AB.muestraMinima }),
  },
};

export const ficha = (id: string): FichaComponente | null => FICHAS[id] ?? null;
