import type { Biblioteca } from '../biblioteca';
import type { Hallazgo } from '../pasarela-borradores';
import type { SkillDisponible } from '../skills-seleccion';
import { proporcion, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';
import {
  compararEquipo, compararKarajan, GRUPO_KARAJAN, MIN_PARES_FUNCIONALIDAD, MUESTRA_MINIMA_GRUPO, paresConDato, PRUEBAS_REALES, pruebasCubiertas, pruebasEnGrupos, TOP_PARES,
  type CapacidadKarajan, type Comparacion,
} from '../comparador';

/**
 * Laboratorio del comparador: ¿compara con criterio? Un contrato (solo estrellas propias, grupos con muestra mínima y cuánto del
 * equipo se puede comparar) y un escenario que produce los hallazgos útiles: pruebas de ejecución real con feedback humano que
 * tienen los mejores pares y Karajan no, y funcionalidades declaradas por los pares que a Karajan le faltan.
 */
export interface ContextoComparador extends ContextoLab { biblioteca: Biblioteca; skills(): SkillDisponible[]; capacidades(): CapacidadKarajan[] }

/** Pares (de al menos tantos) que tienen que declarar una funcionalidad para que su ausencia en Karajan sea un hallazgo `media`; con menos, `baja`. */
export const MIN_PARES_MEDIA = 3;
/** Por debajo de esta cobertura de comparación el equipo se compara a ciegas (hallazgo `baja`: depende de la ingesta de la biblioteca). */
const COBERTURA_MINIMA = 0.2;
/** Una skill por debajo de este percentil de un grupo suficiente aparece en el informe. */
const PERCENTIL_BAJO = 25;

const sinBiblioteca = (n: number): Resultado => ({ muestra: n, suficiente: false, metricas: { disponible: 0 }, hallazgos: [{ clave: 'sin-biblioteca', severidad: 'media', titulo: 'El comparador no encuentra resources.db', evidencia: 'Ni `ATLAS_KARAJAN_RESOURCES` ni la carpeta de datos del Karajan nativo tienen resources.db.', propuesta: 'Apuntar `ATLAS_KARAJAN_RESOURCES` al resources.db del Karajan nativo.' }] });
const estrellas = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ★`;

export const laboratorioComparador: Laboratorio<ContextoComparador> = {
  escenarios: [
    {
      id: 'estrellas-propias', tipo: 'contrato', descripcion: 'Solo estrellas propias, grupos con muestra mínima y cuánto del equipo se puede comparar',
      ejecutar: (ctx): Resultado => {
        const skills = ctx.skills();
        if (!ctx.biblioteca.disponible) return sinBiblioteca(skills.length);
        const comps = compararEquipo(ctx.biblioteca, skills);
        const cuenta = (e: Comparacion['estado']) => comps.filter((c) => c.estado === e).length;
        const comparadas = comps.filter((c) => c.estado === 'comparada');
        // Invariantes: nada de estrellas heredadas, ni en el sujeto ni en sus pares; solo se puntúa con muestra mínima.
        const heredadas = comps.filter((c) => c.estrellas !== null && ctx.biblioteca.fichaDe(c.sujeto)?.heredadas);
        const conGrupo = comps.filter((c) => c.grupo);
        const ajenas = conGrupo.flatMap((c) => c.mejores.filter((p) => !paresConDato(ctx.biblioteca, c.grupo!).some((f) => f.nombre === p.nombre)).map((p) => `${c.sujeto}→${p.nombre}`));
        const cortos = comps.filter((c) => c.percentil !== null && c.conDato + 1 < MUESTRA_MINIMA_GRUPO);
        const hallazgos: Hallazgo[] = [];
        const roto = [...heredadas.map((c) => `${c.sujeto}: puntuada con estrellas heredadas`), ...ajenas.map((a) => `par sin estrellas propias: ${a}`), ...cortos.map((c) => `${c.sujeto}: percentil con un grupo de ${c.conDato + 1}`)];
        if (roto.length) hallazgos.push({ clave: 'contrato-roto', severidad: 'media', titulo: 'El comparador puntúa con datos que no debería', evidencia: roto.slice(0, 20).join('; '), propuesta: 'Corregir `comparador.ts` para que solo puntúe con estrellas propias y grupos con muestra mínima.', criterios: ['Ninguna comparación usa estrellas heredadas', `Ningún percentil sale de un grupo con menos de ${MUESTRA_MINIMA_GRUPO} recursos con estrellas propias`, 'Tras el cambio, `kj lab run comparador` ya no da este hallazgo'] });
        if (skills.length && comparadas.length / skills.length < COBERTURA_MINIMA) hallazgos.push({ clave: 'cobertura-baja', severidad: 'baja', titulo: `Solo ${comparadas.length} de ${skills.length} skills del equipo se pueden comparar`, evidencia: `Sin ficha ${cuenta('sin-ficha')}, sin grupo ${cuenta('sin-grupo')}, sin estrellas propias ${cuenta('sin-dato')}, grupo con muestra corta ${cuenta('grupo-corto')}.`, propuesta: 'Resolver el repo de origen de cada skill anidada y guardar sus estrellas propias antes de usar la comparación para decidir.' });
        return {
          muestra: skills.length, suficiente: skills.length > 0, hallazgos,
          metricas: { comparadas: proporcion(comparadas.length, skills.length), sin_ficha: proporcion(cuenta('sin-ficha'), skills.length), sin_dato: proporcion(cuenta('sin-dato'), skills.length), grupo_corto: proporcion(cuenta('grupo-corto'), skills.length), con_estrellas_heredadas: heredadas.length, pares_sin_estrellas_propias: ajenas.length, percentiles_con_muestra_corta: cortos.length },
          umbrales: { con_estrellas_heredadas: '= 0', pares_sin_estrellas_propias: '= 0', percentiles_con_muestra_corta: '= 0', comparadas: `≥ ${COBERTURA_MINIMA * 100} % (si no, baja)`, muestra_minima_grupo: `${MUESTRA_MINIMA_GRUPO} recursos con estrellas propias` },
          detalle: { porGrupo: Object.entries(comps.reduce<Record<string, { comparadas: number; total: number }>>((a, c) => { const g = c.grupo ?? '(sin grupo)'; (a[g] ??= { comparadas: 0, total: 0 }).total++; if (c.estado === 'comparada') a[g]!.comparadas++; return a; }, {})).map(([grupo, v]) => ({ grupo, ...v })) },
        };
      },
    },
    {
      id: 'pruebas-y-funcionalidades', tipo: 'contrato', descripcion: 'Pruebas con feedback humano y funcionalidades que tienen los mejores pares y Karajan no',
      ejecutar: (ctx): Resultado => {
        if (!ctx.biblioteca.disponible) return sinBiblioteca(0);
        const caps = ctx.capacidades();
        const karajan = compararKarajan(ctx.biblioteca, caps);
        const grupos = [GRUPO_KARAJAN, ...compararEquipo(ctx.biblioteca, ctx.skills()).filter((c) => c.estado === 'comparada' || c.estado === 'sin-dato').map((c) => c.grupo!)];
        const halladas = pruebasEnGrupos(ctx.biblioteca, grupos);
        const propias = pruebasCubiertas(caps);
        const faltan = halladas.filter((p) => !propias.has(p.prueba));
        const hallazgos: Hallazgo[] = [];
        const suficiente = karajan.conDato >= MUESTRA_MINIMA_GRUPO;
        if (suficiente) {
          // Pruebas: cada una que tiene algún par top y Karajan no, un borrador (palabra clave declarada en su ficha: se dice en la evidencia).
          for (const p of faltan) {
            const par = p.pares[0]!;
            hallazgos.push({
              clave: `prueba-${p.prueba}`, severidad: 'media', titulo: `Añadir al laboratorio la prueba «${p.nombre}» inspirada en ${par.par}`,
              evidencia: `Pares top por estrellas propias que la declaran: ${p.pares.map((x) => `${x.par} (${estrellas(x.estrellas)}) ${x.indicio}`).join(' | ')}. Karajan no la tiene en sus laboratorios (solo ${[...propias].join(', ') || 'ninguna de estas'}). Es una palabra clave de la ficha, no una comprobación del repo.`,
              propuesta: `Diseñar la prueba «${p.nombre}» como escenario del laboratorio que corresponda, con tareas reales anonimizadas y feedback de la persona, sin mutar producción.`,
              criterios: [p.criterio, 'Muestra mínima fijada: por debajo, se dan métricas pero no hallazgos', 'Juzga proporciones con el IC95 de Wilson, no con el valor puntual', 'Funciona en modo producción: ni task_logs.db ni carpetas de skills reales cambian', 'Tras el cambio, `kj lab ls` muestra el nuevo escenario'],
            });
          }
          // Funcionalidades: `media` si las declaran al menos MIN_PARES_MEDIA de los pares top; `baja` si solo MIN_PARES_FUNCIONALIDAD.
          const fuertes = karajan.faltan.filter((f) => f.pares.length >= MIN_PARES_MEDIA), debiles = karajan.faltan.filter((f) => f.pares.length < MIN_PARES_MEDIA);
          if (fuertes.length) hallazgos.push({ clave: 'funcionalidades-karajan', severidad: 'media', titulo: `Karajan no declara ${fuertes.length === 1 ? 'una funcionalidad que ofrecen' : `${fuertes.length} funcionalidades que ofrecen`} al menos ${MIN_PARES_MEDIA} de sus ${TOP_PARES} mejores pares`, evidencia: fuertes.map((f) => `${f.funcionalidad} (${f.pares.join(', ')})`).join('; ') + '. Son etiquetas y capacidades declaradas en las fichas de la biblioteca, no una comparación de código.', propuesta: 'Decidir cuáles encajan con la responsabilidad de algún componente (o de uno nuevo) y abrir una tarea por cada una; descartar las que no.', criterios: ['Cada funcionalidad elegida tiene su componente, su laboratorio y su ficha', 'Las descartadas quedan anotadas con el motivo', 'Tras el cambio, `kj comparar karajan` ya no la lista'] });
          if (debiles.length) hallazgos.push({ clave: 'funcionalidades-karajan-menores', severidad: 'baja', titulo: `${debiles.length} funcionalidades más las declaran ${MIN_PARES_FUNCIONALIDAD} pares`, evidencia: debiles.map((f) => `${f.funcionalidad} (${f.pares.join(', ')})`).join('; '), propuesta: 'Solo informativo.' });
        }
        // Skills del equipo en la cola de su grupo (solo informativo).
        const bajas = compararEquipo(ctx.biblioteca, ctx.skills()).filter((c) => c.percentil !== null && c.percentil < PERCENTIL_BAJO);
        if (bajas.length) hallazgos.push({ clave: 'skills-bajo-su-grupo', severidad: 'baja', titulo: `${bajas.length} skills del equipo están por debajo del percentil ${PERCENTIL_BAJO} de su grupo`, evidencia: bajas.map((c) => `${c.sujeto} (p${c.percentil}, ${c.grupoNombre})`).join('; '), propuesta: 'Valorar si hay un par mejor posicionado que cubra lo mismo.' });
        return {
          muestra: karajan.conDato, suficiente, hallazgos: suficiente ? hallazgos : hallazgos.filter((h) => h.severidad === 'baja'),
          metricas: { pares_con_estrellas_propias: karajan.conDato, pruebas_en_pares: halladas.length, pruebas_que_karajan_ya_tiene: halladas.length - faltan.length, pruebas_sin_cubrir: faltan.length, funcionalidades_que_faltan: karajan.faltan.length, funcionalidades_en_3_o_mas_pares: karajan.faltan.filter((f) => f.pares.length >= MIN_PARES_MEDIA).length },
          umbrales: { muestra: `≥ ${MUESTRA_MINIMA_GRUPO} pares con estrellas propias`, prueba_sin_cubrir: 'media: algún par top la declara y Karajan no tiene escenario de ese tipo', funcionalidad: `media si la declaran ≥ ${MIN_PARES_MEDIA} de ${TOP_PARES} pares; baja con ${MIN_PARES_FUNCIONALIDAD}` },
          detalle: { grupo: karajan.grupoNombre, estadoKarajan: karajan.estado, pruebasCatalogo: PRUEBAS_REALES.map((p) => p.id), grupos: [...new Set(grupos)], mejores: karajan.mejores },
        };
      },
    },
  ],
};
