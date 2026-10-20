import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Solo se leen nombre y descripción; el cuerpo de SKILL.md no entra en el prompt. */
export interface SkillDisponible { name: string; description: string; instaladaEn: string[]; enAlmacen: string[] }
const ALIAS: Record<string, string[]> = {
  'repo-analyzer': ['repositorio', 'repository', 'codebase'],
  'frontend-builder': ['frontend', 'interfaz', 'dashboard', 'react', 'css'],
  'backend-builder': ['backend', 'endpoint', 'api', 'base de datos'],
  'security-review': ['seguridad', 'security', 'vulnerabilidad', 'credenciales', 'secretos'],
  'webapp-testing': ['playwright', 'prueba e2e', 'pruebas de extremo a extremo'],
  pdf: ['pdf'], docx: ['docx', 'word'], pptx: ['pptx', 'powerpoint'], xlsx: ['xlsx', 'excel', 'hoja de calculo'],
  'skill-creator': ['crear una skill', 'crea una skill', 'modificar una skill'],
};
const STOP = new Set(['about', 'agent', 'agente', 'agentes', 'and', 'con', 'como', 'create', 'crear', 'de', 'del', 'el', 'en',
  'for', 'from', 'hacer', 'la', 'las', 'los', 'para', 'por', 'que', 'skill', 'skills', 'the', 'una', 'uno', 'use', 'usar', 'with', 'workflow', 'y']);
const normalizar = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const terminos = (s: string) => new Set((normalizar(s).match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t)));
const contiene = (texto: string, frase: string) => {
  const esc = normalizar(frase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(texto);
};

export function descubrirSkills(casa = homedir()): SkillDisponible[] {
  const vistas = new Map<string, SkillDisponible>();
  for (const [agente, carpeta] of [['claude', '.claude'], ['codex', '.codex'], ['agents', '.agents']]) {
    for (const [almacen, raiz] of [[false, join(casa, carpeta, 'skills')], [true, join(casa, '.karajan', 'skills-almacen', agente)]] as const) {
      if (!existsSync(raiz)) continue;
      for (const nombre of readdirSync(raiz)) {
        if (nombre.startsWith('.') || nombre.startsWith('_') || nombre.endsWith('.disabled')) continue;
        const ruta = join(raiz, nombre);
        try {
          if (!statSync(ruta).isDirectory() || !existsSync(join(ruta, 'SKILL.md'))) continue;
          const clave = nombre.toLowerCase();
          if (!vistas.has(clave)) {
            const cabecera = readFileSync(join(ruta, 'SKILL.md'), 'utf8').slice(0, 4096);
            const descripcion = /^description:\s*(.+)$/m.exec(cabecera)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
            vistas.set(clave, { name: nombre, description: descripcion, instaladaEn: [], enAlmacen: [] });
          }
          vistas.get(clave)![almacen ? 'enAlmacen' : 'instaladaEn'].push(agente);
        } catch { /* skill no legible */ }
      }
    }
  }
  return [...vistas.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pesos del ponderador. El laboratorio del selector los calibra y, si mejora, los propone como borrador (no se cambian solos). */
export interface PesosSelector { explicita: number; alias: number; porAlias: number; topeAlias: number; porNombre: number; porDescripcion: number; umbral: number }
export const PESOS_SELECTOR: Readonly<PesosSelector> = Object.freeze({ explicita: 100, alias: 35, porAlias: 2, topeAlias: 10, porNombre: 11, porDescripcion: 2, umbral: 15 });

/** Cada skill que pasa el umbral, con sus puntos, en el orden en que se eligen. */
export function puntuarSkills(prompt: string, catalogo: SkillDisponible[], pesos: PesosSelector = PESOS_SELECTOR): { nombre: string; puntos: number }[] {
  const texto = normalizar(prompt), q = terminos(prompt);
  const filas: [number, number, number, string][] = [];
  for (const s of catalogo) {
    let puntos: number;
    const explicita = contiene(texto, s.name);
    let posicion = explicita ? texto.indexOf(normalizar(s.name)) : texto.length;
    if (explicita) puntos = pesos.explicita;
    else {
      const alias = (ALIAS[s.name] ?? []).filter((a) => contiene(texto, a));
      for (const a of alias) posicion = Math.min(posicion, texto.indexOf(normalizar(a)));
      const nombres = [...terminos(s.name)].filter((t) => q.has(t));
      const descripcion = [...terminos(s.description.slice(0, 1000))].filter((t) => q.has(t));
      puntos = (alias.length ? pesos.alias + Math.min(pesos.topeAlias, alias.length * pesos.porAlias) : 0) + nombres.length * pesos.porNombre + descripcion.length * pesos.porDescripcion;
      if (s.name.startsWith('source-command-') && !alias.length) puntos = 0;
    }
    if (puntos >= pesos.umbral) filas.push([s.name === 'repo-analyzer' ? 0 : s.name === 'security-review' ? 2 : 1, posicion, -puntos, s.name]);
  }
  filas.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
  return filas.map((x) => ({ nombre: x[3], puntos: -x[2] }));
}

export function seleccionarSkills(prompt: string, catalogo: SkillDisponible[], limite = 3, pesos: PesosSelector = PESOS_SELECTOR): string[] {
  return puntuarSkills(prompt, catalogo, pesos).slice(0, limite).map((x) => x.nombre);
}
