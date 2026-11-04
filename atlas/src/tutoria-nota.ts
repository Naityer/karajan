import { proporcion, wilson } from './laboratorio';

/**
 * Lo puro de la tutoría: la regla que impide que el tutor dé la solución, la nota de un examen y el mapa de qué se le puede
 * delegar al alumno. Sin disco, sin red y sin agentes: todo lo que decide una nota está aquí, a la vista y comprobable.
 */
export const UMBRALES_TUTORIA = {
  /** Intervenciones del tutor por examen; con más, el examen se da por no superado sin él. */
  maxAyudas: 3,
  /** Lo que resta de la nota cada intervención (multiplicativo: 3 ayudas dejan el 70 %). */
  penalizacionAyuda: 0.1,
  pesoVeredicto: 0.7,
  pesoSolape: 0.3,
  /** Un examen cuenta como aprobado desde esta nota. */
  aprobado: 70,
  /** Un segmento (dominio × nivel, o un nivel) se puede delegar con al menos esta muestra y este IC95 inferior de aprobación. */
  muestraSegmento: 5,
  aprobacionInferior: 0.5,
  /** Una pista más larga que esto no es una pista. */
  maxPista: 600,
  /** Líneas añadidas de la referencia con al menos esta longitud no pueden aparecer en una pista. */
  minLineaProtegida: 15,
  /** Una skill forjada (SkillForge) es útil en tareas reales con al menos `muestraSegmento` pares con y sin ella, esta ganancia media en puntos… */
  mejoraForjada: 5,
  /** …y como mucho esta fracción de pares en los que empeora. */
  maxEmpeoranForjada: 0.2,
};

export interface Veredicto { cumple: number; equivalencia: number; regresiones: boolean; motivo: string }

const sinEspacios = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Las líneas que añade un diff (sin la cabecera `+++`), recortadas. */
export const lineasAnadidas = (diff: string): string[] => diff.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim());
/** Rutas que toca un diff (`diff --git a/x b/x`). */
export const ficherosDeDiff = (diff: string): string[] => [...new Set([...diff.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)].map((m) => m[1]!))];

/**
 * ¿Es una pista aceptable? El tutor nunca ve la referencia (así que no puede copiarla), pero puede acertar o recitar algo igual:
 * por si acaso, una pista con código, demasiado larga o que contenga una línea que la solución añade se rechaza.
 */
export function filtrarPista(pista: string, referenciaDiff: string): { ok: boolean; motivo: string | null } {
  if (!pista.trim()) return { ok: false, motivo: 'vacía' };
  if (pista.length > UMBRALES_TUTORIA.maxPista) return { ok: false, motivo: `más de ${UMBRALES_TUTORIA.maxPista} caracteres` };
  if (pista.includes('```')) return { ok: false, motivo: 'lleva un bloque de código' };
  const texto = sinEspacios(pista);
  const copiada = lineasAnadidas(referenciaDiff).find((l) => l.length >= UMBRALES_TUTORIA.minLineaProtegida && /[A-Za-z]/.test(l) && texto.includes(sinEspacios(l)));
  return copiada ? { ok: false, motivo: 'contiene una línea de la solución' } : { ok: true, motivo: null };
}

/** Fracción de los ficheros de la referencia que el alumno tocó o, si solo contestó con texto, que nombró en su respuesta. */
export function solape(ficherosReferencia: string[], ficherosAlumno: string[], salida: string): number {
  if (!ficherosReferencia.length) return 0;
  const tocados = new Set(ficherosAlumno.map((f) => f.toLowerCase()));
  const texto = salida.toLowerCase().replace(/\\/g, '/');
  return ficherosReferencia.filter((f) => tocados.has(f.toLowerCase()) || texto.includes(f.toLowerCase())).length / ficherosReferencia.length;
}

/** 0–100 a partir del veredicto del tutor (que sí vio la referencia), el solape y las ayudas. Sin trabajo del alumno es 0. */
export function calificar(x: { veredicto: Veredicto; solape: number; ayudas: number; hizoAlgo: boolean }): number {
  const U = UMBRALES_TUTORIA;
  if (!x.hizoAlgo) return 0;
  const clamp = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
  let v = (clamp(x.veredicto.cumple) + clamp(x.veredicto.equivalencia)) / 2;
  if (x.veredicto.regresiones) v = Math.min(v, 50);
  const base = U.pesoVeredicto * v + U.pesoSolape * clamp(x.solape * 100);
  return Math.round(base * Math.max(0, 1 - U.penalizacionAyuda * x.ayudas));
}

