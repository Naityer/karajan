import type { Modo } from './modo';

/**
 * Modificador `metodo` (superpowers): plan, TDD, ejecución y rama o worktree. Función pura sobre la instrucción que se delega.
 * DESACTIVADO en producción: fuera del modo desarrollo no aplica y devuelve la instrucción intacta. Idempotente (deja una marca),
 * conserva el texto original y añade como máximo `MAX_SOBRECOSTE_METODO` caracteres. Aún no está conectado al delegador:
 * lo traerá un borrador, solo en desarrollo.
 */
export const SKILLS_METODO = ['superpowers', 'test-driven-development', 'writing-plans', 'using-git-worktrees'];
export const MARCA_METODO = '<!-- karajan:metodo -->';
export const MAX_SOBRECOSTE_METODO = 600;
export interface TareaCtx { nivel: number; intencion: string }

const BLOQUE = [
  'Método de trabajo (skills de superpowers): plan, prueba y verificación.',
  '1. Escribe un plan corto antes de tocar código.',
  '2. Escribe primero la prueba que falla (TDD) y luego lo mínimo para que pase.',
  '3. Trabaja en la rama o worktree de la tarea, sin tocar otras.',
  '4. Verifica con las pruebas antes de dar la tarea por hecha.',
].join('\n');

/** ¿Aplica a esta tarea? Solo en desarrollo, niveles 3 a 5 con intención de implementar o corregir. */
export function aplica(modo: Modo, c: TareaCtx): boolean {
  return modo === 'desarrollo' && c.nivel >= 3 && (c.intencion === 'implement_feature' || c.intencion === 'diagnose_and_fix');
}

/** La instrucción con el bloque de método añadido al final; intacta si no aplica o si ya lo lleva. */
export function aplicar(instruccion: string, modo: Modo, c: TareaCtx): string {
  if (!aplica(modo, c) || instruccion.includes(MARCA_METODO)) return instruccion;
  return `${instruccion}\n\n${MARCA_METODO}\n${BLOQUE}`;
}
