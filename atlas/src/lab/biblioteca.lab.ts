import type { Biblioteca } from '../biblioteca';
import type { Hallazgo } from '../pasarela-borradores';
import type { SkillDisponible } from '../skills-seleccion';
import { proporcion, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';

/**
 * Laboratorio de la biblioteca de recursos: ¿sirve como base para decidir sobre las skills? Cuántas de las que hay en el equipo
 * tienen ficha, cuántas tienen estrellas propias (y no las heredadas de la colección que las recoge) y cuántas un grupo de la
 * taxonomía. Sin esto, el curador y el comparador decidirían a ciegas.
 */
export interface ContextoBiblioteca extends ContextoLab { biblioteca: Biblioteca; skills(): SkillDisponible[] }

export const laboratorioBiblioteca: Laboratorio<ContextoBiblioteca> = {
  escenarios: [{
    id: 'cobertura', tipo: 'contrato', descripcion: 'Fichas, estrellas propias y taxonomía de las skills que hay en el equipo',
    ejecutar: (ctx): Resultado => {
      const skills = ctx.skills();
      if (!ctx.biblioteca.disponible) {
        return { muestra: skills.length, suficiente: false, metricas: { disponible: 0 }, hallazgos: [{ clave: 'sin-biblioteca', severidad: 'media', titulo: 'El paquete no encuentra resources.db', evidencia: 'Ni `ATLAS_KARAJAN_DATA` ni `<ATLAS_WORKSPACE>/karajan/data` tienen resources.db.', propuesta: 'Apuntar `ATLAS_KARAJAN_DATA` a la carpeta data del Karajan nativo.' }] };
      }
      const fichas = skills.map((s) => ({ s, f: ctx.biblioteca.fichaDe(s.name) }));
      const con = fichas.filter((x) => x.f);
      const propias = con.filter((x) => x.f!.estrellas !== null && !x.f!.heredadas).length;
      const heredadas = con.filter((x) => x.f!.heredadas).length;
      const sinGrupo = con.filter((x) => !x.f!.grupo).length;
      const sinFicha = fichas.filter((x) => !x.f).map((x) => x.s.name);
      const hallazgos: Hallazgo[] = [];
      if (sinFicha.length) hallazgos.push({ clave: 'skills-sin-ficha', severidad: sinFicha.length / skills.length > 0.2 ? 'media' : 'baja', titulo: `${sinFicha.length} skills del equipo no están en la biblioteca`, evidencia: `Sin ficha: ${sinFicha.slice(0, 30).join(', ')}${sinFicha.length > 30 ? '…' : ''}.`, propuesta: 'Ingerir sus repos con el Karajan nativo (`/resources/ingest-url`) para tener estrellas y taxonomía.' });
      if (con.length && heredadas / con.length > 0.3) hallazgos.push({ clave: 'estrellas-heredadas', severidad: 'media', titulo: `El ${Math.round((heredadas / con.length) * 100)} % de las fichas tiene estrellas heredadas de su colección`, evidencia: `${heredadas} de ${con.length} skills con ficha solo tienen las estrellas del repo que las recoge, no las suyas.`, propuesta: 'Resolver el repo de origen de cada skill anidada (p. ej. obra/superpowers) y guardar sus estrellas propias antes de usarlas para decidir.' });
      return {
        muestra: skills.length, suficiente: skills.length > 0, hallazgos,
        metricas: { con_ficha: proporcion(con.length, skills.length), estrellas_propias: proporcion(propias, con.length), estrellas_heredadas: proporcion(heredadas, con.length), sin_grupo: proporcion(sinGrupo, con.length) },
        umbrales: { estrellas_heredadas: '≤ 0.3', sin_ficha: '≤ 20 %' },
      };
    },
  }],
};