/** El primer objeto JSON de un texto (los modelos lo rodean de prosa o de ```json). */
export function extraerJson<T = Record<string, unknown>>(texto: string): T | null {
  const ini = texto.indexOf('{');
  for (let fin = texto.lastIndexOf('}'); fin > ini && ini >= 0; fin = texto.lastIndexOf('}', fin - 1)) {
    try { return JSON.parse(texto.slice(ini, fin + 1)) as T; } catch { /* un `}` anterior */ }
  }
  return null;
}

/** Un examen sin nada que identifique a la tarea (el id es un hash con la sal local). */
export interface ExamenAnonimo {
  tarea: string; dominio: string; nivel: number; alumno: string; tutor: string;
  nota: number | null; ayudas: number; ayudasRechazadas: number; ms: number; fecha: string; motivo: string;
  /** Qué tipo de obstáculo tuvo el alumno (para que el informe diga dónde se atasca). */
  obstaculos: string[];
  /** Skills de SkillForge (`id@vN`) que llevaba el alumno en este examen; ausente si iba sin ellas (la nota del alumno solo cuenta esos). */
  forjadas?: string[];
}

export interface Segmento { clave: string; n: number; media: number; aprobados: number; autonomos: number; aprobacion: number | null; aprobacionInferior: number | null; delegable: boolean }

export function agrupar(examenes: ExamenAnonimo[], clave: (e: ExamenAnonimo) => string): Segmento[] {
  const U = UMBRALES_TUTORIA;
  const grupos = new Map<string, ExamenAnonimo[]>();
  for (const e of examenes.filter((x) => x.nota !== null)) grupos.set(clave(e), [...(grupos.get(clave(e)) ?? []), e]);
  return [...grupos].map(([k, es]) => {
    const aprobados = es.filter((e) => e.nota! >= U.aprobado).length;
    const [lo] = wilson(aprobados, es.length);
    return {
      clave: k, n: es.length, media: Math.round(es.reduce((s, e) => s + e.nota!, 0) / es.length), aprobados, autonomos: es.filter((e) => e.ayudas === 0 && e.nota! >= U.aprobado).length,
      aprobacion: proporcion(aprobados, es.length), aprobacionInferior: Math.round(lo * 1000) / 1000, delegable: es.length >= U.muestraSegmento && lo >= U.aprobacionInferior,
    };
  }).sort((a, b) => a.clave.localeCompare(b.clave));
}

export interface Calificacion {
  /** Nota porcentual global del alumno (media de los exámenes calificados); null sin ninguno. */
  nota: number | null; examenes: number; sinCalificar: number; aprobados: number;
  porNivel: Segmento[]; porDominioNivel: Segmento[];
  /** El nivel más alto N tal que N1…N están todos delegables; 0 si ni el N1 lo es todavía. */
  nivelMaximoDelegable: number;
}

export function calificacion(todos: ExamenAnonimo[]): Calificacion {
  // El alumno se califica «desnudo»: un examen con skills forjadas mide la skill, no al alumno.
  const examenes = todos.filter((e) => !e.forjadas?.length);
  const buenos = examenes.filter((e) => e.nota !== null);
  const porNivel = agrupar(examenes, (e) => `N${e.nivel}`);
  let maximo = 0;
  for (let n = 1; n <= 5; n++) { if (porNivel.find((s) => s.clave === `N${n}`)?.delegable) maximo = n; else break; }
  return {
    nota: buenos.length ? Math.round(buenos.reduce((s, e) => s + e.nota!, 0) / buenos.length) : null, examenes: examenes.length, sinCalificar: examenes.length - buenos.length,
    aprobados: buenos.filter((e) => e.nota! >= UMBRALES_TUTORIA.aprobado).length, porNivel, porDominioNivel: agrupar(examenes, (e) => `${e.dominio}·N${e.nivel}`), nivelMaximoDelegable: maximo,
  };
}
