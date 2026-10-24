/** Contrato de `GET {api}/laboratorio/arquitectura` (servidor del paquete, `atlas/src/`). La UI no importa nada del servidor. */
export type Estado = 'ok' | 'hallazgos' | 'sin_ejecutar' | 'pendiente' | 'error';
export type Severidad = 'alta' | 'media' | 'baja';
export type TipoEscenario = 'contrato' | 'replay' | 'feedback';

export interface Familia { id: string; nombre: string; orden: number; componentes: string[] }
export interface Escenario { id: string; tipo: TipoEscenario; descripcion: string; umbrales: Record<string, string> }
export interface UltimaEjecucion {
  escenario: string; inicio: string; muestra: number; suficiente: boolean; hallazgos: number; error: string | null;
  metricas: Record<string, number | null>; ms: number;
}
export interface PuntoHistorial { inicio: string; valor: number | null; suficiente: boolean; escenario: string }
export interface Hallazgo { clave: string; severidad: Severidad; titulo: string; evidencia: string; propuesta: string; borrador?: string }
export interface Operacion {
  tareas: number | null; runs: number | null; latencia_p50_ms: number | null; coste_total_usd: number | null; tokens: number | null; ultima_actividad: string | null;
  /** Contadores propios del componente (p. ej. asignaciones, respaldos). */
  extra?: Record<string, number | string | null> | null;
}
export interface Ficha {
  resumen: string;
  como_funciona: { entradas: string[]; pasos: string[]; salidas: string[] };
  reglas?: string[];
}
export interface Componente {
  id: string; familia: string; responsabilidad: string; modulos: string[]; estado: Estado; pendiente: string | null;
  ficha: Ficha;
  configuracion: Record<string, unknown>;
  escenarios: Escenario[];
  ultimas: UltimaEjecucion[];
  historial: Record<string, PuntoHistorial[]>;
  detalle: Record<string, unknown>;  // por escenario; null si no hay detalle
  hallazgos: Hallazgo[];
  operacion: Operacion | null;
  muestra_corta?: boolean;
  avisos?: string[];
}
export interface Enlace { de: string; a: string; etiqueta?: string }
export interface Arquitectura {
  version: string; modo: 'produccion' | 'desarrollo'; generado: string;
  familias: Familia[]; componentes: Componente[]; enlaces: Enlace[];
}

/** Lo que muestra cada estado: etiqueta corta y texto largo para lectores de pantalla. */
export const ESTADOS: { id: Estado; corto: string; largo: string }[] = [
  { id: 'ok', corto: 'Bien', largo: 'laboratorio sin hallazgos' },
  { id: 'hallazgos', corto: 'Hallazgos', largo: 'con hallazgos abiertos' },
  { id: 'sin_ejecutar', corto: 'Sin ejecutar', largo: 'laboratorio sin ejecutar todavía' },
  { id: 'pendiente', corto: 'Pendiente', largo: 'sin laboratorio, pendiente de un borrador' },
  { id: 'error', corto: 'Error', largo: 'el laboratorio falló' },
];
export const nombreEstado = (e: Estado) => ESTADOS.find((x) => x.id === e)?.corto ?? e;
