import type { Eje, Valor } from './tipos';

/**
 * Taxonomía de etiquetas del análisis (versionada). Cada eje tiene términos canónicos con su definición y sus alias; todo lo que
 * entre —de la hoja de Atlas dev, del `complexity_level` de Karajan o de un modelo— pasa por `normalizar`, que devuelve el
 * canónico, `ambiguo` (término genérico que no decide) o `desconocido` (no está), conservando siempre el original.
 * Subir `TAXONOMIA_VERSION` al cambiar términos o alias; los análisis guardan con qué versión se hicieron.
 */
export const TAXONOMIA_VERSION = 1;

export interface Termino { id: string; definicion: string; alias: string[] }
export interface EjeTaxonomia { eje: Eje; descripcion: string; terminos: Termino[]; /** Palabras genéricas que no deciden nada: se marcan ambiguas, no se adivinan. */ ambiguos: string[] }

export const TAXONOMIA: EjeTaxonomia[] = [
  {
    eje: 'nivel', descripcion: 'Complejidad de la tarea (escala única; equivale a complexity_score 0-5 de Karajan agrupado).',
    terminos: [
      { id: 'trivial', definicion: 'Cambio mecánico de minutos, sin riesgo.', alias: ['trivial', 'muy-simple', 'very-simple', 'level-0', 'level-1', '0', '1'] },
      { id: 'simple', definicion: 'Acotada a un sitio, criterios claros.', alias: ['simple', 'easy', 'baja', 'low', 'facil', 'sencilla', 'level-2', '2'] },
      { id: 'moderada', definicion: 'Varios ficheros o decisiones locales.', alias: ['moderada', 'moderate', 'media', 'medium', 'normal', 'level-3', '3'] },
      { id: 'compleja', definicion: 'Cruza capas o repos; diseño no trivial.', alias: ['compleja', 'complex', 'alta', 'high', 'dificil', 'hard', 'level-4', '4'] },
      { id: 'critica', definicion: 'Alto riesgo o impacto (datos, seguridad, producción).', alias: ['critica', 'critical', 'muy-alta', 'very-high', 'level-5', '5'] },
    ],
    ambiguos: ['otro', 'otros', 'general', 'varios', 'variable', 'n/a', 'na', 'sin-definir', 'unknown', 'desconocido', ''],
  },
  {
    eje: 'dominio', descripcion: 'Área técnica principal del trabajo.',
    terminos: [
      { id: 'frontend', definicion: 'Interfaz de usuario, componentes, estilos, UX en código.', alias: ['frontend', 'front-end', 'ui', 'interfaz', 'interfaces', 'web', 'react', 'css', 'componentes'] },
      { id: 'backend', definicion: 'Servidor, API, lógica de negocio, workers.', alias: ['backend', 'back-end', 'api', 'servidor', 'server', 'endpoint', 'endpoints', 'servicio', 'servicios'] },
      { id: 'datos', definicion: 'Bases de datos, esquemas, persistencia, análisis de datos.', alias: ['datos', 'data', 'database', 'bd', 'base-de-datos', 'sql', 'sqlite', 'persistencia', 'analitica'] },
      { id: 'infra', definicion: 'Despliegue, CI/CD, contenedores, entorno, scripts de sistema.', alias: ['infra', 'infraestructura', 'devops', 'deploy', 'despliegue', 'docker', 'ci', 'cd', 'ops', 'entorno'] },
      { id: 'qa', definicion: 'Pruebas, calidad, verificación.', alias: ['qa', 'testing', 'test', 'tests', 'pruebas', 'calidad', 'e2e'] },
      { id: 'diseno', definicion: 'Diseño visual, producto, experiencia (sin código).', alias: ['diseno', 'diseño', 'design', 'ux', 'producto', 'grafico', 'grafica'] },
      { id: 'docs', definicion: 'Documentación y redacción.', alias: ['docs', 'documentacion', 'documentación', 'documentation', 'redaccion', 'redacción', 'escritura'] },
      { id: 'seguridad', definicion: 'Seguridad, permisos, secretos, auditoría.', alias: ['seguridad', 'security', 'secops', 'auth', 'permisos'] },
      { id: 'planificacion', definicion: 'Planificación, coordinación, gestión de tareas y agentes.', alias: ['planificacion', 'planificación', 'planning', 'planificador', 'coordinacion', 'gestion', 'orquestacion'] },
      { id: 'ia', definicion: 'Modelos, prompts, agentes, evaluación de LLM.', alias: ['ia', 'ai', 'llm', 'ml', 'prompts', 'agentes', 'agents', 'modelos'] },
    ],
    // «programming» y «general» describen cualquier tarea de código: no son un dominio.
    ambiguos: ['programming', 'programacion', 'programación', 'coding', 'codigo', 'código', 'desarrollo', 'development', 'software', 'general', 'otro', 'otros', 'varios', 'misc', 'unknown', 'desconocido', ''],
  },
  {
    eje: 'tipo', descripcion: 'Naturaleza del trabajo.',
    terminos: [
      { id: 'bug', definicion: 'Corregir un fallo o regresión.', alias: ['bug', 'bugs', 'fix', 'bugfix', 'error', 'fallo', 'incidencia', 'defecto', 'regresion'] },
      { id: 'feature', definicion: 'Funcionalidad nueva.', alias: ['feature', 'funcionalidad', 'nueva-funcionalidad', 'implementacion', 'implementar'] },
      { id: 'mejora', definicion: 'Mejora de algo existente sin ser un fallo.', alias: ['mejora', 'mejoras', 'improvement', 'enhancement', 'optimizacion', 'optimización'] },
      { id: 'refactor', definicion: 'Reestructurar sin cambiar el comportamiento.', alias: ['refactor', 'refactorizacion', 'refactorización', 'cleanup', 'limpieza'] },
      { id: 'investigacion', definicion: 'Explorar, analizar o decidir; el entregable es conocimiento.', alias: ['investigacion', 'investigación', 'research', 'analisis', 'análisis', 'exploracion', 'estudio', 'diseno-tecnico'] },
      { id: 'mantenimiento', definicion: 'Tareas rutinarias: dependencias, configuración, limpieza de repos.', alias: ['mantenimiento', 'chore', 'maintenance', 'dependencias', 'rutina'] },
      { id: 'prueba', definicion: 'Escribir o ejecutar pruebas como fin de la tarea.', alias: ['prueba', 'test-only', 'verificacion', 'verificación', 'validacion-tecnica'] },
    ],
    ambiguos: ['tarea', 'task', 'otro', 'otros', 'general', 'varios', 'misc', 'unknown', 'desconocido', ''],
  },
];

