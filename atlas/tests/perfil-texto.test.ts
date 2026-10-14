import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { describirPerfil, nivelesDe, perfilDesdeTexto } from '../src/perfil-texto';
import { Perfiles } from '../src/perfiles';
import { ID_PRESET_NIVEL, presetNivel } from '../src/reglas';

/** Perfil por nivel y configuración de un perfil con una frase. */
const niveles = (p: ReturnType<typeof presetNivel>, proveedor: string) => p.entities.find((e) => e.provider === proveedor)?.levels;

describe('preset por nivel', () => {
  it('Qwen N1–N2, Codex N3, Claude N4–N5, sin reglas y con descripción', () => {
    const p = presetNivel();
    assert.deepEqual(niveles(p, 'ollama-qwen'), ['level_1_simple', 'level_2_moderate']);
    assert.deepEqual(niveles(p, 'codex'), ['level_3_intermediate']);
    assert.deepEqual(niveles(p, 'claude-cli'), ['level_4_complex', 'level_5_critical']);
    assert.deepEqual(p.rules, []);
    assert.match(String(p.description), /50 %/);
    assert.equal(describirPerfil(p), 'Qwen (local): N1–N2 · Codex: N3 · Claude Code: N4–N5.');
  });
});

describe('niveles en una frase', () => {
  it('rangos, límites y palabras', () => {
    assert.deepEqual(nivelesDe('N1-N3'), [1, 2, 3]);
    assert.deepEqual(nivelesDe('de N2 a N4'), [2, 3, 4]);
    assert.deepEqual(nivelesDe('hasta N2'), [1, 2]);
    assert.deepEqual(nivelesDe('desde N4'), [4, 5]);
    assert.deepEqual(nivelesDe('lo sencillo'), [1, 2]);
    assert.deepEqual(nivelesDe('lo complejo y lo crítico'), [4, 5]);
    assert.deepEqual(nivelesDe('nada'), []);
  });
});

describe('perfil desde texto', () => {
  it('reparte niveles sin solaparlos y añade reglas por área', () => {
    const r = perfilDesdeTexto('Claude para lo complejo y lo crítico, Codex para backend y Qwen para lo sencillo y lo intermedio', presetNivel());
    assert.ok(r.entendido);
    assert.deepEqual(niveles(r.perfil, 'claude-cli'), ['level_4_complex', 'level_5_critical']);
    assert.deepEqual(niveles(r.perfil, 'ollama-qwen'), ['level_1_simple', 'level_2_moderate', 'level_3_intermediate']);
    assert.deepEqual(niveles(r.perfil, 'codex'), []);
    assert.equal(r.perfil.rules?.[0]?.domains?.[0], 'backend');
    assert.equal(r.perfil.rules?.[0]?.entity_id, 'nivel-codex');
  });

  it('quita un agente con «sin» y entiende la descripción explícita', () => {
    const r = perfilDesdeTexto('sin qwen. descripción: Solo agentes en la nube', presetNivel());
    assert.equal(r.perfil.entities.some((e) => e.provider === 'ollama-qwen'), false);
    assert.equal(r.perfil.description, 'Solo agentes en la nube');
    assert.deepEqual(r.cambios, ['Quita Qwen (local)']);
  });

  it('una frase sin agentes no cambia nada', () => {
    const r = perfilDesdeTexto('hazlo bonito', presetNivel());
    assert.equal(r.entendido, false);
    assert.deepEqual(r.cambios, []);
  });

  it('se guarda en el layout solo al aplicar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karajan-texto-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const p = new Perfiles(join(dir, 'routing_layout.json'));
    p.aplicarPresetNivel();
    const propuesta = p.desdeTexto('Claude para N3 a N5');
    assert.deepEqual(niveles(propuesta.perfil, 'claude-cli'), ['level_3_intermediate', 'level_4_complex', 'level_5_critical']);
    assert.deepEqual(niveles(p.leer().profiles.find((x) => x.id === ID_PRESET_NIVEL)!, 'claude-cli'), ['level_4_complex', 'level_5_critical']);
    p.desdeTexto('Claude para N3 a N5', { aplicar: true });
    const guardado = p.leer();
    assert.equal(guardado.default_profile_id, ID_PRESET_NIVEL);
    assert.deepEqual(niveles(guardado.profiles.find((x) => x.id === ID_PRESET_NIVEL)!, 'codex'), []);
  });
});
