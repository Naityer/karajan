import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_ESPECIALISTAS, type ConfigEspecialistas } from './especialistas';

const copia = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const error = (m: string): never => { throw Object.assign(new Error(m), { status: 422 }); };
const modeloValido = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(v);
export function validarEspecialistas(v: unknown): ConfigEspecialistas {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return error('Configuración de especialistas no válida');
  const c = v as ConfigEspecialistas;
  if (typeof c.activo !== 'boolean' || typeof c.automatico !== 'boolean' || !Array.isArray(c.agentes) || c.agentes.length > 150) return error('Especialistas: activo, automatico y agentes son obligatorios');
  const ids = new Set<string>();
  for (const a of c.agentes) {
    if (!a || typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(a.id) || ids.has(a.id)) return error('Especialista: id inválido o repetido');
    ids.add(a.id);
    if (typeof a.nombre !== 'string' || !a.nombre.trim() || a.nombre.length > 120 || typeof a.ambito !== 'string' || !a.ambito.trim() || a.ambito.length > 1000 || typeof a.activo !== 'boolean') return error(`Especialista ${a.id}: nombre, ámbito o estado inválido`);
    if (!Array.isArray(a.skills) || a.skills.length < 2 || a.skills.length > 12 || a.skills.some((s) => typeof s !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(s)) || new Set(a.skills.map((s) => s.toLowerCase())).size !== a.skills.length) return error(`Especialista ${a.id}: necesita entre 2 y 12 skills distintas`);
    if (!Array.isArray(a.terminos) || !a.terminos.length || a.terminos.length > 30 || a.terminos.some((t) => typeof t !== 'string' || !t.trim() || t.length > 100)) return error(`Especialista ${a.id}: términos inválidos`);
    if (!a.modelos || typeof a.modelos !== 'object' || Array.isArray(a.modelos) || !Object.keys(a.modelos).length || Object.entries(a.modelos).some(([p, m]) => !['codex', 'claude-cli'].includes(p) || !modeloValido(m))) return error(`Especialista ${a.id}: proveedor o modelo inválido`);
  }
  return copia(c);
}

/** Ausencia = valores de fábrica; corrupción = respaldo, o componente desactivado. No sobrescribe el fichero roto. */
export class ConfiguracionEspecialistas {
  constructor(private readonly ruta: string) {}
  private intentar(ruta: string): ConfigEspecialistas | null { try { return validarEspecialistas(JSON.parse(readFileSync(ruta, 'utf8'))); } catch { return null; } }
  leer(): ConfigEspecialistas {
    if (!existsSync(this.ruta)) return copia(CONFIG_ESPECIALISTAS);
    return this.intentar(this.ruta) ?? this.intentar(`${this.ruta}.bak`) ?? { activo: false, automatico: false, agentes: [] };
  }
  guardar(bruto: unknown): ConfigEspecialistas {
    const c = validarEspecialistas(bruto);
    mkdirSync(dirname(this.ruta), { recursive: true });
    writeFileSync(`${this.ruta}.tmp`, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
    if (this.intentar(this.ruta)) copyFileSync(this.ruta, `${this.ruta}.bak`);
    renameSync(`${this.ruta}.tmp`, this.ruta);
    return c;
  }
}
