import type { Hallazgo } from '../pasarela-borradores';
import type { ContextoLab, Laboratorio, Resultado } from '../laboratorio';
import { elegirTutores, precioMezcla, UMBRALES_TUTOR, valor, type CatalogoTutores, type ProveedorTutor } from '../tutor';

/**
 * Laboratorio del tutor: ¿la elección sale de datos frescos y se puede explicar? Un contrato sobre el catálogo que se usa AHORA:
 * existe, no está caducado (los agentes cambian cada semana), la elección es determinista (no depende del orden del catálogo) y
 * el elegido razona lo que se exige. No mide si el tutor enseña bien: eso lo dicen las notas de la tutoría.
 */
export interface ContextoTutor extends ContextoLab {
  catalogo(): CatalogoTutores | null;
  disponibles(): ProveedorTutor[];
  /** Proveedores que ahora no deben usarse de tutor (Claude sobre su umbral semanal). */
  excluir(): ProveedorTutor[];
  ahora(): number;
}

const clave = (c: CatalogoTutores | null, op: Parameters<typeof elegirTutores>[1]) => { const t = elegirTutores(c, op).tutor; return t ? `${t.proveedor}/${t.modelo}` : null; };

export const laboratorioTutor: Laboratorio<ContextoTutor> = {
  escenarios: [{
    id: 'seleccion', tipo: 'contrato', descripcion: 'Catálogo fresco, elección determinista y con el razonamiento exigido',
    ejecutar: (ctx): Resultado => {
      const c = ctx.catalogo();
      const op = { disponibles: ctx.disponibles(), excluir: ctx.excluir(), ahora: ctx.ahora() };
      const umbrales = { catalogo: `actualizado hace ≤ ${UMBRALES_TUTOR.edadMaximaDias} días`, razonamiento: `≥ ${UMBRALES_TUTOR.razonamientoRelativoMin * 100} % del mejor de su proveedor`, determinismo: 'misma elección con el catálogo en cualquier orden' };
      if (!c || !c.modelos.length) return { muestra: 0, suficiente: false, metricas: { catalogo: 0 }, umbrales, hallazgos: [{
        clave: 'sin-catalogo', severidad: 'media', titulo: 'No hay catálogo de tutores: la tutoría no tiene a quién llamar',
        evidencia: 'No existe `tutores.json` en la carpeta de datos o no se puede leer.',
        propuesta: 'Definir `ARTIFICIAL_ANALYSIS_API_KEY` y ejecutar `kj tutoria actualizar`; el servidor lo repite solo cada día.',
      }] };
      const s = elegirTutores(c, op);
      const hallazgos: Hallazgo[] = [];
      const alReves = clave({ ...c, modelos: [...c.modelos].reverse() }, op);
      const determinista = alReves === clave(c, op);
      if (!determinista) hallazgos.push({ clave: 'eleccion-no-determinista', severidad: 'alta', titulo: 'El tutor elegido depende del orden del catálogo', evidencia: `Con el catálogo del derecho sale ${clave(c, op)} y del revés ${alReves}.`, propuesta: 'Revisar el desempate de `elegirTutores` en `atlas/src/tutor.ts`: valor, razonamiento y nombre, en ese orden.' });
      if (s.tutor) {
        const techo = Math.max(...c.modelos.filter((m) => m.proveedor === s.tutor!.proveedor).map((m) => m.razonamiento));
        if (s.tutor.razonamiento < techo * UMBRALES_TUTOR.razonamientoRelativoMin) hallazgos.push({ clave: 'tutor-flojo', severidad: 'alta', titulo: 'El tutor elegido razona por debajo del mínimo exigido', evidencia: `${s.tutor.modelo} razona ${s.tutor.razonamiento} y el mejor de ${s.tutor.proveedor} ${techo}.`, propuesta: 'Corregir el filtro de razonamiento de `elegirTutores`.' });
      } else hallazgos.push({ clave: 'sin-tutor', severidad: 'media', titulo: 'Hay catálogo pero ningún tutor utilizable ahora', evidencia: s.avisos.join(' · '), propuesta: 'Comprobar que `claude` o `codex` están en el PATH y con sesión iniciada.' });
      if (s.obsoleto) hallazgos.push({ clave: 'catalogo-obsoleto', severidad: 'media', titulo: `El catálogo de tutores tiene más de ${UMBRALES_TUTOR.edadMaximaDias} días`, evidencia: `Última actualización ${c.actualizado}. Los modelos y precios cambian cada semana: el tutor puede ya no ser el de mejor relación.`, propuesta: 'Ejecutar `kj tutoria actualizar` y revisar por qué la actualización diaria del servidor no lo hizo (¿falta `ARTIFICIAL_ANALYSIS_API_KEY`?).' });
      return {
        muestra: c.modelos.length, suficiente: true, hallazgos, umbrales,
        metricas: { catalogo: 1, modelos: c.modelos.length, determinista: determinista ? 1 : 0, obsoleto: s.obsoleto ? 1 : 0, tutor_valor: s.tutor?.valor ?? null, tutor_razonamiento: s.tutor?.razonamiento ?? null, tutor_precio_mezcla: s.tutor?.precio_mezcla ?? null },
        detalle: { tutor: s.tutor, porProveedor: s.porProveedor, avisos: s.avisos, ranking: [...c.modelos].sort((a, b) => valor(b) - valor(a)).slice(0, 10).map((m) => ({ proveedor: m.proveedor, modelo: m.modelo, razonamiento: m.razonamiento, precio_mezcla: Math.round(precioMezcla(m) * 1000) / 1000, valor: Math.round(valor(m) * 1000) / 1000 })) },
      };
    },
  }],
};
