import type { Modo } from './modo';

/**
 * Modificador `eficiencia` (ponytail): mínimo código suficiente. Función pura sobre la instrucción que se delega.
 * DESACTIVADO en producción: fuera del modo desarrollo no aplica y devuelve la instrucción intacta. Idempotente (deja una marca),
 * conserva el texto original y añade como máximo `MAX_SOBRECOSTE_EFICIENCIA` caracteres. Aún no está conectado al delegador:
 * lo traerá un borrador, solo en desarrollo.
 */
export const SKILLS_EFICIENCIA = ['ponytail'];
export const MARCA_EFICIENCIA = '<!-- karajan:eficiencia -->';
export const MAX_SOBRECOSTE_EFICIENCIA = 400;
export interface TareaCtx { nivel: number; intencion: string }

const BLOQUE = [
  'Criterio de eficiencia (skill ponytail): la solución mínima, segura y suficiente.',
  '- Reutiliza lo que ya existe; no añadas abstracciones, opciones ni dependencias que la tarea no pida.',
  '- Cambia lo imprescindible y deja el resto como está.',
].join('\n');

/** ¿Aplica a esta tarea? Solo en desarrollo, niveles 1 a 3 con intención de implementar o corregir. */
export function aplica(modo: Modo, c: TareaCtx): boolean {
  return modo === 'desarrollo' && c.nivel <= 3 && (c.intencion === 'implement_feature' || c.intencion === 'diagnose_and_fix');
}

/** La instrucción con el bloque de eficiencia añadido al final; intacta si no aplica o si ya lo lleva. */
export function aplicar(instruccion: string, modo: Modo, c: TareaCtx): string {
  if (!aplica(modo, c) || instruccion.includes(MARCA_EFICIENCIA)) return instruccion;
  return `${instruccion}\n\n${MARCA_EFICIENCIA}\n${BLOQUE}`;
}
