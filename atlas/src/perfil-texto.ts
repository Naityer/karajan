import type { Entidad, Perfil, Regla } from './reglas';

/**
 * Configurar un perfil con una frase («Claude para lo complejo, Codex para backend y lo intermedio, Qwen para lo sencillo»).
 * Intérprete determinista, sin LLM: reconoce agentes, niveles y áreas por cláusulas (separadas por comas, punto y coma, saltos
 * de línea o «y» delante de otro agente) y devuelve el perfil propuesto con la lista de cambios, sin guardar nada. Un nivel que
 * se asigna a un agente se le quita a los demás (cada nivel lo atiende uno); un área crea una regla que va delante de las
 * anteriores. «sin X» / «quita X» saca a ese agente del perfil. «descripción: …» fija la descripción; si no, se genera.
 */
const NIVELES = ['level_1_simple', 'level_2_moderate', 'level_3_intermediate', 'level_4_complex', 'level_5_critical'] as const;
type Nivel = (typeof NIVELES)[number];
const CORTO = (n: number) => `N${n}`;

const AGENTES: { proveedor: string; nombre: string; claves: RegExp }[] = [
  { proveedor: 'claude-cli', nombre: 'Claude Code', claves: /\bclaude\b/ },
  { proveedor: 'codex', nombre: 'Codex', claves: /\b(codex|chatgpt|gpt)\b/ },
  { proveedor: 'ollama-qwen', nombre: 'Qwen (local)', claves: /\b(qwen|local|ollama)\b/ },
];
const AREAS: [string, RegExp][] = [
  ['frontend', /\b(interfaz|interfaces|diseno|disenos|frontend|ui|ux|pantallas?|componentes?)\b/],
  ['backend', /\b(backend|api|apis|servidor|servidores|endpoints?|base de datos)\b/],
  ['oficina', /\b(oficina|informes?|reportes?|documentos?|correos?|excel|presentacion(es)?)\b/],
  ['data', /\b(datos|data|analisis|estadisticas?)\b/],
];
const plano = (t: string) => t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Niveles que menciona una cláusula: «N3», «N1-N3», «N1 a N3», «hasta N3», «desde N4», o palabras (simple, complejo…). */
export function nivelesDe(texto: string): number[] {
  const t = plano(texto);
  const rango = /\bn([1-5])\s*(?:-|a|al|hasta)\s*n?([1-5])\b/.exec(t);
  if (rango) {
    const a = Number(rango[1]), b = Number(rango[2]);
    return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i);
  }
  const hasta = /\b(?:hasta(?: el)?|como maximo)\s*n([1-5])\b|\bn([1-5])\s*o menos\b/.exec(t);
  if (hasta) return Array.from({ length: Number(hasta[1] ?? hasta[2]) }, (_, i) => i + 1);
  const desde = /\b(?:desde(?: el)?|a partir del?)\s*n([1-5])\b|\bn([1-5])\s*o mas\b/.exec(t);
  if (desde) { const a = Number(desde[1] ?? desde[2]); return Array.from({ length: 6 - a }, (_, i) => a + i); }
  const sueltos = [...t.matchAll(/\bn([1-5])\b/g)].map((m) => Number(m[1]));
  const palabras: [RegExp, number[]][] = [
    [/\b(simples?|sencill[oa]s?|faciles?|triviales?|basic[oa]s?)\b/, [1, 2]],
    [/\b(moderad[oa]s?)\b/, [2]],
    [/\b(intermedi[oa]s?|medi[oa]s?)\b/, [3]],
    // «Complejo» abarca también lo crítico (N4–N5): es como se suele pedir «Claude para lo complejo».
    [/\b(complej[oa]s?|dificiles?|grandes?)\b/, [4, 5]],
    [/\b(critic[oa]s?|arquitectura|delicad[oa]s?)\b/, [5]],
  ];
  const dePalabras = palabras.flatMap(([re, ns]) => (re.test(t) ? ns : []));
  return [...new Set([...sueltos, ...dePalabras])].sort((a, b) => a - b);
}

const clausulas = (texto: string) => plano(texto)
  .split(/[,;\n.]+|\s+y\s+(?=(?:claude|codex|chatgpt|gpt|qwen|local|ollama|sin|quita)\b)/)
  .map((c) => c.trim()).filter(Boolean);

