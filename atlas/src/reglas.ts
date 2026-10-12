/**
 * Reglas por dominio de un perfil de enrutado: qué entidad ejecuta una subtarea según su dominio, intención y nivel.
 * Espejo de `app/routing_rules.py` (mismas palabras clave y mismo orden de evaluación): el clasificador da dominios gruesos
 * (`programming`, `data`, `documents`…) y aquí se añaden tres «áreas» detectadas en el propio prompt —`frontend` (interfaces y
 * diseño), `backend` (APIs, servidores, datos) y `oficina` (informes, correo, hojas de cálculo)— sin tocar la clasificación.
 */
export interface Regla { id: string; name?: string; entity_id: string; domains?: string[]; intents?: string[]; level_min?: number | null; level_max?: number | null; enabled?: boolean }
export interface Entidad { id: string; name?: string | null; role: string; provider?: string | null; levels?: string[]; skills?: string[]; max_concurrent?: number; [k: string]: unknown }
export interface Perfil { id: string; name: string; entities: Entidad[]; rules?: Regla[]; [k: string]: unknown }

export const AREAS: Record<string, string[]> = {
  frontend: [
    'interfaz', 'interfaces', 'ui', 'ux', 'diseño', 'diseña', 'diseñar', 'design', 'frontend', 'front-end',
    'componente', 'componentes', 'component', 'css', 'tailwind', 'react', 'vue', 'svelte', 'html',
    'dashboard', 'maquetación', 'maqueta', 'layout', 'pantalla', 'vista', 'estilo', 'estilos', 'animación',
    'landing', 'responsive', 'widget', 'widgets', 'figma',
  ],
  backend: [
    'backend', 'back-end', 'api', 'apis', 'endpoint', 'endpoints', 'servidor', 'server', 'base de datos',
    'database', 'sql', 'postgres', 'sqlite', 'migración', 'migration', 'worker', 'cola', 'queue', 'auth',
    'autenticación', 'microservicio', 'fastapi', 'fastify', 'express', 'rest', 'graphql', 'cron',
  ],
  oficina: [
    'informe', 'informes', 'reporte', 'reportes', 'report', 'correo', 'correos', 'email', 'excel', 'hoja de cálculo',
    'spreadsheet', 'presentación', 'powerpoint', 'pptx', 'docx', 'word', 'acta', 'minuta', 'resumen ejecutivo',
    'memo', 'carta', 'factura', 'presupuesto', 'calendario', 'agenda',
  ],
};

const escapar = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Igual que `re.search(r"(?<!\w)term(?!\w)")` de Python con Unicode: \w incluye letras con tilde. */
const contiene = (texto: string, termino: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapar(termino)}(?![\\p{L}\\p{N}_])`, 'u').test(texto);

export function detectarAreas(prompt: string): string[] {
  const texto = prompt.toLowerCase();
  return Object.entries(AREAS).filter(([, palabras]) => palabras.some((p) => contiene(texto, p))).map(([area]) => area);
}

export function casaRegla(r: Regla, dominios: Set<string>, intencion: string, nivel: number): boolean {
  if (r.enabled === false) return false;
  if (r.domains?.length && !r.domains.some((d) => dominios.has(d))) return false;
  if (r.intents?.length && !r.intents.includes(intencion)) return false;
  if (r.level_min !== undefined && r.level_min !== null && nivel < r.level_min) return false;
  if (r.level_max !== undefined && r.level_max !== null && nivel > r.level_max) return false;
  return true;
}

/** La primera regla activa que casa y cuya entidad existe; `null` si ninguna (entonces manda el enrutado por niveles). */
export function elegirRegla(perfil: Pick<Perfil, 'entities' | 'rules'>, entrada: { dominios: string[]; intencion: string; nivel: number; prompt?: string }): { regla: Regla; entidad: Entidad } | null {
  const reglas = perfil.rules ?? [];
  if (!reglas.length) return null;
  const porId = new Map(perfil.entities.map((e) => [e.id, e]));
  const conjunto = new Set([...entrada.dominios, ...detectarAreas(entrada.prompt ?? '')]);
  for (const regla of reglas) {
    const entidad = porId.get(regla.entity_id);
    if (entidad && casaRegla(regla, conjunto, entrada.intencion, entrada.nivel)) return { regla, entidad };
  }
  return null;
}

const NIVEL: Record<string, number> = { level_1_simple: 1, level_2_moderate: 2, level_3_intermediate: 3, level_4_complex: 4, level_5_critical: 5 };
/** El nivel que ve una regla: el de la tarea o el de la subtarea si es mayor (como `rule_level` en Python). */
export const nivelRegla = (nivelTarea: string, complejidadSubtarea: number) => Math.max(NIVEL[nivelTarea] ?? 1, complejidadSubtarea);

export const ID_PRESET_DOMINIO = 'por-dominio';
export const NOMBRE_PRESET_DOMINIO = 'Claude · Codex · Qwen (por dominio)';

/** Claude para interfaces complejas, Codex para backend/oficina y el resto, Qwen local para lo sencillo (igual que en Python). */
export function presetDominio(id = ID_PRESET_DOMINIO): Perfil {
  const claude = 'dominio-claude', codex = 'dominio-codex', qwen = 'dominio-qwen';
  return {
    id, name: NOMBRE_PRESET_DOMINIO,
    entities: [
      { id: qwen, name: 'Qwen (local)', role: 'worker', role_tags: ['worker'], provider: 'ollama-qwen', tier: 1, levels: ['level_1_simple', 'level_2_moderate'], max_concurrent: 1, x: 120, y: 430 },
      { id: codex, name: 'Codex', role: 'worker', role_tags: ['worker'], provider: 'codex', tier: 1, levels: ['level_1_simple', 'level_2_moderate', 'level_3_intermediate', 'level_4_complex'], max_concurrent: 2, x: 480, y: 430 },
      { id: claude, name: 'Claude Code', role: 'worker', role_tags: ['worker'], provider: 'claude-cli', tier: 1, levels: ['level_3_intermediate', 'level_4_complex', 'level_5_critical'], max_concurrent: 1, x: 840, y: 430 },
    ],
    groups: [],
    rules: [
      { id: 'interfaces-complejas', name: 'Interfaces y diseño complejos → Claude', entity_id: claude, domains: ['frontend'], level_min: 2 },
      { id: 'backend-oficina', name: 'Backend, oficina e informes → Codex', entity_id: codex, domains: ['backend', 'oficina', 'data', 'devops', 'documents'] },
      { id: 'sencillas-local', name: 'Tareas sencillas → Qwen local', entity_id: qwen, level_max: 2 },
      { id: 'resto', name: 'Todo lo demás → Codex', entity_id: codex },
    ],
  };
}
