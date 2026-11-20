import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { destinoDe } from './rotador';
import { Delegador } from './delegar';
import { perfilPorDefecto } from './perfiles';
import { buscarBinario, disponibilidad, ejecutarProveedor, PROVEEDORES } from './proveedores';
import { crearRuntime } from './runtime';
import { aHallazgo, curar, REGLAS_CURADOR, UMBRALES_CURADOR, type EntradaCurador } from './curador';
import { construirArquitectura, type ContextoArquitectura } from './arquitectura';
import { claudeExcedido, leerLimites, rutaLimites } from './limites';
import { actualizarCatalogo, elegirTutores, leerCatalogo, type ProveedorTutor } from './tutor';
import { agenteAlumno, agenteTutor, listarRepos, type PlanTarea, type PuertosExamen } from './tutoria';
import { calificacion, type ExamenAnonimo } from './tutoria-nota';
import { carpetaSkillForge, efectoForjadas, informeBrechas, leerSkillsForjadas } from './skillforge';
import { CAPAS, COMPONENTES, componente, catalogoComponentes } from './componentes';
import { anonimizar, ejecutarLaboratorio, hashTarea, salLocal, type ContextoLab, type TareaAnonima } from './laboratorio';
import { clasificar } from './heuristica';
import { consultarComparacion, type CapacidadKarajan } from './comparador';
import { descubrirSkills, puntuarSkills, type SkillDisponible } from './skills-seleccion';
import { type crearAplicacionDosificador } from './aplicacion-dosificador';
import { type crearAplicacionPlanificador } from './aplicacion-planificador';

const falla = (estado: number, detail: string) => Object.assign(new Error(detail), { status: estado });
const entero = (v: string | undefined, defecto: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, Math.trunc(n))) : defecto; };

