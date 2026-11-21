import base from './perfil-base.json';

import type { Perfil } from './reglas';

/**
 * Perfil base `base-2026-11-12`: una entidad por modelo (Claude Haiku/Sonnet/Opus/Fable, Codex Terra/Luna/Sol/Astra, Gemini y local)
 * con su ficha de aptitud sobre la puntuación continua 0–5. Los datos viven en `perfil-base.json`, generado desde
 * `app/routing/perfil_base.py` (un test de Python comprueba que son idénticos), así que no hay dos copias que mantener a mano.
 * Las cifras son hipótesis (`medido: false`) hasta que haya laboratorios; la evolución las ajusta con métricas.
 *
 * En el paquete solo se ejecutan los proveedores CLI (Claude, Codex y Qwen local): las entidades de Gemini se saltan al puntuar y
 * lo suyo cae en la siguiente mejor puntuada.
 */
export const ID_PRESET_BASE = base.id;

export function presetBase(id = ID_PRESET_BASE): Perfil {
  return { ...(JSON.parse(JSON.stringify(base)) as unknown as Perfil), id };
}
