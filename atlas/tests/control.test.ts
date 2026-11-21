import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ejecutar } from '../src/cli';

type Pedida = { url: string; metodo: string; cuerpo: unknown };
const servidor = (rutas: Record<string, unknown>, pedidas: Pedida[]) => async (url: string, init?: { method?: string; body?: string }) => {
  const ruta = url.replace('http://k', '');
  pedidas.push({ url: ruta, metodo: init?.method ?? 'GET', cuerpo: init?.body ? JSON.parse(init.body) : null });
  const clave = Object.keys(rutas).sort((a, b) => b.length - a.length).find((r) => ruta.startsWith(r));
  return { ok: !!clave, status: clave ? 200 : 404, json: async () => (clave ? rutas[clave] : { detail: 'no' }) };
};
const correr = async (args: string[], rutas: Record<string, unknown>) => {
  let texto = '';
  const pedidas: Pedida[] = [];
  const codigo = await ejecutar(args, { fetch: servidor(rutas, pedidas), escribir: (x) => { texto += `${x}\n`; }, api: 'http://k' });
  return { codigo, texto, pedidas };
};

const ENTIDADES = [
  { id: 'claude', name: 'Claude Code', role: 'orquestador', provider: 'claude-cli', levels: ['level_5_critical', 'N4'], memberships: [{ group_id: 'g1' }], max_concurrent: 2, target_ids: ['codex'] },
  { id: 'codex', name: 'Codex', role: 'ejecutor', provider: 'codex', levels: ['level_3_intermediate'], parentId: 'claude', memberships: [{ group_id: 'g2' }] },
  { id: 'qwen', name: 'Qwen local', role: 'ejecutor', provider: 'qwen', levels: ['N1'], parent_id: 'claude', memberships: [{ group_id: 'g2' }] },
];
const LAYOUT = {
  entities: [], groups: [{ id: 'g1', name: 'Raíz' }, { id: 'g2', name: 'Ejecución' }], rules: [], active_profile_id: 'p2', default_profile_id: 'p1',
  profiles: [
    { id: 'p1', name: 'Producción', entities: ENTIDADES, rules: [{ id: 'r1', entity_id: 'qwen', domains: ['docs'], level_max: 2 }, { id: 'r2', entity_id: 'codex', enabled: false }] },
    { id: 'p2', name: 'Pruebas', entities: [ENTIDADES[0]] },
  ],
};
const TAREAS = [
  { task_id: 'aaaaaaaaaaaaaaaa', status: 'completed', created_at: '2026-11-05T09:00:00', classification: { complexity_level: 2, recommended_model: 'qwen' } },
  { task_id: 'bbbbbbbbbbbbbbbb', status: 'pending', created_at: '2026-11-05T10:00:00', classification: { complexity_level: 5, recommended_model: 'claude-cli', requires_human_review: true, domain: ['seguridad'] } },
];
const DOS = {
  modo: 'normal', burn: 0.8, agotamiento: null, circuitos: { codex: true }, en_vuelo: [{}],
  agentes: { codex: { usadoPct: 62, usadoSesionPct: 10, presupuestoPct: 70, modo: 'normal', disponible: true, retrasoMin: 0 }, 'claude-cli': { usadoPct: null, usadoSesionPct: null, presupuestoPct: null, modo: 'normal', disponible: true, retrasoMin: 0 } },
};

