import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AtlasDev } from './atlas-dev';
import type { Pasarela } from './pasarela-borradores';

/**
 * Modo producción de Karajan. Con él (el estado por defecto del paquete), nada cambia su configuración —perfiles, reglas, skills
 * instaladas— si la petición no trae el id de una tarea de Atlas dev ya ACEPTADA (encolada o en marcha), en la cabecera
 * `x-karajan-tarea` o en `body.tarea`. Sin ella responde 423 y deja la mutación pedida como borrador, para que no se pierda.
 *
 * El modo vive en `<datos>/modo.json` (`{"modo":"produccion"}` o `{"modo":"desarrollo"}`) y NO se cambia por API: solo editando
 * el fichero a mano. El Karajan nativo (Python) lee el mismo fichero.
 */
export type Modo = 'produccion' | 'desarrollo';
export const ESTADOS_ACEPTADA = new Set(['encolada', 'ejecutando']);

export function leerModo(dirDatos: string): Modo {
  try {
    const m = (JSON.parse(readFileSync(join(dirDatos, 'modo.json'), 'utf8')) as { modo?: unknown }).modo;
    return m === 'desarrollo' ? 'desarrollo' : 'produccion';
  } catch { return 'produccion'; }
}

export interface PeticionMutacion { headers?: Record<string, string | string[] | undefined>; body?: unknown }
const bloqueo = (detail: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(detail), { status: 423, extra });

export class Guardian {
  constructor(private readonly dirDatos: string, private readonly atlas: AtlasDev, private readonly pasarela: Pasarela) {}

  modo(): Modo { return leerModo(this.dirDatos); }

  static tareaDe(req: PeticionMutacion): string | null {
    const h = req.headers?.['x-karajan-tarea'];
    const cab = Array.isArray(h) ? h[0] : h;
    const cuerpo = (req.body as { tarea?: unknown } | null | undefined)?.tarea;
    const id = (cab ?? (typeof cuerpo === 'string' ? cuerpo : '')).trim();
    return /^[\w-]{1,40}$/.test(id) ? id : null;
  }

  /**
   * Deja pasar la mutación en desarrollo o con una tarea aceptada; si no, la registra como borrador y lanza 423.
   * `accion` describe la mutación («PUT /routing-layout», …) para el borrador.
   */
  async exigir(req: PeticionMutacion, accion: string): Promise<{ modo: Modo; tarea: string | null }> {
    if (this.modo() === 'desarrollo') return { modo: 'desarrollo', tarea: null };
    const id = Guardian.tareaDe(req);
    if (id) {
      const t = await this.atlas.tarea(id).catch(() => null);
      if (t && ESTADOS_ACEPTADA.has(t.estado)) return { modo: 'produccion', tarea: id };
    }
    const cuerpo = JSON.stringify(req.body ?? null, null, 2).slice(0, 6000);
    // Un borrador por cambio distinto (acción + cuerpo): repetir la misma petición no abre otro.
    const p = await this.pasarela.proponer('modo', {
      clave: `mutacion:${accion.replace(/[^\w/-]+/g, '-')}:${createHash('sha256').update(cuerpo).digest('hex').slice(0, 10)}`, severidad: 'media',
      titulo: `Cambio pedido en producción: ${accion}`,
      evidencia: `Se intentó \`${accion}\` sin una tarea aceptada${id ? ` (la tarea ${id} no está encolada ni en marcha)` : ''}. Cuerpo de la petición:\n\n\`\`\`json\n${cuerpo}\n\`\`\``,
      propuesta: `Si el cambio es correcto, acepta esta tarea: el agente lo aplicará repitiendo la petición con la cabecera \`x-karajan-tarea: <id de esta tarea>\`.`,
      criterios: ['El cambio se aplica con la tarea aceptada (cabecera `x-karajan-tarea`).', '`kj lab run todos` no empeora respecto a la ejecución anterior.'],
    });
    throw bloqueo(`Karajan está en producción: «${accion}» necesita una tarea aceptada de Atlas dev (cabecera x-karajan-tarea). ${p.tarea ? `Queda propuesto como borrador ${p.tarea}.` : 'No se pudo abrir el borrador.'}`, { borrador: p.tarea });
  }
}
