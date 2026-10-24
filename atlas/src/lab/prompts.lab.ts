import { laboratorioModificador } from '../ab';
import { aplica, aplicar, MARCA_PROMPTS, MAX_SOBRECOSTE_PROMPTS, SKILLS_PROMPTS } from '../prompts';

/** Laboratorio del modificador `prompts` (karpathy-skills, dspy, promptfoo): contrato del transformador, A/B observacional y feedback (ver ab.ts). */
export const laboratorioPrompts = laboratorioModificador({
  id: 'prompts', nombre: 'prompts', skills: SKILLS_PROMPTS,
  transformador: { marca: MARCA_PROMPTS, maxSobrecoste: MAX_SOBRECOSTE_PROMPTS, aplica, aplicar },
});
