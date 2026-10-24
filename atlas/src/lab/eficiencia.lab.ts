import { laboratorioModificador } from '../ab';
import { aplica, aplicar, MARCA_EFICIENCIA, MAX_SOBRECOSTE_EFICIENCIA, SKILLS_EFICIENCIA } from '../eficiencia';

/** Laboratorio del modificador `eficiencia` (ponytail): contrato del transformador, A/B observacional y feedback (ver ab.ts). */
export const laboratorioEficiencia = laboratorioModificador({
  id: 'eficiencia', nombre: 'eficiencia', skills: SKILLS_EFICIENCIA,
  transformador: { marca: MARCA_EFICIENCIA, maxSobrecoste: MAX_SOBRECOSTE_EFICIENCIA, aplica, aplicar },
});
