import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TareaAtlas } from '../atlas-dev';
import type { Hallazgo } from '../pasarela-borradores';
import type { Ejecutor, Proveedor } from '../proveedores';
import { proporcion, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';
import { buscarReferencia, examinar, type Agente, type PuertosExamen } from '../tutoria';
import { aplicables, brechas, efectoForjadas, esBase, etiquetaForjada, claveConjunto, type SkillForjada } from '../skillforge';
import { calificacion, calificar, filtrarPista, UMBRALES_TUTORIA, type ExamenAnonimo, type Veredicto } from '../tutoria-nota';

/**
 * Laboratorio de la tutoría. Dos preguntas:
 *   contrato  ¿el examen es limpio? El filtro frena las pistas que son la solución, la nota es monótona con las ayudas, el
 *             tutor que desbloquea no ve la referencia, y el sandbox no deja worktrees, ramas ni cambios en el repo
 *             (todo con agentes de mentira en un repo temporal).
 *   examen    replay REAL: tareas ya integradas, con su commit como referencia, que el alumno local rehace con la misma
 *             instrucción. Cuesta tokens del tutor y tiempo de máquina, así que solo corre con `KARAJAN_TUTORIA_EXAMENES=1`
 *             y con un máximo de tareas por ejecución; `kj lab run todos` no lo dispara por sorpresa.
 */
export interface ContextoTutoria extends ContextoLab {
  /** Las tareas de la cola con su id real: solo en memoria, nunca se persiste (se guarda el hash). */
  tareasReales(): Promise<TareaAtlas[]>;
  hash(id: string): string;
  repos(): string[];
  /** Alumno y tutor de ahora mismo, o por qué no hay. */
  alumno(): { agente: Agente } | { motivo: string };
  tutor(): { agente: Agente } | { motivo: string };
  puertos(): PuertosExamen;
  /** Exámenes ya hechos (lo guardado en ejecuciones anteriores). */
  previos(): ExamenAnonimo[];
  /** Skills de SkillForge activas, validadas con modelos reales y compatibles con el alumno (vacío si no hay laboratorio). */
  forjadas(): SkillForjada[];
  autorizado(): boolean;
  maxPorEjecucion(): number;
}

const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return { ok: r.status === 0, salida: (r.stdout ?? '').trim() }; };
const falso = (nombre: string): Proveedor => ({ nombre, etiqueta: nombre, binario: nombre, gratis: true, modelos: {}, args: () => [], login: '' });
const LINEA_SECRETA = 'export const clave = calcularValorMuyEspecifico(entrada);';