const clave = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[\s_]+/g, '-');

/** `level_2_moderate` → `moderate` y `level-2`: la escala de Karajan trae el número y el nombre; vale cualquiera de los dos. */
function candidatos(valor: string): string[] {
  const k = clave(valor);
  const m = /^level-(\d)(?:-(.+))?$/.exec(k);
  return m ? [...(m[2] ? [m[2]] : []), `level-${m[1]}`, k] : [k];
}

const indices = new Map<Eje, { alias: Map<string, string>; ambiguos: Set<string> }>(TAXONOMIA.map((e) => [e.eje, {
  alias: new Map(e.terminos.flatMap((t) => [clave(t.id), ...t.alias.map(clave)].map((a) => [a, t.id] as const))),
  ambiguos: new Set(e.ambiguos.map(clave)),
}]));

export const terminosDe = (eje: Eje): string[] => TAXONOMIA.find((e) => e.eje === eje)!.terminos.map((t) => t.id);

/** Normaliza un valor de un eje. Vacío, ausente o no-texto → `desconocido`; genérico → `ambiguo`; con alias → el canónico. */
export function normalizar(eje: Eje, entrada: unknown): Valor {
  if (typeof entrada !== 'string' && typeof entrada !== 'number') return { valor: null, estado: 'desconocido', original: null };
  const original = String(entrada).trim().slice(0, 120);
  const { alias, ambiguos } = indices.get(eje)!;
  for (const c of candidatos(original)) { const t = alias.get(c); if (t) return { valor: t, estado: 'canonico', original: t === original ? null : original }; }
  if (!original) return { valor: null, estado: 'desconocido', original: null };
  if (candidatos(original).some((c) => ambiguos.has(c))) return { valor: null, estado: 'ambiguo', original };
  return { valor: null, estado: 'desconocido', original };
}

/** Texto de la taxonomía para el prompt del modelo: los únicos valores que puede devolver. */
export function vocabularioParaPrompt(): string {
  return TAXONOMIA.map((e) => `- ${e.eje}: ${e.terminos.map((t) => `${t.id} (${t.definicion})`).join('; ')}`).join('\n');
}
