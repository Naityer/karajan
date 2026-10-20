import type { Fetch, TareaAtlas } from '../src/atlas-dev';

/** Un Atlas dev de pega en memoria: la cola de tareas (`/operaciones/tareas`), para la pasarela, el modo y el laboratorio. */
export function atlasFalso(iniciales: Partial<TareaAtlas>[] = []) {
  const tareas = new Map<string, TareaAtlas>();
  let n = 0;
  const nueva = (t: Partial<TareaAtlas>): TareaAtlas => ({ id: t.id ?? `t${++n}`, titulo: t.titulo ?? '', estado: t.estado ?? 'borrador', agente: t.agente ?? '-', prompt: t.prompt ?? null, creada: t.creada ?? Date.now(), actualizada: t.actualizada ?? Date.now(), hoja: t.hoja ?? { agente: 'auto', skills: [] } });
  for (const t of iniciales) { const x = nueva(t); tareas.set(x.id, x); }
  const llamadas: { metodo: string; ruta: string; cuerpo: unknown }[] = [];
  const responder = (status: number, cuerpo: unknown) => ({ ok: status < 400, status, json: async () => cuerpo });
  const fetch: Fetch = async (url, init) => {
    const ruta = new URL(url).pathname, metodo = init?.method ?? 'GET';
    const cuerpo = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null;
    llamadas.push({ metodo, ruta, cuerpo });
    const id = /^\/operaciones\/tareas\/([^/]+)$/.exec(ruta)?.[1];
    if (ruta === '/operaciones/tareas' && metodo === 'GET') return responder(200, { tareas: [...tareas.values()] });
    if (ruta === '/operaciones/tareas' && metodo === 'POST') { const t = nueva({ titulo: String(cuerpo?.['titulo']), prompt: String(cuerpo?.['prompt']) }); tareas.set(t.id, t); return responder(200, t); }
    if (id && metodo === 'GET') { const t = tareas.get(id); return t ? responder(200, { tarea: t, eventos: [] }) : responder(404, { error: 'no' }); }
    if (id && metodo === 'PATCH') { const t = tareas.get(id)!; Object.assign(t, { titulo: cuerpo?.['titulo'], prompt: cuerpo?.['prompt'] }); return responder(200, t); }
    return responder(404, {});
  };
  return { fetch, tareas, llamadas };
}
