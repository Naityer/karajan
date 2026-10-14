import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Rotador } from '../src/rotador';

/** Una casa de pega: skills en ~/.claude/skills y ~/.codex/skills, un skills-uso.json de Atlas dev y el almacén vacío. */
const casa = mkdtempSync(join(tmpdir(), 'karajan-rotador-'));
after(() => rmSync(casa, { recursive: true, force: true }));
const AHORA = Date.UTC(2026, 9, 14);
const hace = (dias: number) => new Date(AHORA - dias * 86_400_000).toISOString();
const skill = (raiz: string, nombre: string) => { mkdirSync(join(casa, raiz, 'skills', nombre), { recursive: true }); writeFileSync(join(casa, raiz, 'skills', nombre, 'SKILL.md'), `# ${nombre}`); };

skill('.claude', 'diaria');        // usada hace 3 días → núcleo
skill('.claude', 'mensual');       // hace 30 → frecuente
skill('.claude', 'olvidada');      // hace 90 → al almacén
skill('.claude', 'nunca');         // sin uso → al almacén
skill('.claude', 'atlas');         // protegida aunque no se use
skill('.codex', 'olvidada');
mkdirSync(join(casa, '.claude', 'skills', '_apagada.disabled'), { recursive: true });
mkdirSync(join(casa, '.atlas-dev'), { recursive: true });
writeFileSync(join(casa, '.atlas-dev', 'skills-uso.json'), JSON.stringify({
  a: { skills: { diaria: { ultima: hace(3) }, 'plugin:mensual': { ultima: hace(30) } } },
  b: { skills: { olvidada: { ultima: hace(90) } } },
}));

const rotador = new Rotador({ casa, estado: join(casa, 'datos', 'rotador.json'), usoAtlas: join(casa, '.atlas-dev', 'skills-uso.json'), ahora: () => AHORA });

describe('rotador de skills', () => {
  it('clasifica por último uso (los plugins cuentan por su nombre) y respeta las protegidas', () => {
    const porNombre = Object.fromEntries(rotador.inventario().map((f) => [f.skill, f]));
    assert.equal(porNombre['diaria']!.nivel, 'nucleo');
    assert.equal(porNombre['mensual']!.nivel, 'frecuente');
    assert.equal(porNombre['olvidada']!.nivel, 'inactiva');
    assert.equal(porNombre['atlas']!.protegida, true);
    assert.equal(porNombre['_apagada.disabled'], undefined);
  });

  it('el plan retira las inactivas no protegidas de cada destino; aplicarlo las mueve al almacén sin borrarlas', () => {
    const plan = rotador.plan();
    assert.deepEqual(plan.retirar.map((r) => `${r.destino}/${r.skill}`).sort(), ['claude/nunca', 'claude/olvidada', 'codex/olvidada']);
    assert.deepEqual(plan.reponer, []);
    rotador.aplicar(plan);
    assert.equal(existsSync(join(casa, '.claude', 'skills', 'olvidada')), false);
    assert.equal(existsSync(join(casa, '.karajan', 'skills-almacen', 'claude', 'olvidada', 'SKILL.md')), true);
    assert.equal(existsSync(join(casa, '.claude', 'skills', 'atlas', 'SKILL.md')), true);
  });

  it('antes de delegar repone desde el almacén, la deja como instantánea y anota el uso', () => {
    const r = rotador.asegurar('olvidada', 'claude');
    assert.deepEqual(r, { disponible: true, repuesta: true, motivo: 'repuesta desde el almacén' });
    assert.equal(existsSync(join(casa, '.claude', 'skills', 'olvidada', 'SKILL.md')), true);
    // Recién usada: pasa a núcleo y ya no se retira.
    assert.equal(rotador.inventario().find((f) => f.skill === 'olvidada')!.nivel, 'nucleo');
    assert.equal(rotador.plan().retirar.some((x) => x.skill === 'olvidada' && x.destino === 'claude'), false);
    assert.equal(rotador.asegurar('no-existe', 'claude').disponible, false);
  });

  it('una skill instalada para otro agente se copia (no se mueve) al que la necesita', () => {
    skill('.claude', 'compartida');
    const r = rotador.asegurar('compartida', 'codex');
    assert.equal(r.repuesta, true);
    assert.equal(existsSync(join(casa, '.claude', 'skills', 'compartida', 'SKILL.md')), true);
    assert.equal(existsSync(join(casa, '.codex', 'skills', 'compartida', 'SKILL.md')), true);
  });
});