/** Un repo temporal con una tarea «integrada» (commit con trailer) y agentes de mentira para recorrer el examen entero. */
async function contratoExamen(): Promise<{ fallos: string[]; casos: number }> {
  const fallos: string[] = [];
  let casos = 0;
  const comprobar = (ok: boolean, que: string) => { casos++; if (!ok) fallos.push(que); };
  const veredicto: Veredicto = { cumple: 100, equivalencia: 100, regresiones: false, motivo: 'ok' };

  comprobar(!filtrarPista('Prueba así:\n```ts\nfoo()\n```', '').ok, 'una pista con código pasa el filtro');
  comprobar(!filtrarPista(`Añade ${LINEA_SECRETA} al fichero`, `+${LINEA_SECRETA}`).ok, 'una pista con una línea de la solución pasa el filtro');
  comprobar(!filtrarPista('x'.repeat(UMBRALES_TUTORIA.maxPista + 1), '').ok, 'una pista larguísima pasa el filtro');
  comprobar(filtrarPista('Lee primero el error completo y comprueba desde qué carpeta lanzas el comando.', `+${LINEA_SECRETA}`).ok, 'el filtro rechaza una pista legítima');
  comprobar(calificar({ veredicto, solape: 1, ayudas: 0, hizoAlgo: false }) === 0, 'sin trabajo la nota no es 0');
  const notas = [0, 1, 2, 3].map((ayudas) => calificar({ veredicto, solape: 1, ayudas, hizoAlgo: true }));
  comprobar(notas.every((n, i) => n >= 0 && n <= 100 && (i === 0 || n < notas[i - 1]!)), `la nota no baja con cada ayuda (${notas.join(', ')})`);

  const dir = mkdtempSync(join(tmpdir(), 'kj-tutoria-contrato-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'lab@karajan.local'); git(dir, 'config', 'user.name', 'lab');
    writeFileSync(join(dir, 'a.txt'), 'uno\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'b.ts'), `${LINEA_SECRETA}\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'tarea', '-m', 'Karajan-Tarea: labcontrato');
    const antes = git(dir, 'rev-parse', 'HEAD').salida;
    const ref = buscarReferencia([dir], 'labcontrato');
    comprobar(!!ref && ref.ficheros.join() === 'b.ts' && ref.diff.includes(LINEA_SECRETA), 'no encuentra la referencia por el trailer');
    comprobar(buscarReferencia([dir], 'noexiste') === null, 'inventa una referencia que no existe');
    if (ref) {
      const prompts: { tutor: boolean; texto: string }[] = [];
      let turnosAlumno = 0;
      const ejecutor = (modoAlumno: 'normal' | 'nada', modoTutor: 'normal' | 'roto'): Ejecutor => async (p, modelo, instruccion, { cwd }) => {
        if (p.nombre === 'alumno-falso') {
          turnosAlumno++;
          if (modoAlumno === 'nada') return { salida: '', error: 'terminó con código 1', latenciaMs: 1, modelo };
          if (turnosAlumno === 1) return { salida: '', error: 'EACCES: permission denied', latenciaMs: 1, modelo };
          writeFileSync(join(cwd, 'b.ts'), 'export const otra = 1;\n');
          return { salida: 'hecho', error: null, latenciaMs: 1, modelo };
        }
        prompts.push({ tutor: instruccion.includes('desbloquearlo'), texto: instruccion });
        if (instruccion.includes('desbloquearlo')) return { salida: '{"accion":"pista","texto":"Mira bajo qué usuario corre el comando y qué dice el error."}', error: null, latenciaMs: 1, modelo };
        return { salida: modoTutor === 'roto' ? 'no sé' : JSON.stringify(veredicto), error: null, latenciaMs: 1, modelo };
      };
      const puertos = (e: Ejecutor): PuertosExamen => ({ ejecutor: e, planificar: () => ({ dominio: 'general', nivel: 1, subtareas: [{ nombre: 'hacerlo', validacion: 'que funcione', skills: [] }] }), instaladas: () => new Set(), textoSkill: () => null });
      const alumno: Agente = { proveedor: falso('alumno-falso'), modelo: 'm' }, tutor: Agente = { proveedor: falso('tutor-falso'), modelo: 't' };
      const r = await examinar({ hash: 'h1', prompt: 'haz algo', referencia: ref, alumno, tutor }, puertos(ejecutor('normal', 'normal')));
      comprobar(r.examen.nota !== null && r.examen.nota > 0 && r.examen.ayudas === 1 && r.examen.obstaculos.join() === 'permisos', `el examen no recorre alumno → tutor → alumno → veredicto (${JSON.stringify(r.examen)})`);
      comprobar(prompts.filter((p) => p.tutor).length === 1 && prompts.filter((p) => p.tutor).every((p) => !p.texto.includes('calcularValorMuyEspecifico')), 'el tutor que desbloquea ha visto la referencia');
      comprobar(prompts.some((p) => !p.tutor && p.texto.includes('calcularValorMuyEspecifico')), 'el evaluador no recibe la referencia');
      turnosAlumno = 0;
      const nada = await examinar({ hash: 'h2', prompt: 'haz algo', referencia: ref, alumno, tutor }, puertos(ejecutor('nada', 'normal')));
      comprobar(nada.examen.nota === 0, 'un alumno que no produce nada no saca 0');
      turnosAlumno = 1;
      const roto = await examinar({ hash: 'h3', prompt: 'haz algo', referencia: ref, alumno, tutor }, puertos(ejecutor('normal', 'roto')));
      comprobar(roto.examen.nota === null, 'sin veredicto del tutor la nota debe quedar sin calificar, no en 0');
      comprobar(git(dir, 'worktree', 'list').salida.split('\n').length === 1, 'el sandbox deja un worktree registrado');
      comprobar(git(dir, 'branch', '--format=%(refname:short)').salida === 'main' && git(dir, 'rev-parse', 'HEAD').salida === antes && git(dir, 'status', '--porcelain').salida === '', 'el examen deja ramas, commits o cambios en el repo');
    }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lo borra el sistema */ } }
  return { fallos, casos };
}

const sinExamenes = (motivo: string, metricas: Resultado['metricas'] = {}): Resultado => ({ muestra: 0, suficiente: false, metricas: { autorizado: 0, ...metricas }, hallazgos: [], detalle: { motivo } });

export const laboratorioTutoria: Laboratorio<ContextoTutoria> = {
  escenarios: [
    {
      id: 'contrato', tipo: 'contrato', descripcion: 'Filtro de pistas, nota monótona, tutor sin ver la referencia y sandbox sin huella (con agentes de mentira)',
      ejecutar: async (): Promise<Resultado> => {
        const { fallos, casos } = await contratoExamen();
        const hallazgos: Hallazgo[] = fallos.length ? [{
          clave: 'examen-roto', severidad: 'alta', titulo: 'El examen de la tutoría no cumple su contrato',
          evidencia: fallos.slice(0, 10).join('; '), propuesta: 'Corregir `atlas/src/tutoria.ts` o `tutoria-nota.ts`: el tutor que desbloquea no puede ver la referencia, el filtro debe frenar la solución y el sandbox no puede dejar rastro.',
          criterios: ['Cada comprobación del contrato pasa', 'Tras el cambio, `kj lab run tutoria` ya no da este hallazgo'],
        }] : [];
        return {
          muestra: casos, suficiente: true, hallazgos, metricas: { comprobaciones: casos, fallos: fallos.length },
          umbrales: { fallos: '= 0', tutor_sin_referencia: 'el prompt de desbloqueo no contiene el diff de referencia', sandbox: 'sin worktrees, ramas ni commits nuevos' },
        };
      },
    },
    {
      id: 'examen', tipo: 'replay', descripcion: 'Rehace tareas ya integradas con el alumno local y un tutor, y las compara con el commit registrado como correcto',
      ejecutar: async (ctx): Promise<Resultado> => {
        const U = UMBRALES_TUTORIA;
        const previos = ctx.previos();
        const resumen = (examenes: ExamenAnonimo[]) => calificacion(examenes);
        const metricasDe = (c: ReturnType<typeof calificacion>): Resultado['metricas'] => ({ autorizado: 1, examenes: c.examenes, sin_calificar: c.sinCalificar, nota: c.nota, aprobados: c.aprobados, nivel_maximo_delegable: c.nivelMaximoDelegable });
        const umbrales = { aprobado: `nota ≥ ${U.aprobado}`, delegable: `≥ ${U.muestraSegmento} exámenes y IC95 inferior de aprobación ≥ ${U.aprobacionInferior * 100} %`, ayuda: `cada ayuda resta el ${U.penalizacionAyuda * 100} %, máximo ${U.maxAyudas}` };
        if (!ctx.autorizado()) return { ...sinExamenes('Define KARAJAN_TUTORIA_EXAMENES=1 para ejecutar exámenes (gastan tokens del tutor y tiempo del equipo).', { ...metricasDe(resumen(previos)), autorizado: 0 }), umbrales, detalle: { motivo: 'sin autorización', calificacion: resumen(previos) } };
        const alumno = ctx.alumno(), tutor = ctx.tutor();
        if (!('agente' in alumno) || !('agente' in tutor)) {
          const motivo = !('agente' in alumno) ? `sin alumno: ${alumno.motivo}` : `sin tutor: ${(tutor as { motivo: string }).motivo}`;
          return { muestra: previos.length, suficiente: false, metricas: metricasDe(resumen(previos)), umbrales, hallazgos: [], detalle: { motivo, calificacion: resumen(previos) } };
        }
        const mismo = `${alumno.agente.proveedor.nombre}/${alumno.agente.modelo}`;
        const delAlumno = previos.filter((e) => e.alumno === mismo);
        // Cada tarea se examina sin skills (la nota del alumno) y, si SkillForge tiene skills validadas para su dominio, otra vez con ellas.
        const hechos = new Set(delAlumno.map((e) => `${e.tarea}|${claveConjunto(e.forjadas ?? [])}`));
        const forjadas = ctx.forjadas();
        const puertos = ctx.puertos();
        const candidatas = (await ctx.tareasReales())
          .filter((t) => t.estado === 'completada' && t.prompt?.trim() && !/^Origen: karajan:/m.test(t.prompt)).sort((a, b) => b.actualizada - a.actualizada);
        const nuevos: ExamenAnonimo[] = [];
        let sinReferencia = 0;
        for (const t of candidatas) {
          if (nuevos.length >= ctx.maxPorEjecucion()) break;
          const hash = ctx.hash(t.id);
          const skillsHoja = t.hoja?.agente && t.hoja.agente !== 'auto' ? t.hoja.skills : undefined;
          const con = aplicables(forjadas, puertos.planificar(t.prompt!, skillsHoja).dominio);
          const pendienteBase = !hechos.has(`${hash}|`);
          const pendienteCon = con.length > 0 && !hechos.has(`${hash}|${claveConjunto(con.map(etiquetaForjada))}`);
          if (!pendienteBase && !pendienteCon) continue;
          const referencia = buscarReferencia(ctx.repos(), t.id);
          if (!referencia) { sinReferencia++; continue; }
          const dato = { hash, prompt: t.prompt!, referencia, alumno: alumno.agente, tutor: tutor.agente, skillsHoja };
          if (pendienteBase) nuevos.push((await examinar(dato, puertos)).examen);
          if (pendienteCon && nuevos.length < ctx.maxPorEjecucion()) nuevos.push((await examinar({ ...dato, forjadas: con }, puertos)).examen);
        }
        // La nota del alumno actual (sin skills forjadas): sus exámenes anteriores con este mismo modelo más los de ahora.
        const todos = [...delAlumno, ...nuevos];
        const suyos = todos.filter(esBase);
        const c = resumen(suyos);
        const efectos = efectoForjadas(todos);
        const hallazgos: Hallazgo[] = [];
        const suficiente = c.examenes - c.sinCalificar >= U.muestraSegmento;
        if (suficiente) {
          if (c.nivelMaximoDelegable >= 1) hallazgos.push({
            clave: `delegable-n${c.nivelMaximoDelegable}`, severidad: 'media', titulo: `El alumno local (${mismo}) aprueba hasta N${c.nivelMaximoDelegable}: valorar delegarle esas tareas`,
            evidencia: `${c.examenes - c.sinCalificar} exámenes con tutor ${nuevos[0]?.tutor ?? 'n/d'}, nota media ${c.nota} %, ${c.aprobados} aprobados. Por nivel: ${c.porNivel.map((s) => `${s.clave} ${s.media} % (n=${s.n}, IC95 inf. ${s.aprobacionInferior})${s.delegable ? ' ✔' : ''}`).join('; ')}.`,
            propuesta: `Añadir una regla al perfil por defecto que mande al alumno las tareas de nivel ≤ ${c.nivelMaximoDelegable}, con el delegador en solo-propuesta hasta que la persona la acepte.`,
            criterios: ['La regla cita este examen como motivo', 'Tras aplicarla, `kj lab run delegador` sigue limpio', 'La nota del alumno se vuelve a medir tras una semana de uso'],
          });
          const obst = new Map<string, number>();
          for (const e of suyos) for (const o of e.obstaculos) obst.set(o, (obst.get(o) ?? 0) + 1);
          const frecuente = [...obst].sort((a, b) => b[1] - a[1])[0];
          if (frecuente && frecuente[1] >= 3) hallazgos.push({ clave: `obstaculo-${frecuente[0]}`, severidad: 'baja', titulo: `El obstáculo más repetido del alumno es «${frecuente[0]}» (${frecuente[1]} veces)`, evidencia: [...obst].map(([k, v]) => `${k} ${v}`).join(', '), propuesta: 'Resolverlo en la configuración del agente local en lugar de depender del tutor.' });
        }
        for (const f of efectos) {
          if (f.util) hallazgos.push({
            clave: `forjada-util-${f.skills}`, severidad: 'media', titulo: `La skill forjada ${f.skills} sube la nota del alumno ${f.deltaMedio} puntos en tareas reales`,
            evidencia: `${f.pares} tareas integradas examinadas con y sin la skill: mejoran ${f.mejoran}, empeoran ${f.empeoran}. Alumno ${mismo}.`,
            propuesta: 'Valorar instalar esa skill para el agente local o dársela en los prompts que le delegue el perfil. La decide la persona; SkillForge solo la activó en su laboratorio.',
            criterios: ['La nota con skill se vuelve a medir tras instalarla', 'Los niveles delegables no bajan al añadirla'],
          });
          else if (f.pares >= U.muestraSegmento && f.deltaMedio < U.mejoraForjada) hallazgos.push({
            clave: `forjada-inutil-${f.skills}`, severidad: 'baja', titulo: `La skill forjada ${f.skills} no mejora al alumno en tareas reales (${f.deltaMedio >= 0 ? '+' : ''}${f.deltaMedio} puntos)`,
            evidencia: `${f.pares} pares con y sin la skill: mejoran ${f.mejoran}, empeoran ${f.empeoran}. En SkillForge pasó su validación sintética; aquí no se confirma.`,
            propuesta: 'No instalarla. Anotarlo en la trazabilidad de SkillForge y, si hay brechas en ese dominio, forjar otra con tareas más parecidas a las reales.',
          });
        }
        const conSkill = new Set(forjadas.flatMap((s) => s.dominios));
        for (const b of brechas(suyos).filter((x) => !x.delegable && x.n >= U.muestraSegmento && x.media < U.aprobado && !conSkill.has(x.dominio))) hallazgos.push({
          clave: `forjar-${b.dominio}-n${b.nivel}`, severidad: 'media', titulo: `El alumno suspende ${b.dominio} N${b.nivel} (${b.media} %): forjarle una skill con SkillForge`,
          evidencia: `${b.n} exámenes, aprobación ${b.aprobacion === null ? 'n/d' : Math.round(b.aprobacion * 100)} %. Obstáculos: ${Object.entries(b.obstaculos).map(([k, v]) => `${k} ${v}`).join(', ') || 'ninguno'}. Aún no hay skill forjada activa para «${b.dominio}».`,
          propuesta: 'Con la skill skillforge-lab: `kj tutoria brechas --salida brechas.json`, escribir tareas verificables de ese dominio y `campaign from-karajan`. Karajan medirá después la skill con y sin ella.',
          criterios: ['Hay una tarea verificable con el dominio como id', 'La campaña usa el tutor y el alumno actuales', 'La skill, si valida, se mide en Karajan antes de instalarla'],
        });
        if (nuevos.length >= 3 && nuevos.filter((e) => e.nota === null).length / nuevos.length > 0.3) hallazgos.push({
          clave: 'tutor-sin-veredicto', severidad: 'media', titulo: 'El tutor no está dando veredicto en más del 30 % de los exámenes',
          evidencia: nuevos.filter((e) => e.nota === null).slice(0, 5).map((e) => e.motivo).join(' | '), propuesta: 'Revisar el tutor elegido (`kj tutoria tutores`) y el formato de respuesta que se le pide en `promptEvaluador`.',
        });
        return {
          muestra: c.examenes - c.sinCalificar, suficiente, hallazgos, umbrales,
          metricas: { ...metricasDe(c), skills_forjadas: forjadas.length, pares_forjada: efectos.reduce((s, f) => s + f.pares, 0), nuevos: nuevos.length, tareas_sin_referencia: sinReferencia, ayudas_por_examen: proporcion(suyos.reduce((s, e) => s + e.ayudas, 0), suyos.length), aprobacion: proporcion(c.aprobados, c.examenes - c.sinCalificar) },
          detalle: { alumno: mismo, tutor: `${tutor.agente.proveedor.nombre}/${tutor.agente.modelo}`, calificacion: c, forjadas: efectos, nuevos },
        };
      },
    },
  ],
};