const rangoDe = (ns: number[]) => (!ns.length ? 'sin nivel' : ns.length === 1 ? CORTO(ns[0]!) : ns.every((n, i) => !i || n === ns[i - 1]! + 1) ? `${CORTO(ns[0]!)}–${CORTO(ns[ns.length - 1]!)}` : ns.map(CORTO).join(', '));

/** Una línea legible del perfil: qué atiende cada agente y qué reglas tiene. */
export function describirPerfil(p: Perfil): string {
  const partes = p.entities.filter((e) => e.provider).map((e) => {
    const ns = (e.levels ?? []).map((l) => NIVELES.indexOf(l as Nivel) + 1).filter((n) => n > 0).sort((a, b) => a - b);
    return `${e.name ?? e.provider}: ${rangoDe(ns)}`;
  });
  const reglas = (p.rules ?? []).filter((r) => r.enabled !== false).map((r) => r.name || r.id);
  return `${partes.join(' · ')}${reglas.length ? `. Reglas: ${reglas.join('; ')}` : ''}.`;
}

export interface Propuesta { perfil: Perfil; cambios: string[]; entendido: boolean }

export function perfilDesdeTexto(texto: string, base: Perfil): Propuesta {
  const perfil: Perfil = JSON.parse(JSON.stringify(base)) as Perfil;
  perfil.rules = perfil.rules ?? [];
  const cambios: string[] = [];
  let entendido = false;
  let nuevas = 0; // reglas de esta frase: van delante de las que ya había, en el orden en que se escriben
  const entidadDe = (proveedor: string): Entidad => {
    let e = perfil.entities.find((x) => x.provider === proveedor);
    if (!e) {
      const def = AGENTES.find((a) => a.proveedor === proveedor)!;
      e = { id: `${perfil.id}-${proveedor}`.slice(0, 80), name: def.nombre, role: 'worker', role_tags: ['worker'], provider: proveedor, tier: 1, levels: [], max_concurrent: 1, x: 120 + perfil.entities.length * 360, y: 430 };
      perfil.entities.push(e);
      cambios.push(`Añade ${def.nombre} al perfil`);
    }
    return e;
  };

  for (const t of clausulas(texto)) {
    if (/^descripcion\s*:/.test(t)) continue;
    const agentes = AGENTES.filter((a) => a.claves.test(t));
    if (!agentes.length) continue;
    if (/\b(sin|quita|quitar|elimina|fuera|no uses)\b/.test(t)) {
      for (const a of agentes) {
        const ids = perfil.entities.filter((e) => e.provider === a.proveedor).map((e) => e.id);
        if (!ids.length) continue;
        perfil.entities = perfil.entities.filter((e) => e.provider !== a.proveedor);
        perfil.rules = perfil.rules.filter((r) => !ids.includes(r.entity_id));
        cambios.push(`Quita ${a.nombre}`);
        entendido = true;
      }
      continue;
    }
    const niveles = nivelesDe(t);
    const areas = AREAS.filter(([, re]) => re.test(t)).map(([a]) => a);
    const a = agentes[0]!;
    const e = entidadDe(a.proveedor);
    if (areas.length) {
      const regla: Regla = {
        id: `texto-${a.proveedor}-${areas.join('-')}`.slice(0, 80),
        name: `${areas.join(', ')}${niveles.length ? ` (${rangoDe(niveles)})` : ''} → ${a.nombre}`,
        entity_id: e.id, domains: areas, intents: [],
        level_min: niveles.length ? niveles[0]! : null, level_max: niveles.length ? niveles[niveles.length - 1]! : null, enabled: true,
      };
      const resto: Regla[] = perfil.rules.filter((r) => r.id !== regla.id);
      perfil.rules = [...resto.slice(0, nuevas), regla, ...resto.slice(nuevas)];
      nuevas++;
      cambios.push(`Regla: ${regla.name}`);
      entendido = true;
    } else if (niveles.length) {
      const ids: string[] = niveles.map((n) => NIVELES[n - 1]!);
      for (const otra of perfil.entities) if (otra !== e) otra.levels = (otra.levels ?? []).filter((l) => !ids.includes(l));
      e.levels = ids;
      cambios.push(`${a.nombre} atiende ${rangoDe(niveles)}`);
      entendido = true;
    }
  }

  const m = /descripci[oó]n\s*:\s*([\s\S]+)$/i.exec(texto);
  perfil.description = m ? m[1]!.trim().slice(0, 400) : describirPerfil(perfil);
  return { perfil, cambios, entendido };
}
