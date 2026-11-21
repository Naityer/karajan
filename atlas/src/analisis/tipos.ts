/**
 * Modelo de datos del análisis de tareas (hsr2). Una `AnalisisTarea` separa lo OBSERVADO (leído tal cual del registro o la cola:
 * estado, métricas, agente, validación) de lo INFERIDO (etiquetas que salen de reglas o de un modelo, con su confianza y su
 * procedencia). Un dato que no se puede obtener es `null` o `desconocido`: nunca se rellena con una suposición.
 */
export const VERSION_ANALISIS = 1;
export const ESQUEMA_FICHERO = 1;

export type Eje = 'nivel' | 'dominio' | 'tipo';
export const EJES: Eje[] = ['nivel', 'dominio', 'tipo'];

/** `canonico`: término de la taxonomía; `desconocido`: nada que normalizar o fuera de taxonomía; `ambiguo`: término genérico o con varios sentidos. */
export type EstadoValor = 'canonico' | 'desconocido' | 'ambiguo';
export interface Valor { valor: string | null; estado: EstadoValor; /** Lo que venía, sin tocar, cuando no se pudo normalizar o cuando era un alias. */ original: string | null }

export type FuenteEtiqueta = 'regla' | 'modelo';
export interface Etiqueta { eje: Eje; valor: string | null; estado: EstadoValor; original: string | null; fuente: FuenteEtiqueta; /** Solo si la fuente la da (el modelo); las reglas son deterministas. */ confianza: number | null; razon: string }

export type Resultado = 'validada' | 'completada_sin_validar' | 'fallida' | 'descartada' | 'abierta' | 'desconocido';

export interface Observado {
  id: string; titulo: string;
  /** Estado de la tarea en la cola cuando se leyó. */
  estado: string | null; tipo_cola: string | null; resultado: Resultado;
  /** `true` validada por la persona, `false` rechazada, `null` sin dato. */
  validada: boolean | null;
  agente: string | null; modelo: string | null;
  /** Perfil de Karajan que decidió. La cola de Atlas dev no lo guarda: casi siempre `null`. */
  perfil: string | null;
  duracion_activa_ms: number | null; vueltas: number | null;
  tokens: { in: number; out: number; cache: number } | null;
  /** Suma de las vueltas con coste; `null` si ninguna lo trae (Codex no lo informa). */
  coste_usd: number | null;
  correcciones: { total: number; redirecciones: number } | null;
  eventos: number | null;
  /** Clasificación que ya traía la hoja de la tarea, sin normalizar. */
  clasificacion_origen: Record<string, string[]> | null;
  origen: 'registro' | 'cola';
}

export interface Procedencia {
  version_analisis: number; taxonomia_version: number;
  /** `reglas` si no hizo falta modelo; si no, el proveedor y modelo que respondieron. */
  proveedor: string; modelo: string | null;
  prompt_hash: string | null;
  /** Huella del contenido de origen: si cambia (p. ej. se valida la tarea) el análisis se rehace. */
  huella_origen: string;
  fecha: string;
}

export interface AnalisisTarea { observado: Observado; inferido: { etiquetas: Etiqueta[]; notas: string | null }; procedencia: Procedencia }

export type EstadoProceso = 'ok' | 'pendiente' | 'fallido';
export interface Proceso { estado: EstadoProceso; intentos: number; error: string | null; ultimo_intento: string | null; version_objetivo: number }

/** Contenido de `analisis.json`, junto a `tarea.json` de la tarea en el registro. */
export interface FicheroAnalisis { esquema: number; tarea_id: string; proceso: Proceso; actual: AnalisisTarea | null; historial: AnalisisTarea[] }

/** Lo que el analizador necesita de una tarea, venga del registro o de la cola. */
export interface EntradaTarea {
  id: string; titulo: string; prompt: string; informe: string;
  estado: string | null; tipo_cola: string | null;
  hoja: Record<string, unknown> | null; metricas: unknown; cabecera: unknown;
  correcciones: { tipo?: string }[]; eventos: number | null;
  origen: 'registro' | 'cola';
}
