import type { FichaRecurso } from './biblioteca';
import type { Hallazgo } from './pasarela-borradores';

/**
 * Curador de la biblioteca: propone qué skills del equipo sobran, con reglas inequívocas y evidencia que se puede comprobar. Es una
 * función pura (sin disco, sin red, sin reloj): con la misma entrada da siempre las mismas propuestas. SOLO propone: retirar es
 * del rotador y, en producción, todo cambio sale como borrador de Atlas dev (ver `aHallazgo`). Las protegidas del rotador (entre
 * ellas las del router) nunca se proponen, y las estrellas heredadas de una colección no cuentan como evidencia.
 */
export type ReglaCurador = 'sin-uso-ni-recomendacion' | 'duplicada' | 'sin-descripcion' | 'superada-por-grupo';
export type AccionCurador = 'retirar' | 'revisar';
export interface Propuesta { skill: string; regla: ReglaCurador; evidencia: string; accion: AccionCurador }

export const UMBRALES_CURADOR = { diasSinUso: 90, estrellasMinimas: 100, factorEstrellas: 10 };
export type UmbralesCurador = typeof UMBRALES_CURADOR;

/** Las reglas, en el orden en que salen las propuestas, con su acción y el umbral que las dispara. */
export const REGLAS_CURADOR: { id: ReglaCurador; accion: AccionCurador; umbral: (u: UmbralesCurador) => string; descripcion: string }[] = [
  { id: 'sin-uso-ni-recomendacion', accion: 'retirar', umbral: (u) => `${u.diasSinUso} días sin uso ni recomendación, con registro de al menos ${u.diasSinUso} días`, descripcion: 'Ni usada ni recomendada en la ventana, y el registro abarca la ventana entera' },
  { id: 'duplicada', accion: 'revisar', umbral: () => 'instalada y en el almacén del mismo destino', descripcion: 'La misma skill está instalada y guardada en el almacén de un mismo destino' },
  { id: 'sin-descripcion', accion: 'revisar', umbral: () => 'description vacía en SKILL.md', descripcion: 'SKILL.md sin `description:`: el selector no puede elegirla por el prompt' },
  { id: 'superada-por-grupo', accion: 'retirar', umbral: (u) => `estrellas propias < ${u.estrellasMinimas} y otra del grupo usada con ≥ ${u.factorEstrellas}× estrellas propias`, descripcion: 'Poco usada y con pocas estrellas propias frente a otra instalada de su grupo que sí se usa' },
];

export interface SkillCurador { name: string; description: string; instaladaEn: string[]; enAlmacen: string[] }
export interface EntradaCurador {
  /** Instante de referencia (ms): el curador no lee el reloj. */
  ahora: number;
  skills: SkillCurador[];
  /** Ficha de la biblioteca por nombre de skill (null o ausente: sin ficha). */
  fichas: Record<string, FichaRecurso | null | undefined>;
  /** Último uso (ISO) y nº de usos registrados por skill. */
  usos: Record<string, { ultimo: string | null; n: number }>;
  /** Última vez que el selector la recomendó (ISO) y cuántas veces, por skill. */
  recomendadas: Record<string, { ultima: string | null; n: number }>;
  /** Fecha (ISO) del registro más antiguo: sin registro de al menos la ventana no se concluye nada de «no usada». */
  registroDesde: string | null;
  /** Skills que nunca se proponen (las del router y las del rotador). */
  protegidas: string[];
  umbrales?: Partial<UmbralesCurador>;
}

const DIA = 86_400_000;
const dia = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : 'nunca');

