import type { Modo } from './modo';

/**
 * Modificador `prompts` (karpathy-skills, dspy, promptfoo): optimiza el prompt que recibe el agente con criterios de éxito
 * comprobables. Función pura sobre la instrucción que se delega. DESACTIVADO en producción: fuera del modo desarrollo no aplica
 * y devuelve la instrucción intacta. Idempotente (deja una marca), conserva el texto original y añade como máximo
 * `MAX_SOBRECOSTE_PROMPTS` caracteres. Aún no está conectado al delegador: lo traerá un borrador, solo en desarrollo.
 */
export const SKILLS_PROMPTS = ['karpathy-skills', 'dspy', 'promptfoo'];
export const MARCA_PROMPTS = '<!-- karajan:prompts -->';
export const MAX_SOBRECOSTE_PROMPTS = 500;
export interface TareaCtx { nivel: number; intencion: string }

const BLOQUE = [
  'Criterios del encargo (karpathy-skills, dspy, promptfoo): antes de empezar, di qué entiendes que se pide y qué lo daría por bueno.',
  '- Si algo es ambiguo, di tu suposición en vez de adivinar en silencio.',
  '- Cambios quirúrgicos: solo lo que el encargo pide.',
  '- Termina indicando cómo se comprueba que está hecho.',
].join('\n');

/** ¿Aplica a esta tarea? Solo en desarrollo y a partir del nivel 2 (una tarea trivial no necesita criterios). */
export function aplica(modo: Modo, c: TareaCtx): boolean {
  return modo === 'desarrollo' && c.nivel >= 2;
}

/** La instrucción con el bloque de criterios añadido al final; intacta si no aplica o si ya lo lleva. */
export function aplicar(instruccion: string, modo: Modo, c: TareaCtx): string {
  if (!aplica(modo, c) || instruccion.includes(MARCA_PROMPTS)) return instruccion;
  return `${instruccion}\n\n${MARCA_PROMPTS}\n${BLOQUE}`;
}
