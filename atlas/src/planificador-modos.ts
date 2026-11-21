/**
 * Modos de ejecución del planificador y sus reglas de combinación (ver planificador.ts y docs/laboratorio/componentes.md).
 *
 * Un plan tiene UN modo base —`classic`, `single-agent`, `master-slave`, `co-work` o `auto`— y cualquier número de modificadores
 * compatibles —`lazy-agent`, `milestone`, `checker`—. Esto hace que los modos sean combinables sin multiplicar los casos:
 * «master-slave + milestone + checker» es un plan válido; «classic + subagentes» no lo es y se explica por qué.
 *
 * Los modelos no se fijan aquí: un actor lleva un `nivel` (superior | medio | bajo) y una lista de `preferencia` de modelos; quien
 * ejecuta (Atlas dev) la resuelve contra los modelos que de verdad ofrece cada agente en ese momento.
 */
export type ModoBase = 'classic' | 'single-agent' | 'master-slave' | 'co-work' | 'auto';
export type Modificador = 'lazy-agent' | 'milestone' | 'checker';
export type NivelModelo = 'superior' | 'medio' | 'bajo';
export type Esfuerzo = 'bajo' | 'medio' | 'alto';

export const MODOS_BASE: ModoBase[] = ['classic', 'single-agent', 'master-slave', 'co-work', 'auto'];
export const MODIFICADORES: Modificador[] = ['lazy-agent', 'milestone', 'checker'];
export const NIVELES: NivelModelo[] = ['superior', 'medio', 'bajo'];

/** Un agente con su modelo (por nivel) dentro de un plan. `modelo` solo va relleno si se pidió uno concreto; si no, `preferencia` manda. */
export interface Actor { id: string; agente: string; nivel: NivelModelo; modelo: string | null; preferencia: string[]; esfuerzo: Esfuerzo; ambito?: string }
/** Lo que el usuario puede dar para un subagente o el checker: todo opcional salvo el agente, el resto se completa. */
export interface PeticionActor { agente?: string; nivel?: NivelModelo; modelo?: string | null; esfuerzo?: Esfuerzo; ambito?: string }

export interface DescripcionModo { id: string; tipo: 'base' | 'modificador'; resumen: string; actores: string; compatibleCon: string[]; incompatibleCon: { con: string; motivo: string }[] }

export const DESCRIPCION_MODOS: DescripcionModo[] = [
  { id: 'classic', tipo: 'base', resumen: 'Un único agente ejecuta la tarea completa.', actores: '1 agente, sin subagentes', compatibleCon: ['milestone', 'checker', 'lazy-agent'], incompatibleCon: [] },
  { id: 'single-agent', tipo: 'base', resumen: 'Un hilo principal; recurre como mucho a un subagente de bajo coste y poco esfuerzo para algo complementario y sencillo.', actores: '1 agente + hasta 1 subagente barato', compatibleCon: ['milestone', 'checker', 'lazy-agent'], incompatibleCon: [] },
  { id: 'master-slave', tipo: 'base', resumen: 'Un agente principal (modelo superior) reparte y valida; los subagentes, de la misma familia si es posible, hacen las partes.', actores: '1 principal + 1..N subagentes', compatibleCon: ['milestone', 'checker', 'lazy-agent'], incompatibleCon: [] },
  { id: 'co-work', tipo: 'base', resumen: 'Varios modelos especializados por ámbito colaboran en un repositorio común; un agente frontera interviene puntualmente (5 min) para resolver conflictos o redirigir.', actores: 'el principal y 1..N especialistas más + 1 jefe frontera puntual', compatibleCon: ['milestone', 'checker'], incompatibleCon: [{ con: 'lazy-agent', motivo: 'co-work necesita modelos fuertes por ámbito; lazy-agent los sustituiría por agentes baratos' }] },
  { id: 'auto', tipo: 'base', resumen: 'Analiza la tarea, crea siempre un plan con el agente elegido y elige el formato (classic, single-agent, master-slave o co-work) según coste, tiempo y las métricas disponibles.', actores: 'lo decide el plan', compatibleCon: ['milestone', 'checker', 'lazy-agent'], incompatibleCon: [] },
  { id: 'lazy-agent', tipo: 'modificador', resumen: 'Prioriza agentes de bajo coste; combinado con milestone o un plan troceado, reparte en tareas pequeñas.', actores: 'agentes de nivel bajo', compatibleCon: ['classic', 'single-agent', 'master-slave', 'auto', 'milestone', 'checker'], incompatibleCon: [{ con: 'co-work', motivo: 'co-work necesita modelos fuertes por ámbito' }] },
  { id: 'milestone', tipo: 'modificador', resumen: 'Divide la tarea en hitos secuenciales con objetivo, entregable y criterio de validación; cada hito se comprueba antes de seguir y entre hitos se compacta, recapitula y sintetiza.', actores: 'lo del modo base, hito a hito', compatibleCon: ['classic', 'single-agent', 'master-slave', 'co-work', 'auto', 'lazy-agent', 'checker'], incompatibleCon: [] },
  { id: 'checker', tipo: 'modificador', resumen: 'Un revisor ligero, al final, busca errores, bugs y trabajo pendiente; sus hallazgos quedan en la ejecución.', actores: '1 agente ligero al final', compatibleCon: ['classic', 'single-agent', 'master-slave', 'co-work', 'auto', 'lazy-agent', 'milestone'], incompatibleCon: [] },
];

