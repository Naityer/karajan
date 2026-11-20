import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONFIG_ESPECIALISTAS, componerSkills, cobertura, elegirEspecialista, inventarioConCache, prepararEspecialista } from '../src/especialistas';
import { ConfiguracionEspecialistas, validarEspecialistas } from '../src/especialistas-config';
import { Almacen } from '../src/almacen';
import { Delegador } from '../src/delegar';
import { Perfiles } from '../src/perfiles';
import { proveedor } from '../src/proveedores';
import { ejecutar } from '../src/cli';
import { Rotador } from '../src/rotador';
import { descubrirSkills } from '../src/skills-seleccion';

const dir = mkdtempSync(join(tmpdir(), 'karajan-especialistas-'));
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite en Windows */ } });
const skill = (name: string) => ({ name, description: name, instaladaEn: ['codex'], enAlmacen: [] as string[] });
const cat = [skill('graphify'), { ...skill('networkx'), instaladaEn: [], enAlmacen: ['agents'] }, skill('pdf')];
const config = () => { const c = structuredClone(CONFIG_ESPECIALISTAS); c.agentes.find((a) => a.id === 'grafos')!.modelos['codex'] = 'modelo-grafos'; return c; };

describe('especialistas: selección y composición', () => {
  it('el análisis documenta cada entrada de la instantánea y corresponde al catálogo versionado', () => {
    const raiz = resolve(import.meta.dirname, '../..');
    const analisis = JSON.parse(readFileSync(join(raiz, 'docs/especialistas-inventario.json'), 'utf8'));
    assert.equal(analisis.total, 971); assert.equal(analisis.entradas.length, analisis.total);
    assert.equal(new Set(analisis.entradas.map((e: { slug: string }) => e.slug)).size, analisis.total);
    assert.ok(analisis.entradas.every((e: { estado: string; motivo: string }) => e.estado && e.motivo));
    assert.deepEqual(analisis.paquetes.map((p: { id: string }) => p.id), CONFIG_ESPECIALISTAS.agentes.map((a) => a.id));
    const hash = createHash('sha256').update(readFileSync(join(raiz, 'atlas/src/especialistas-catalogo.ts'), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    assert.equal(analisis.catalogo_sha256, hash);
  });
  it('valida el catálogo completo y exige cobertura en todos sus paquetes', () => {
    const c = validarEspecialistas(CONFIG_ESPECIALISTAS);
    assert.equal(c.agentes.length, 40);
    for (const a of c.agentes) {
      assert.equal(cobertura(a, []).viable, false, a.id);
      assert.equal(cobertura(a, a.skills.map(skill)).viable, true, a.id);
      assert.equal(elegirEspecialista(a.terminos[0]!, 'codex', a.skills.map(skill), c, a.id)?.id, a.id);
    }
  });
  it('selecciona un paquete recuperable y conserva las sugerencias y elecciones sueltas', () => {
    const e = elegirEspecialista('Analiza grafos', 'codex', cat, config())!;
    assert.equal(e.id, 'grafos'); assert.equal(e.modelo, 'modelo-grafos');
    const u = componerSkills(['PDF'], ['pdf', 'graphify'], e.skills);
    assert.deepEqual(u.skills, ['PDF', 'graphify', 'networkx']);
    assert.deepEqual(u.procedencias[0]!.origenes, ['persona', 'sugerencia']);
    assert.deepEqual(u.procedencias[1]!.origenes, ['sugerencia', 'especialista']);
  });
  it('no selecciona por fragmentos, ausencia, desactivación, empate o proveedor incompatible', () => {
    for (const texto of ['renombra una variable', 'fotografos']) assert.equal(elegirEspecialista(texto, 'codex', cat, config()), null);
    assert.equal(elegirEspecialista('grafos', 'codex', cat.slice(0, 1), config()), null);
    assert.equal(elegirEspecialista('grafos', 'ollama-qwen', cat, config()), null);
    assert.equal(elegirEspecialista('grafos', 'codex', cat, { ...config(), activo: false }), null);
    assert.equal(elegirEspecialista('grafos', 'codex', cat, config(), 'ninguno'), null);
    const c = config(); c.agentes.push({ ...c.agentes.find((a) => a.id === 'grafos')!, id: 'empate' });
    assert.equal(elegirEspecialista('grafos', 'codex', cat, c), null);
    c.automatico = false;
    assert.equal(elegirEspecialista('grafos', 'codex', cat, c), null);
    assert.equal(elegirEspecialista('otra cosa', 'codex', cat, c, 'grafos')?.id, 'grafos');
  });
  it('no bloquea por fallo de preparación ni confunde preparación con uso', () => {
    const e = elegirEspecialista('grafos', 'codex', cat, config())!;
    assert.equal(prepararEspecialista(e, () => { throw new Error('fallo de disco'); }), false);
    assert.equal(prepararEspecialista(e, () => ({ disponible: false })), false);
  });
  it('reutiliza el inventario, invalida y no conserva un snapshot obsoleto al fallar', () => {
    let n = 0, ahora = 0, falla = false;
    const cache = inventarioConCache(() => { n++; if (falla) throw new Error('disco'); return cat; }, 100, () => ahora);
    cache.leer(); cache.leer(); assert.equal(n, 1);
    ahora = 101; cache.leer(); assert.equal(n, 2);
    cache.invalidar(); falla = true; assert.throws(cache.leer, /disco/);
    falla = false; cache.leer(); assert.equal(n, 4);
  });
  it('valida configuración, guarda atómicamente y degrada ante corrupción sin respaldo', () => {
    const ruta = join(dir, 'config.json'), cfg = new ConfiguracionEspecialistas(ruta);
    assert.equal(cfg.leer().agentes.length, 40);
    cfg.guardar(config()); cfg.guardar({ ...config(), automatico: false });
    writeFileSync(ruta, '{roto'); assert.equal(cfg.leer().automatico, true);
    writeFileSync(`${ruta}.bak`, '{roto'); assert.equal(cfg.leer().activo, false);
    assert.throws(() => validarEspecialistas({ ...config(), agentes: [config().agentes[0], config().agentes[0]] }), /repetido/);
    const mal = config(); mal.agentes[0]!.modelos['codex'] = '--argumento'; assert.throws(() => validarEspecialistas(mal), /modelo/);
  });
});

describe('delegación especializada conserva la base', () => {
  it('repone el paquete y una sugerencia suelta con el rotador real antes de ejecutar', async () => {
    const casa = mkdtempSync(join(dir, 'rotador-real-'));
    for (const nombre of ['graphify', 'networkx', 'pdf']) {
      const ruta = join(casa, '.karajan', 'skills-almacen', 'agents', nombre);
      mkdirSync(ruta, { recursive: true });
      writeFileSync(join(ruta, 'SKILL.md'), `---\nname: ${nombre}\ndescription: ${nombre}\n---\nInstrucciones de prueba.`);
    }
    const rotador = new Rotador({ casa, estado: join(casa, 'rotador.json') });
    const almacen = new Almacen(join(casa, 'tasks.db')), perfiles = new Perfiles(join(casa, 'layout.json'));
    after(() => almacen.cerrar());
    perfiles.aplicarPresetDominio();
    let ejecutadas = 0;
    const delegador = new Delegador({ almacen, perfiles, config: () => null as never, raiz: casa, aislarGit: false, limites: () => null, rotador, skillsDisponibles: () => descubrirSkills(casa), especialistas: config,
      ejecutor: async (_p, modelo, texto) => {
        ejecutadas++;
        assert.equal(modelo, ejecutadas === 1 ? 'modelo-grafos' : 'default');
        for (const nombre of ['pdf', 'graphify', 'networkx']) {
          assert.ok(existsSync(join(casa, '.codex', 'skills', nombre, 'SKILL.md')), nombre);
          if (ejecutadas === 1) assert.ok(texto.includes(nombre), nombre);
        }
        return { salida: 'ok', error: null, latenciaMs: 1, modelo };
      },
    });
    const p = delegador.delegar('Analiza grafos usando pdf', { forzarEntidad: 'dominio-codex', especialista: 'grafos', aprobada: true });
    await Promise.all([...delegador.pendientes]);
    assert.equal(ejecutadas, p.asignaciones.length);
    assert.ok(ejecutadas >= 1);
    assert.equal(almacen.tarea(p.task_id)!.status, 'completed');
    assert.deepEqual(Object.keys(rotador.leerEstado().repuestas).sort(), ['graphify', 'networkx', 'pdf']);
    assert.deepEqual(rotador.leerEstado().usos, {}); // preparar no acredita uso confirmado
  });
  function montar(fallar?: string, excepcion = false) {
    const d = mkdtempSync(join(dir, 'deleg-')), almacen = new Almacen(join(d, 'tasks.db')), perfiles = new Perfiles(join(d, 'layout.json'));
    perfiles.aplicarPresetDominio(); after(() => almacen.cerrar());
    const llamadas: { modelo: string; texto: string }[] = [], preparaciones: string[] = [];
    const delegador = new Delegador({ almacen, perfiles, config: () => null as never, raiz: d, aislarGit: false, limites: () => null, skillsDisponibles: () => cat, especialistas: config,
      disponible: (p) => ({ nombre: p.nombre, etiqueta: p.nombre, gratis: false, disponible: true, ruta: 'x', motivo: null, login: '' }),
      rotador: { asegurar: (n: string) => { preparaciones.push(n); if (excepcion && n === fallar) throw new Error('disco'); return { disponible: n !== fallar, repuesta: n === 'networkx', motivo: 'prueba' }; } } as never,
      ejecutor: async (_p, modelo, texto) => { llamadas.push({ modelo, texto }); return { salida: 'ok', error: null, latenciaMs: 1, modelo }; },
    });
    return { delegador, almacen, llamadas, preparaciones };
  }
  it('ejecuta con modelo, paquete y sugerencia suelta, con trazabilidad', async () => {
    const m = montar(); const p = m.delegador.delegar('Analiza grafos usando pdf', { forzarEntidad: 'dominio-codex', especialista: 'grafos', aprobada: true });
    await Promise.all([...m.delegador.pendientes]);
    assert.equal(p.asignaciones[0]!.especialista?.id, 'grafos');
    assert.equal(m.llamadas[0]!.modelo, 'modelo-grafos');
    for (const n of ['pdf', 'graphify', 'networkx']) assert.ok(m.llamadas[0]!.texto.includes(n));
    assert.ok(m.almacen.decisiones(p.task_id).some((d) => d['decision'] === 'especialista:grafos'));
  });
  for (const excepcion of [false, true]) it(`recupera modelo y sugerencias originales al fallar el paquete (${excepcion ? 'excepción' : 'ausente'})`, async () => {
    const m = montar('networkx', excepcion); const p = m.delegador.delegar('Analiza grafos usando pdf', { forzarEntidad: 'dominio-codex', especialista: 'grafos', aprobada: true });
    await Promise.all([...m.delegador.pendientes]);
    assert.equal(m.llamadas[0]!.modelo, 'default'); assert.ok(m.llamadas[0]!.texto.includes('pdf')); assert.ok(!m.llamadas[0]!.texto.includes('graphify'));
    assert.ok(m.almacen.decisiones(p.task_id).some((d) => d['decision'] === 'especialista:respaldo:grafos'));
  });
  it('no elimina un bloqueo original por una skill suelta que falta', async () => {
    const m = montar('pdf'); const p = m.delegador.delegar('Usa pdf', { forzarEntidad: 'dominio-codex', especialista: 'ninguno', aprobada: true });
    await Promise.all([...m.delegador.pendientes]); assert.ok(m.llamadas.every((l) => !l.texto.includes('Skills preparadas'))); assert.equal(m.almacen.tarea(p.task_id)!.status, 'failed');
  });
  it('Codex recibe el modelo concreto sin modificar el modo default', () => {
    assert.ok(proveedor('codex')!.args('gpt-modelo').includes('gpt-modelo'));
    assert.ok(!proveedor('codex')!.args('default').includes('--model'));
  });
  it('la CLI transmite el especialista explícito sin contaminar el prompt', async () => {
    let cuerpo: Record<string, unknown> = {};
    await ejecutar(['control', 'mision', 'Analiza el conjunto', '--especialista', 'grafos', '--json'], { api: 'http://local', escribir: () => {}, fetch: async (_u, op) => {
      cuerpo = JSON.parse(op?.body ?? '{}'); return { ok: true, status: 200, json: async () => ({ clasificacion: {}, asignaciones: [], bloqueada: null }) };
    } });
    assert.equal(cuerpo['especialista'], 'grafos'); assert.equal(cuerpo['prompt'], 'Analiza el conjunto');
  });
});
