import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Catálogo de skills de Karajan (puerto de `app/skills_catalog.py`, solo lectura): las que trae el router, las que se instalan
 * desde repos de GitHub y las que viven en el propio repo de Karajan, con su estado de instalación en este equipo. Instalarlas
 * (`install_skill`) necesita git y copiar ficheros del repo y queda fuera del paquete (ver PORTE.md).
 */
interface Entrada { name: string; description: string; applies_to: string[]; repo_url?: string }

const ROUTER: Entrada[] = [
  { name: 'repo-analyzer', description: 'Analiza repos, localiza código y dependencias.', applies_to: ['claude', 'codex'] },
  { name: 'cti-analyst', description: 'Inteligencia de amenazas: IOCs, TTPs, APTs, malware.', applies_to: ['claude'] },
  { name: 'frontend-builder', description: 'UI, componentes, dashboards, visualización.', applies_to: ['claude', 'codex'] },
  { name: 'backend-builder', description: 'APIs, base de datos, auth, workers, lógica de servidor.', applies_to: ['claude', 'codex'] },
  { name: 'security-review', description: 'Secretos, permisos, despliegues, acciones irreversibles.', applies_to: ['claude'] },
  { name: 'ponytail', description: 'Simplicidad, mínimo código seguro, YAGNI.', applies_to: ['claude', 'codex', 'ollama'] },
  { name: 'promptfoo', description: 'Testing de prompts, evals y comparación de modelos.', applies_to: ['claude'] },
  { name: 'aider', description: 'Pair-programming en terminal con edición multiarchivo.', applies_to: ['claude', 'ollama', 'codex'] },
];
const ANTHROPIC = 'https://github.com/anthropics/skills';
const GITHUB: Entrada[] = [
  { name: 'docx', description: 'Crear, leer y editar documentos Word (.docx).', applies_to: ['claude', 'codex'], repo_url: ANTHROPIC },
  { name: 'pptx', description: 'Crear y editar presentaciones PowerPoint (.pptx).', applies_to: ['claude', 'codex'], repo_url: ANTHROPIC },
  { name: 'xlsx', description: 'Crear, leer y editar hojas de cálculo (.xlsx/.csv).', applies_to: ['claude', 'codex'], repo_url: ANTHROPIC },
  { name: 'pdf', description: 'Extraer, combinar, dividir y rellenar PDFs.', applies_to: ['claude', 'codex'], repo_url: ANTHROPIC },
  { name: 'mcp-builder', description: 'Construir servidores MCP para integrar APIs externas.', applies_to: ['claude', 'codex'], repo_url: ANTHROPIC },
  { name: 'skill-creator', description: 'Crear, editar y evaluar nuevas skills.', applies_to: ['claude'], repo_url: ANTHROPIC },
  { name: 'webapp-testing', description: 'Probar apps web locales con Playwright.', applies_to: ['claude', 'codex'], repo_url: ANTHROPIC },
  { name: 'web-artifacts-builder', description: 'Artefactos web complejos (React, Tailwind, shadcn/ui).', applies_to: ['claude', 'codex'], repo_url: ANTHROPIC },
];
const LOCALES: Entrada[] = [
  { name: 'karajan', description: 'Router/orquestador de tareas propio de este proyecto: clasifica el prompt, registra la decisión en el harness KARAJAN y delega según la arquitectura de Decisión.', applies_to: ['claude', 'codex'] },
  { name: 'task-router', description: 'Clasifica prompts por ámbito, complejidad y riesgo (sin registrar en el harness).', applies_to: ['claude', 'codex', 'ollama'] },
];

export interface InfoSkill { name: string; description: string; installed: boolean; recommended: boolean; applies_to: string[]; install_command: string | null; repo_url: string | null }

const carpetaDe = (p: string) => { try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; } };

export function listarSkills(casa: string = homedir()): InfoSkill[] {
  const raices = [join(casa, '.claude', 'skills'), join(casa, '.agents', 'skills'), join(casa, '.codex', 'skills')];
  return [...ROUTER, ...GITHUB, ...LOCALES].map((s) => {
    const instalada = raices.some((r) => carpetaDe(join(r, s.name)));
    return { name: s.name, description: s.description, installed: instalada, recommended: instalada, applies_to: s.applies_to, install_command: instalada ? null : `claude skill install ${s.name}`, repo_url: s.repo_url ?? null };
  });
}

/** Descripción del frontmatter de un SKILL.md (como `produccion_datos._descripcion`). */
function descripcion(md: string): string {
  try {
    const m = /^description:\s*(.+)$/m.exec(readFileSync(md, 'utf8').slice(0, 4000));
    return m ? m[1]!.trim().replace(/^["']+|["']+$/g, '') : '';
  } catch { return ''; }
}

/** Las skills instaladas de verdad (carpetas con SKILL.md) más el catálogo conocido, sin duplicados (`produccion_datos.catalogo_real`). */
export function catalogoReal(casa: string = homedir()): { nombre: string; descripcion: string; instalada: boolean }[] {
  const vistas = new Map<string, { nombre: string; descripcion: string; instalada: boolean }>();
  for (const raiz of [join(casa, '.claude', 'skills'), join(casa, '.agents', 'skills'), join(casa, '.codex', 'skills')]) {
    let carpetas: string[] = [];
    try { carpetas = readdirSync(raiz).sort(); } catch { continue; }
    for (const nombre of carpetas) {
      // Las desactivadas (`_nombre`, `nombre.disabled`) no cuentan como instaladas.
      if (nombre.startsWith('_') || nombre.startsWith('.') || nombre.endsWith('.disabled')) continue;
      const md = join(raiz, nombre, 'SKILL.md');
      if (carpetaDe(join(raiz, nombre)) && existsSync(md) && !vistas.has(nombre.toLowerCase())) vistas.set(nombre.toLowerCase(), { nombre, descripcion: descripcion(md), instalada: true });
    }
  }
  for (const s of listarSkills(casa)) if (!vistas.has(s.name.toLowerCase())) vistas.set(s.name.toLowerCase(), { nombre: s.name, descripcion: s.description, instalada: s.installed });
  return [...vistas.values()].sort((a, b) => { const x = a.nombre.toLowerCase(), y = b.nombre.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
}
