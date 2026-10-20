import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AtlasDev } from './atlas-dev';

/**
 * Pasarela de borradores: la única salida de Karajan en producción para proponer un cambio. Un hallazgo `alta|media` se
 * convierte en una tarea BORRADOR de la cola de Atlas dev, con su especificación (evidencia, propuesta y criterios), para que la
 * persona la revise y la acepte o la descarte. Los `baja` se quedan en el informe.
 *
 * Idempotente por clave (`<componente>:<clave>`, registro en `borradores.json`): si el borrador sigue en borrador se actualiza;
 * si la persona lo descartó no se reabre; si ya se aceptó (encolada, en marcha o hecha) no se toca.
 * No usa `/vigilante/hallazgos` porque ese cierra las incidencias del repo que no vienen en el lote y chocaría con el vigilante
 * del repo karajan.
 */
export type Severidad = 'alta' | 'media' | 'baja';
export interface Hallazgo { clave: string; severidad: Severidad; titulo: string; evidencia: string; propuesta: string; criterios?: string[] }
export interface Propuesto { clave: string; tarea: string | null; accion: 'creada' | 'actualizada' | 'sin-cambios' | 'descartada-antes' | 'aceptada' | 'solo-informe' | 'error'; detalle?: string }
interface Registro { [clave: string]: { tarea: string; huella: string; creada: string } }

const huella = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h >>> 0); };

export function especificacion(componente: string, h: Hallazgo): string {
  const criterios = h.criterios?.length ? h.criterios : ['Reproduce la evidencia antes de cambiar nada.', 'Los tests del paquete (`npm test --prefix atlas`) pasan.', `Tras el cambio, \`kj lab run ${componente}\` ya no da este hallazgo.`];
  return [
    `# ${h.titulo}`, '',
    `Propuesta de Karajan (componente \`${componente}\`, severidad ${h.severidad}). Karajan está en producción: este cambio solo se aplica si aceptas esta tarea.`, '',
    '## Evidencia', '', h.evidencia || '(sin evidencia)', '',
    '## Propuesta', '', h.propuesta || 'Diagnostica la causa y propón el cambio mínimo.', '',
    '## Criterios', '', ...criterios.map((c) => `- ${c}`), '',
    `Origen: karajan:${componente}:${h.clave}`, '',
  ].join('\n');
}

export class Pasarela {
  constructor(private readonly atlas: AtlasDev, private readonly ruta: string) {}

  leer(): Registro { try { return JSON.parse(readFileSync(this.ruta, 'utf8')) as Registro; } catch { return {}; } }

  private guardar(r: Registro) {
    mkdirSync(dirname(this.ruta), { recursive: true });
    writeFileSync(`${this.ruta}.tmp`, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
    renameSync(`${this.ruta}.tmp`, this.ruta);
  }

  async proponer(componente: string, h: Hallazgo): Promise<Propuesto> {
    const clave = `${componente}:${h.clave}`;
    if (h.severidad === 'baja') return { clave, tarea: null, accion: 'solo-informe' };
    const titulo = `[karajan] ${h.titulo}`.slice(0, 200);
    const prompt = especificacion(componente, h);
    const registro = this.leer();
    const previa = registro[clave];
    try {
      if (previa) {
        const t = await this.atlas.tarea(previa.tarea);
        if (t?.estado === 'descartada') return { clave, tarea: previa.tarea, accion: 'descartada-antes' };
        if (t && t.estado !== 'borrador') return { clave, tarea: previa.tarea, accion: 'aceptada', detalle: t.estado };
        if (t && previa.huella === huella(titulo + prompt)) return { clave, tarea: previa.tarea, accion: 'sin-cambios' };
        if (t) {
          await this.atlas.editarBorrador(previa.tarea, titulo, prompt);
          registro[clave] = { ...previa, huella: huella(titulo + prompt) };
          this.guardar(registro);
          return { clave, tarea: previa.tarea, accion: 'actualizada' };
        }
        // La tarea ya no existe en Atlas dev: se vuelve a abrir.
      }
      const t = await this.atlas.crearBorrador(titulo, prompt);
      registro[clave] = { tarea: t.id, huella: huella(titulo + prompt), creada: new Date().toISOString() };
      this.guardar(registro);
      return { clave, tarea: t.id, accion: 'creada' };
    } catch (e) {
      return { clave, tarea: previa?.tarea ?? null, accion: 'error', detalle: String((e as Error).message ?? e) };
    }
  }

  /** Los borradores que abrió Karajan y en qué estado están ahora en Atlas dev. */
  async listar(): Promise<{ clave: string; tarea: string; creada: string; estado: string; titulo: string | null }[]> {
    const r = this.leer();
    return Promise.all(Object.entries(r).map(async ([clave, v]) => {
      const t = await this.atlas.tarea(v.tarea).catch(() => null);
      return { clave, tarea: v.tarea, creada: v.creada, estado: t?.estado ?? 'desconocida', titulo: t?.titulo ?? null };
    }));
  }
}
