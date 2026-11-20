import { CONFIG_ESPECIALISTAS, componerSkills, elegirEspecialista } from '../especialistas';
import type { Laboratorio } from '../laboratorio';

/** Contratos deterministas: no mide mejora de desempeño sin resultados revisados de producción. */
export const laboratorioEspecialistas: Laboratorio = { escenarios: [
  { id: 'composicion', tipo: 'contrato', descripcion: 'El paquete no elimina skills sueltas y los nombres repetidos conservan sus procedencias', ejecutar: () => {
    const u = componerSkills(['pdf'], ['PDF', 'docx'], ['docx', 'liteparse']);
    const correcto = u.skills.join(',') === 'pdf,docx,liteparse' && u.procedencias[0]!.origenes.length === 2;
    return { muestra: 1, suficiente: true, metricas: { composicion_correcta: Number(correcto) }, hallazgos: correcto ? [] : [{ clave: 'composicion', severidad: 'media', titulo: 'La composición pierde skills', evidencia: JSON.stringify(u), propuesta: 'Revisar componerSkills.' }] };
  } },
  { id: 'sin-cobertura', tipo: 'contrato', descripcion: 'Una biblioteca sin skills ejecutables no habilita especialistas', ejecutar: () => {
    const fallos = CONFIG_ESPECIALISTAS.agentes.filter((a) => elegirEspecialista(a.terminos[0]!, 'codex', [], CONFIG_ESPECIALISTAS, a.id) !== null).length;
    return { muestra: CONFIG_ESPECIALISTAS.agentes.length, suficiente: true, metricas: { sin_cobertura_seleccionados: fallos }, hallazgos: fallos ? [{ clave: 'cobertura', severidad: 'media', titulo: 'Se selecciona un paquete sin cobertura', evidencia: `${fallos} agentes`, propuesta: 'Exigir skills locales recuperables.' }] : [] };
  } },
] };