export interface SolicitudModo { modo?: string; modificadores?: string[]; principal?: PeticionActor; subagentes?: PeticionActor[]; checker?: PeticionActor | boolean }
export interface Validacion { ok: boolean; errores: string[]; avisos: string[]; modo: ModoBase; modificadores: Modificador[] }

const unicos = <T,>(xs: T[]) => [...new Set(xs)];

/** Normaliza modo y modificadores y explica lo que no se puede combinar. Nunca lanza: con errores, `ok` es false. */
export function validarCombinacion(s: SolicitudModo | null | undefined): Validacion {
  const errores: string[] = [], avisos: string[] = [];
  const pedido = typeof s?.modo === 'string' && s.modo ? s.modo : 'classic';
  let modo: ModoBase = 'classic';
  // Se acepta un modificador puesto como modo («lazy-agent», «milestone»): el modo base pasa a classic y el modificador se añade.
  const mods: string[] = [...(Array.isArray(s?.modificadores) ? s!.modificadores! : [])];
  if ((MODOS_BASE as string[]).includes(pedido)) modo = pedido as ModoBase;
  else if ((MODIFICADORES as string[]).includes(pedido)) { mods.push(pedido); avisos.push(`«${pedido}» es un modificador: se combina con el modo base classic.`); }
  else errores.push(`modo «${pedido}» desconocido; usa ${MODOS_BASE.join(' | ')}`);
  const modificadores: Modificador[] = [];
  for (const m of unicos(mods)) {
    if ((MODIFICADORES as string[]).includes(m)) modificadores.push(m as Modificador);
    else errores.push(`modificador «${m}» desconocido; usa ${MODIFICADORES.join(' | ')}`);
  }
  if (s?.checker && !modificadores.includes('checker')) modificadores.push('checker');
  const subs = Array.isArray(s?.subagentes) ? s!.subagentes! : [];
  if (modo === 'classic' && subs.length) errores.push('classic usa un único agente: quita los subagentes o elige single-agent, master-slave o co-work.');
  if (modo === 'single-agent' && subs.length > 1) errores.push('single-agent admite como mucho un subagente (minimiza instancias): usa master-slave para varios.');
  if (modo === 'co-work' && modificadores.includes('lazy-agent')) errores.push('co-work no se combina con lazy-agent: necesita modelos fuertes por ámbito.');
  if (modo === 'auto' && subs.length) avisos.push('En auto los subagentes solo se usan si el plan acaba eligiendo master-slave o co-work.');
  if (modo === 'master-slave' && !subs.length) avisos.push('master-slave sin subagentes: se sugerirá uno de la misma familia que el principal.');
  if (modificadores.includes('lazy-agent') && modo === 'master-slave') avisos.push('lazy-agent con master-slave: el principal conserva el modelo superior; los subagentes serán de nivel bajo.');
  return { ok: !errores.length, errores, avisos, modo, modificadores };
}

/** Familia de un agente: su propio id (claude, codex, gemini…). Los modelos de una familia se mezclan mejor entre sí. */
export const familiaDe = (agente: string) => agente.toLowerCase().replace(/-(cli|agy)$/, '').replace(/^ollama-/, '');
