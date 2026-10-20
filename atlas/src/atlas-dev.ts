/**
 * Cliente mínimo de la API local de Atlas dev (`ATLAS_DEV_API`, por defecto 127.0.0.1:4100), con el mismo token que usa su CLI
 * `at` (`ATLAS_DEV_TOKEN` → cabecera `x-atlas-dev-token`). Lo usan el modo producción (¿la tarea está aceptada?), la pasarela de
 * borradores y el laboratorio (tareas reales). `fetch` se puede sustituir en los tests.
 */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TareaAtlas {
  id: string; titulo: string; estado: string; agente: string; prompt: string | null; creada: number; actualizada: number;
  hoja?: { agente?: string; skills?: string[]; revisada?: boolean; clasificacion?: Record<string, string[]> } | null;
}

export class AtlasDev {
  constructor(private readonly base = process.env['ATLAS_DEV_API'] ?? 'http://127.0.0.1:4100', private readonly fetcher: Fetch = fetch as unknown as Fetch) {}

  private async pedir(ruta: string, metodo = 'GET', cuerpo?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env['ATLAS_DEV_TOKEN']) headers['x-atlas-dev-token'] = process.env['ATLAS_DEV_TOKEN'];
    const r = await this.fetcher(`${this.base.replace(/\/$/, '')}${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Atlas dev respondió ${r.status} a ${metodo} ${ruta}`);
    return r.json();
  }

  async tarea(id: string): Promise<TareaAtlas | null> {
    const r = (await this.pedir(`/operaciones/tareas/${encodeURIComponent(id)}`)) as { tarea?: TareaAtlas } | null;
    return r?.tarea ?? null;
  }

  async tareas(limite = 1000): Promise<TareaAtlas[]> {
    return ((await this.pedir(`/operaciones/tareas?limite=${limite}`)) as { tareas?: TareaAtlas[] } | null)?.tareas ?? [];
  }

  async crearBorrador(titulo: string, prompt: string): Promise<TareaAtlas> {
    return (await this.pedir('/operaciones/tareas', 'POST', { titulo, prompt, accion: 'borrador' })) as TareaAtlas;
  }

  async editarBorrador(id: string, titulo: string, prompt: string): Promise<TareaAtlas> {
    return (await this.pedir(`/operaciones/tareas/${encodeURIComponent(id)}`, 'PATCH', { titulo, prompt })) as TareaAtlas;
  }
}