describe('kj control (módulo)', () => {
  it('mapa: zonas con su carga y cuota, y actividad reciente', async () => {
    const r = await correr(['control', 'mapa'], { '/routing-layout': LAYOUT, '/agents/performance': [{ provider_name: 'codex', task_count: 9, error_count: 1, avg_latency_ms: 10, total_cost: 1 }], '/dosificador/estado': DOS, '/tasks': TAREAS });
    assert.match(r.texto, /Control · mapa {2}· {2}perfil Producción · 3 agentes/);
    assert.match(r.texto, /Zona · Ejecución/);
    assert.match(r.texto, /Codex +│ ejecutor +│ codex +│ N3 +│ +9 +│ +1 +│ 62 %/);
    assert.match(r.texto, /bbbbbbbbbb {2}pending +N5 → claude-cli {2}⚑ revisión/);
  });

  it('jerarquia: árbol por padre (parentId o parent_id), vigilancias y reglas; --perfil elige otro', async () => {
    const r = await correr(['control', 'jerarquia'], { '/routing-layout': LAYOUT });
    assert.match(r.texto, /Perfil Producción {2}\(p1\)\n└─ Claude Code {2}orquestador · claude-cli · N5\/N4 · ×2 · vigila: codex\n {3}├─ Codex {2}ejecutor/);
    assert.match(r.texto, /└─ Qwen local/);
    assert.match(r.texto, /r1 +│ on +│ qwen +│ docs +│ \* +│ 1-2/);
    assert.match(r.texto, /r2 +│ off/);
    assert.match((await correr(['control', 'jerarquia', '--perfil', 'p2'], { '/routing-layout': LAYOUT })).texto, /Perfil Pruebas/);
  });

  it('perfiles, proveedores, revisiones y cuota', async () => {
    assert.match((await correr(['control', 'perfiles'], { '/routing-layout': LAYOUT })).texto, /p1 +│ Producción +│ +3 +│ +2 +│ ejecuta\np2 +│ Pruebas +│ +1 +│ +0 +│ editando/);
    const p = await correr(['control', 'proveedores'], { '/providers': [{ nombre: 'codex', etiqueta: 'Codex', gratis: false, disponible: true, motivo: null }, { nombre: 'qwen', etiqueta: 'Qwen', gratis: true, disponible: false, motivo: 'no está en el PATH' }] });
    assert.match(p.texto, /1 de 2 disponibles/);
    assert.match(p.texto, /qwen +│ Qwen +│ sí +│ no disponible +│ no está en el PATH/);
    const rv = await correr(['control', 'revisiones'], { '/tasks': TAREAS });
    assert.match(rv.texto, /1 esperan revisión humana/);
    assert.match(rv.texto, /bbbbbbbbbbbb +│ N5/);
    assert.doesNotMatch(rv.texto, /aaaaaaaaaaaa/);
    const c = await correr(['control', 'cuota'], { '/dosificador/estado': DOS });
    assert.match(c.texto, /codex · semana · CIRCUITO ABIERTO · normal/);
    assert.match(c.texto, /62 %/);
    assert.match(c.texto, /1 tareas en vuelo/);
  });

  it('estado resume modo, proveedores, dosificador, borradores y revisiones', async () => {
    const r = await correr(['control', 'estado'], { '/laboratorio/modo': { modo: 'produccion' }, '/providers': [{ nombre: 'codex', etiqueta: 'Codex', gratis: false, disponible: true, motivo: null }], '/dosificador/estado': DOS, '/laboratorio/propuestas': [{}, {}], '/tasks': TAREAS });
    assert.match(r.texto, /Karajan en PRODUCCION/);
    assert.match(r.texto, /proveedores listos +│ 1\/1/);
    assert.match(r.texto, /dosificador +│ normal/);
    assert.match(r.texto, /borradores abiertos +│ +2/);
  });

  it('estado comunica el fallo de una fuente en vez de inventar su valor', async () => {
    await assert.rejects(correr(['control', 'estado'], { '/laboratorio/modo': { modo: 'produccion' }, '/providers': [], '/laboratorio/propuestas': [], '/tasks': TAREAS }), /No se puede consultar \/dosificador\/estado: 404/);
  });

  it('mision planifica sin ejecutar; con --ejecutar delega; sin texto es error de uso', async () => {
    const plan = { task_id: 't1', status: 'planned', bloqueada: null, clasificacion: { complexity_level: 3, domain: ['backend'], intent: 'fix', criteria: { risk: 3 }, recommended_skills: ['tdd'], requires_human_review: false }, asignaciones: [{ subtarea: 's1', nombre: 'arreglar', proveedor: 'codex', modelo: 'gpt', regla: 'r1', motivo: 'perfil' }] };
    const sol = await correr(['control', 'mision', 'arregla', 'el', 'bug'], { '/routing/plan': plan, '/delegate-task': plan });
    assert.match(sol.texto, /Control · misión \(plan, sin ejecutar\) {2}· {2}N3 · backend · fix/);
    assert.match(sol.texto, /arreglar +│ codex +│ gpt +│ r1 +│ perfil/);
    assert.deepEqual(sol.pedidas.map((p) => [p.url, p.metodo, p.cuerpo]), [['/routing/plan', 'POST', { prompt: 'arregla el bug' }]]);
    const ej = await correr(['control', 'mision', 'x', '--ejecutar'], { '/routing/plan': plan, '/delegate-task': plan });
    assert.match(ej.texto, /misión delegada/);
    assert.equal(ej.pedidas[0]!.url, '/delegate-task');
    await assert.rejects(correr(['control', 'mision'], {}), /uso: kj control mision/);
  });

  it('--json entrega el panel para la interfaz', async () => {
    const j = JSON.parse((await correr(['control', 'perfiles', '--json'], { '/routing-layout': LAYOUT })).texto);
    assert.equal(j.origen, 'control');
    assert.equal(j.datos.length, 2);
  });
});