export function crearAplicacionLaboratorio(runtime: ReturnType<typeof crearRuntime>, version: string, dosificador: ReturnType<typeof crearAplicacionDosificador>, planificador: ReturnType<typeof crearAplicacionPlanificador>) {
  const { dirDatos, almacen, config, perfiles, rotador, dirLab, atlasDev, pasarela, guardian, rutaBiblioteca, biblioteca, registroLab } = runtime;
  const { configDos, estadoDos } = dosificador;
  // ── Laboratorio: cada componente mide su función con tareas reales de Atlas dev, anonimizadas (ver laboratorio.ts) ──
  const sal = salLocal(dirLab);
  const skillsEquipo = (() => { let c: SkillDisponible[] | null = null; return () => (c ??= descubrirSkills()); })();
  // El delegador del laboratorio solo planifica: todos los agentes «disponibles» (se mide el perfil, no este equipo) y sin límites.
  const delegadorLab = new Delegador({
    almacen, perfiles, config, raiz: process.env['ATLAS_WORKSPACE'] ?? homedir(), skillsDisponibles: skillsEquipo, limites: () => null,
    disponible: (p) => ({ nombre: p.nombre, etiqueta: p.nombre, gratis: false, disponible: true, ruta: null, motivo: null, login: '' }),
    ejecutor: () => { throw new Error('El laboratorio no ejecuta agentes'); },
  });
  /** Lo que el curador necesita, leído ahora y en solo lectura: skills, fichas, usos, recomendaciones y protegidas. */
  const entradaCurador = (): EntradaCurador => {
    const skills = skillsEquipo(), tareas = almacen.tareasPlanas(), ultimos = rotador.ultimosUsos();
    const usos: EntradaCurador['usos'] = {}, recomendadas: EntradaCurador['recomendadas'] = {};
    const anotar = (r: Record<string, { ultimo?: string | null; ultima?: string | null; n: number }>, nombre: string, cuando: string, campo: 'ultimo' | 'ultima') => {
      const f = (r[nombre] ??= { n: 0 }); f.n++;
      if (!f[campo] || cuando > f[campo]!) f[campo] = cuando;
    };
    for (const t of tareas) {
      for (const n of new Set([...t.ejecutadas, ...(t.revision?.['skills_usadas'] ?? [])])) anotar(usos, n, t.created_at, 'ultimo');
      for (const n of t.recomendadas) anotar(recomendadas, n, t.created_at, 'ultima');
    }
    for (const [n, c] of Object.entries(ultimos)) { const f = (usos[n] ??= { ultimo: null, n: 0 }); if (!f.ultimo || c > f.ultimo) f.ultimo = c; }
    return {
      ahora: Date.now(), skills, fichas: Object.fromEntries(skills.map((x) => [x.name, biblioteca.fichaDe(x.name)])), usos, recomendadas,
      registroDesde: tareas.reduce<string | null>((m, t) => (!m || t.created_at < m ? t.created_at : m), null), protegidas: rotador.leerEstado().config.protegidas,
    };
  };
  /** Lo que Karajan sabe de sí mismo para el comparador: sus componentes y los tipos de escenario de cada laboratorio. */
  const capacidadesKarajan = (): CapacidadKarajan[] => COMPONENTES.map((c) => ({ id: c.id, responsabilidad: c.responsabilidad, pruebas: c.laboratorio?.escenarios.map((e) => e.tipo) ?? [] }));
  // ── Tutoría: el alumno local examinado con tareas ya integradas y un tutor elegido por razonamiento/precio (ver tutoria.ts, tutor.ts) ──
  const rutaTutores = join(dirLab, 'tutores.json');
  const seleccionTutor = () => elegirTutores(leerCatalogo(rutaTutores), {
    disponibles: (['claude-cli', 'codex'] as ProveedorTutor[]).filter((n) => disponibilidad(PROVEEDORES.find((p) => p.nombre === n)!).disponible),
    excluir: claudeExcedido(leerLimites()) !== null ? ['claude-cli'] : [],
  });
  const puertosExamen = (): PuertosExamen => {
    const alumno = agenteAlumno();
    const destino = 'agente' in alumno ? destinoDe(alumno.agente.proveedor.nombre) : null;
    const rutasSkill = (n: string) => (['claude', 'codex'] as const).flatMap((d) => [join(rotador.raiz(d), n, 'SKILL.md'), join(rotador.almacen(d), n, 'SKILL.md')]);
    return {
      ejecutor: ejecutarProveedor,
      planificar: (prompt, skillsHoja): PlanTarea => {
        const c = delegadorLab.planificar(prompt).clasificacion;
        return { dominio: c.domain[0] ?? 'general', nivel: Number(/[1-5]/.exec(c.complexity_level)?.[0] ?? 1),
          subtareas: c.subtasks.map((st, i) => ({ nombre: st.name, validacion: st.validation, skills: i === 0 && skillsHoja?.length ? skillsHoja : st.recommended_skills ?? [] })) };
      },
      instaladas: () => new Set(destino ? rotador.inventario().filter((f) => f.instaladaEn.includes(destino)).map((f) => f.skill) : []),
      textoSkill: (n) => { const r = rutasSkill(n).find((x) => existsSync(x)); return r ? readFileSync(r, 'utf8') : null; },
    };
  };
  /** Las skills que SkillForge dejó activas y validadas con modelos reales para este alumno (si el laboratorio está en el Workspace). */
  const skillsForjadas = (a: { proveedor: { nombre: string }; modelo: string }) => leerSkillsForjadas(carpetaSkillForge(), { proveedor: a.proveedor.nombre, modelo: a.modelo });
  const examenesPrevios = (): ExamenAnonimo[] => registroLab.ejecuciones('tutoria', 500).filter((e) => e.escenario === 'examen')
    .flatMap((e) => ((e.detalle as { nuevos?: ExamenAnonimo[] } | null)?.nuevos ?? []));
  const actualizarTutores = async () => {
    const r = await actualizarCatalogo(rutaTutores);
    if (r.cambio) console.warn(`[karajan] tutor: ${r.antes ? `${r.antes.proveedor}/${r.antes.modelo}` : 'ninguno'} → ${r.despues ? `${r.despues.proveedor}/${r.despues.modelo}` : 'ninguno'}`);
    return r;
  };
  const contextoDe = (id: string) => {
    let cache: Promise<TareaAnonima[]> | null = null;
    const base: ContextoLab = {
      tareas: () => (cache ??= atlasDev.tareas(1000).then((t) => anonimizar(t, sal))),
      calibraciones: (c) => registroLab.calibraciones(c),
    };
    switch (id) {
      case 'delegador': return { ...base, perfil: () => perfilPorDefecto(perfiles.leer()), planificar: (p: string) => delegadorLab.planificar(p) };
      case 'selector': return { ...base, skills: skillsEquipo, revisadas: () => almacen.tareasPlanas().filter((t) => t.revision?.['skills_usadas']?.length).map((t) => ({ id: t.task_id, prompt: t.prompt, skills: t.revision!['skills_usadas']! })) };
      case 'clasificador': return { ...base, clasificar: (p: string) => clasificar(p, config()) };
      case 'biblioteca': return { ...base, biblioteca, skills: skillsEquipo };
      case 'curador': return { ...base, entrada: entradaCurador, borradores: () => pasarela.listar().then((l) => l.map((b) => ({ clave: b.clave, estado: b.estado }))).catch(() => []) };
      case 'eficiencia': case 'metodo': case 'prompts': return { ...base, clasificar: (p: string) => { const k = clasificar(p, config()); return { nivel: Number(/[1-5]/.exec(k.complexity_level)?.[0] ?? 1), dominio: k.domain[0] ?? 'general', intencion: k.intent }; } };
      // Ejecución y observación: leen el registro y el equipo en solo lectura; lo que reproducen lo hacen en temporales.
      case 'almacen': return { ...base, almacen };
      case 'proveedores': return { ...base, runs: () => almacen.tareasPlanas().flatMap((t) => t.runs ?? []), buscar: (b: string) => buscarBinario(b) };
      case 'limites': return { ...base, ruta: rutaLimites(), ahora: () => Date.now() };
      case 'dosificador': return { ...base, config: configDos };
      case 'planificador': return { ...base, config: planificador.config };
      case 'aislamiento': return { ...base, workspace: process.env['ATLAS_WORKSPACE'] ?? null };
      case 'analitica': return { ...base, registros: () => almacen.listarTareas(), runsPorTarea: () => Object.fromEntries(almacen.listarTareas().filter((r) => r.delegation).map((r) => [r.task_id, almacen.runs(r.task_id)])), metricas: () => almacen.metricas() };
      case 'produccion': return base;
      case 'rotador': return { ...base, rotador, historial: () => rotador.historial(), ahora: () => Date.now() };
      case 'tutor': return { ...base, catalogo: () => leerCatalogo(rutaTutores), disponibles: () => (['claude-cli', 'codex'] as ProveedorTutor[]).filter((n) => disponibilidad(PROVEEDORES.find((p) => p.nombre === n)!).disponible), excluir: () => (claudeExcedido(leerLimites()) !== null ? ['claude-cli' as ProveedorTutor] : []), ahora: () => Date.now() };
      case 'tutoria': return {
        ...base, tareasReales: () => atlasDev.tareas(1000), hash: (id: string) => hashTarea(sal, id), repos: () => listarRepos(process.env['ATLAS_WORKSPACE'] ?? homedir()),
        alumno: () => agenteAlumno(), tutor: () => { const a = agenteTutor(seleccionTutor().tutor); return a ? { agente: a } : { motivo: seleccionTutor().avisos.join(' · ') || 'sin tutor' }; },
        forjadas: () => { const a = agenteAlumno(); return 'agente' in a ? skillsForjadas(a.agente) : []; },
        puertos: puertosExamen, previos: examenesPrevios, autorizado: () => process.env['KARAJAN_TUTORIA_EXAMENES'] === '1', maxPorEjecucion: () => Math.max(1, Number(process.env['KARAJAN_TUTORIA_MAX']) || 3),
      };
      case 'comparador': return { ...base, biblioteca, skills: skillsEquipo, capacidades: capacidadesKarajan };
      default: return base;
    }
  };
  const ultimas = (id: string) => {
    const vistas = new Set<string>();
    return registroLab.ejecuciones(id, 100).filter((e) => !vistas.has(e.escenario) && vistas.add(e.escenario))
      .map((e) => ({ escenario: e.escenario, inicio: e.inicio, muestra: e.muestra, suficiente: e.suficiente, hallazgos: e.hallazgos.length, error: e.error, metricas: e.metricas }));
  };

  const componentes = () => ({
    version: version, modo: guardian.modo(), capas: CAPAS,
    componentes: catalogoComponentes(ultimas),
  });
  // Datos de la ventana «Arquitectura» de Atlas dev: solo lectura (ver arquitectura.ts y docs/laboratorio/componentes.md).
  const cacheArquitectura = new Map<string, { en: number; valor: unknown }>();
  const contextoArquitectura = (): ContextoArquitectura => ({
    version: version, modo: guardian.modo(), dirDatos, dirLab, config,
    perfil: () => { try { return perfilPorDefecto(perfiles.leer()); } catch { return null; } },
    rotador, limites: () => leerLimites(), dosificador: { config: configDos, estado: estadoDos }, planificador: { config: planificador.config, planes: planificador.listaPlanes }, pasarela, biblioteca: { disponible: biblioteca.disponible, ruta: biblioteca.disponible ? rutaBiblioteca : null },
    registro: registroLab, almacen, cache: cacheArquitectura, ttlMs: 30_000,
  });
  const arquitectura = async () => construirArquitectura(contextoArquitectura());
  const arquitecturaDetalle = async (req: { params: Record<string, string> }) => {
    const c = await construirArquitectura(contextoArquitectura(), { id: req.params['id']! });
    if (!c) throw falla(404, `No hay componente «${req.params['id']}»`);
    return c;
  };
  /** Solo lectura: `?skill=<nombre>` una skill del equipo, `?skill=karajan` Karajan con las pruebas de sus pares, sin `skill` todo el equipo (`?grupo=` filtra por grupo). */
  const comparar = (req: { query: Record<string, string | undefined> }) => {
    return consultarComparacion(biblioteca, req.query['skill'] || '', req.query['grupo'] || '', skillsEquipo, capacidadesKarajan());
  };
  const ejecuciones = (req: { query: Record<string, string | undefined> }) => registroLab.ejecuciones(req.query['componente'] || undefined, entero(req.query['limite'], 50, 1, 1000));
  // Tutores y tutoría: GET solo lee; POST actualiza el catálogo de tutores (recalcula el tutor) y no ejecuta ningún examen.
  const tutores = () => ({ ...seleccionTutor(), catalogo: leerCatalogo(rutaTutores) });
  const actualizar = async () => actualizarTutores();
  const tutoria = () => {
    const alumno = agenteAlumno();
    const todos = examenesPrevios();
    const nombre = 'agente' in alumno ? `${alumno.agente.proveedor.nombre}/${alumno.agente.modelo}` : null;
    return { alumno: nombre, motivo_sin_alumno: 'motivo' in alumno ? alumno.motivo : null, tutor: seleccionTutor().tutor, autorizado: process.env['KARAJAN_TUTORIA_EXAMENES'] === '1',
      calificacion: calificacion(nombre ? todos.filter((e) => e.alumno === nombre) : todos), alumnos: [...new Set(todos.map((e) => e.alumno))],
      skillforge: { laboratorio: carpetaSkillForge() !== null, skills: 'agente' in alumno ? skillsForjadas(alumno.agente).map((s) => ({ id: s.id, version: s.version, dominios: s.dominios })) : [], efecto: efectoForjadas(nombre ? todos.filter((e) => e.alumno === nombre) : todos) } };
  };
  // Brechas del alumno para la skill skillforge-lab: solo agregados anónimos. 409 si falta el alumno o el tutor (no hay a quién forjarle nada).
  const brechas = () => {
    const alumno = agenteAlumno(), tutor = seleccionTutor().tutor;
    if (!('agente' in alumno)) throw falla(409, `sin alumno: ${alumno.motivo}`);
    if (!tutor) throw falla(409, 'sin tutor vigente (kj tutoria actualizar)');
    const nombre = `${alumno.agente.proveedor.nombre}/${alumno.agente.modelo}`;
    return informeBrechas(examenesPrevios().filter((e) => e.alumno === nombre), { proveedor: alumno.agente.proveedor.nombre, modelo: alumno.agente.modelo }, { proveedor: tutor.proveedor, modelo: tutor.modelo });
  };
  const modo = () => ({ modo: guardian.modo(), fichero: join(dirDatos, 'modo.json') });
  const propuestas = () => pasarela.listar();
  // Curador: qué skills sobran. GET solo lee; POST manda cada propuesta como borrador (idempotente por `curador:<regla>:<skill>`), nunca retira nada.
  const curador = () => ({ generado: new Date().toISOString(), umbrales: UMBRALES_CURADOR, reglas: REGLAS_CURADOR.map((r) => ({ id: r.id, accion: r.accion, umbral: r.umbral(UMBRALES_CURADOR), descripcion: r.descripcion })), propuestas: curar(entradaCurador()) });
  const proponerCurador = async () => {
    const propuestas = curar(entradaCurador());
    const borradores = [];
    for (const p of propuestas) borradores.push({ ...p, borrador: await pasarela.proponer('curador', aHallazgo(p)) });
    return { propuestas: borradores };
  };
  /** Ejecuta el laboratorio de un componente (o `todos`). Solo mide y propone: los hallazgos `alta|media` salen como borradores. */
  const ejecutar = async (req: { body: unknown }) => {
    const b = (req.body ?? {}) as { componente?: unknown; escenario?: unknown; proponer?: unknown };
    const id = typeof b.componente === 'string' ? b.componente : '';
    const elegidos = id === 'todos' ? COMPONENTES.filter((c) => c.laboratorio) : [componente(id)].filter((c) => c !== null);
    if (!elegidos.length) throw falla(404, `No hay componente «${id}». Usa «todos» o uno de: ${COMPONENTES.filter((c) => c.laboratorio).map((c) => c.id).join(', ')}`);
    const sinLab = elegidos.find((c) => !c.laboratorio);
    if (sinLab) throw falla(409, `«${sinLab.id}» aún no tiene laboratorio: ${sinLab.pendiente}`);
    const informes = [];
    for (const c of elegidos) {
      informes.push(await ejecutarLaboratorio({ id: c.id, version: version, laboratorio: c.laboratorio! }, contextoDe(c.id), registroLab,
        { pasarela: b.proponer === false ? null : pasarela, escenario: typeof b.escenario === 'string' ? b.escenario : null }));
    }
    return { informes };
  };

  /** Para el panel sí/no de «Preparando»: sugerencias ponderadas para el prompt y búsqueda en la biblioteca, como tarjetas. */
  const sugerenciasSkills = (req: { query: Record<string, string | undefined> }) => {
    const prompt = (req.query['prompt'] ?? '').slice(0, 20_000), q = (req.query['q'] ?? '').slice(0, 200);
    const equipo = skillsEquipo();
    const porNombre = new Map(equipo.map((s) => [s.name, s]));
    const tarjeta = (nombre: string, puntos: number | null, descripcion = '') => {
      const s = porNombre.get(nombre), f = biblioteca.fichaDe(nombre);
      return { nombre, puntos, descripcion: s?.description || f?.descripcion || descripcion, estrellas: f?.estrellas ?? null, heredadas: f?.heredadas ?? false,
        repo_url: f?.repo_url ?? null, grupo: f?.grupo ?? null, instalada: (s?.instaladaEn.length ?? 0) > 0, almacen: (s?.enAlmacen.length ?? 0) > 0 && !(s?.instaladaEn.length) };
    };
    const sugeridas = prompt ? puntuarSkills(prompt, equipo).slice(0, entero(req.query['limite'], 10, 1, 30)).map((x) => tarjeta(x.nombre, x.puntos)) : [];
    const encontradas = q ? [
      ...equipo.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase())).slice(0, 15).map((s) => tarjeta(s.name, null)),
      ...biblioteca.buscar(q, 15).filter((f) => !porNombre.has(f.slug) && !porNombre.has(f.nombre)).map((f) => ({ ...tarjeta(f.nombre, null, f.descripcion), instalable: true })),
    ] : [];
    return { sugeridas, encontradas, biblioteca: biblioteca.disponible };
  };
  /** La respuesta de la persona al sí/no de las skills de una tarea (solo se guarda el hash de la tarea). */
  const guardarCalibracion = (req: { body: unknown }) => {
    const b = (req.body ?? {}) as { tarea?: unknown; componente?: unknown; propuesta?: unknown; respuesta?: unknown; correccion?: unknown };
    const lista = (v: unknown) => (Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 120)) : []);
    if (typeof b.tarea !== 'string' || !/^[\w-]{1,40}$/.test(b.tarea)) throw falla(422, 'tarea: el id de la tarea de Atlas dev');
    if (b.respuesta !== 'si' && b.respuesta !== 'no' && b.respuesta !== 'sin_revisar') throw falla(422, 'respuesta: si | no | sin_revisar');
    // Solo entrena el selector lo que existe: las skills desconocidas (ni del equipo ni de la biblioteca) se descartan y se devuelven.
    const equipo = new Set(skillsEquipo().map((s) => s.name));
    const conocida = (n: string) => equipo.has(n) || biblioteca.fichaDe(n) !== null;
    const correccion = lista(b.correccion).filter(conocida);
    registroLab.guardarCalibracion({ tarea_hash: hashTarea(sal, b.tarea), componente: typeof b.componente === 'string' ? b.componente.slice(0, 40) : 'selector', propuesta: lista(b.propuesta), respuesta: b.respuesta, correccion, creada: new Date().toISOString() });
    return { guardada: true, descartadas: lista(b.correccion).filter((n) => !conocida(n)) };
  };
  /** Lo último que respondió la persona para una tarea (para no volver a preguntar y precargar el panel); solo se compara por hash. */
  const leerCalibracion = (req: { query: Record<string, string | undefined> }) => {
    const tarea = req.query['tarea'] ?? '';
    if (!/^[\w-]{1,40}$/.test(tarea)) throw falla(422, 'tarea: el id de la tarea de Atlas dev');
    const hash = hashTarea(sal, tarea);
    const c = registroLab.calibraciones(req.query['componente'] || 'selector').filter((x) => x.tarea_hash === hash).at(-1);
    return c ? { calibrada: true, respuesta: c.respuesta, propuesta: c.propuesta, correccion: c.correccion, creada: c.creada } : { calibrada: false };
  };

  return { componentes, arquitectura, arquitecturaDetalle, comparar, ejecuciones, tutores, actualizar, tutoria, brechas, modo, propuestas, curador, proponerCurador, ejecutar, sugerenciasSkills, guardarCalibracion, leerCalibracion };
}
