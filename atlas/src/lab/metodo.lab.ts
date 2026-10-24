import { laboratorioModificador } from '../ab';
import { aplica, aplicar, MARCA_METODO, MAX_SOBRECOSTE_METODO, SKILLS_METODO } from '../metodo';

/** Laboratorio del modificador `metodo` (superpowers): contrato del transformador, A/B observacional y feedback (ver ab.ts). */
export const laboratorioMetodo = laboratorioModificador({
  id: 'metodo', nombre: 'método', skills: SKILLS_METODO,
  transformador: { marca: MARCA_METODO, maxSobrecoste: MAX_SOBRECOSTE_METODO, aplica, aplicar },
});