export function curar(e: EntradaCurador): Propuesta[] {
  const u = { ...UMBRALES_CURADOR, ...e.umbrales };
  const limite = e.ahora - u.diasSinUso * DIA;
  const protegidas = new Set(e.protegidas);
  const registroSuficiente = e.registroDesde !== null && Date.parse(e.registroDesde) <= limite;
  const diasRegistro = e.registroDesde === null ? 0 : Math.floor((e.ahora - Date.parse(e.registroDesde)) / DIA);
  const reciente = (iso: string | null | undefined) => !!iso && Date.parse(iso) > limite;
  const uso = (n: string) => e.usos[n] ?? { ultimo: null, n: 0 };
  const rec = (n: string) => e.recomendadas[n] ?? { ultima: null, n: 0 };
  const activa = (n: string) => reciente(uso(n).ultimo) || reciente(rec(n).ultima);
  const propias = (f: FichaRecurso | null | undefined): f is FichaRecurso & { estrellas: number } => !!f && !f.heredadas && f.estrellas !== null;
  const skills = [...e.skills].sort((a, b) => a.name.localeCompare(b.name));
  const propuestas: Propuesta[] = [];

  for (const s of skills) {
    if (protegidas.has(s.name)) continue;
    if (registroSuficiente && !activa(s.name)) {
      propuestas.push({ skill: s.name, regla: 'sin-uso-ni-recomendacion', accion: 'retirar', evidencia: `Último uso: ${dia(uso(s.name).ultimo)} (${uso(s.name).n} usos registrados); última recomendación: ${dia(rec(s.name).ultima)} (${rec(s.name).n}). El registro empieza el ${dia(e.registroDesde)} (${diasRegistro} días ≥ ${u.diasSinUso}).` });
    }
    const repetidos = s.instaladaEn.filter((d) => s.enAlmacen.includes(d));
    if (repetidos.length) propuestas.push({ skill: s.name, regla: 'duplicada', accion: 'revisar', evidencia: `Instalada y también en el almacén de: ${repetidos.join(', ')}.` });
    if (!s.description.trim()) propuestas.push({ skill: s.name, regla: 'sin-descripcion', accion: 'revisar', evidencia: 'Su SKILL.md no tiene `description:` o está vacía.' });
    const f = e.fichas[s.name];
    if (registroSuficiente && propias(f) && f.grupo && f.estrellas < u.estrellasMinimas && !activa(s.name)) {
      const rival = skills
        .filter((r) => r.name !== s.name && r.instaladaEn.length && activa(r.name))
        .map((r) => ({ r, g: e.fichas[r.name] }))
        .filter((x): x is { r: SkillCurador; g: FichaRecurso & { estrellas: number } } => propias(x.g) && x.g.grupo === f.grupo && x.g.estrellas >= u.factorEstrellas * Math.max(f.estrellas, 1))
        .sort((a, b) => b.g.estrellas - a.g.estrellas || a.r.name.localeCompare(b.r.name))[0];
      if (rival) propuestas.push({ skill: s.name, regla: 'superada-por-grupo', accion: 'retirar', evidencia: `Grupo «${f.grupo}»: ${s.name} tiene ${f.estrellas} estrellas propias (< ${u.estrellasMinimas}) y no se usa desde ${dia(uso(s.name).ultimo)}; ${rival.r.name} tiene ${rival.g.estrellas} propias (≥ ${u.factorEstrellas}×) y se usó el ${dia(uso(rival.r.name).ultimo)}.` });
    }
  }
  const orden = new Map(REGLAS_CURADOR.map((r, i) => [r.id, i]));
  return propuestas.sort((a, b) => orden.get(a.regla)! - orden.get(b.regla)! || a.skill.localeCompare(b.skill));
}

/** La propuesta como hallazgo para la pasarela: la clave `<regla>:<skill>` hace idempotente el borrador (`curador:<regla>:<skill>`). */
export function aHallazgo(p: Propuesta): Hallazgo {
  const regla = REGLAS_CURADOR.find((r) => r.id === p.regla)!;
  return {
    clave: `${p.regla}:${p.skill}`, severidad: 'media', titulo: `${p.accion === 'retirar' ? 'Retirar' : 'Revisar'} la skill «${p.skill}» (${p.regla})`,
    evidencia: `${p.evidencia}\nRegla \`${p.regla}\`: ${regla.descripcion}.`,
    propuesta: p.accion === 'retirar'
      ? `Mover «${p.skill}» al almacén (reversible; lo hace el rotador al aplicar su plan) o descartar este borrador si la skill debe quedarse.`
      : `Revisar «${p.skill}» y corregir lo señalado, o descartar este borrador si es intencionado.`,
    criterios: ['Revisa la evidencia antes de cambiar nada: el curador solo propone, no borra ni mueve.', `Tras el cambio, \`kj curador\` ya no propone «${p.skill}» por \`${p.regla}\`.`],
  };
}
