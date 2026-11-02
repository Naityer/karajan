// Regenera atlas/ui/fixtures/arquitectura.json (el esquema de ejemplo de la ventana en modo ?demo=1) desde atlas/src/componentes.ts y
// atlas/src/fichas-componentes.ts, que son la fuente de verdad. Uso: node atlas/ui/dev/regenerar-fixture.mjs   (o --comprobar para
// salir con 1 si el fichero está desactualizado, sin escribirlo).
//
// Qué refresca: versión (atlas-package.json), familias y sus componentes, enlaces y, de cada componente, familia, responsabilidad,
// módulos, `pendiente`, ficha y escenarios. Qué conserva: los datos de DEMOSTRACIÓN que ya tenía (estado, últimas ejecuciones,
// historial, hallazgos, operación y los umbrales de cada escenario), que son inventados a propósito para enseñar la ventana.
// Un componente nuevo entra «sin ejecutar», con su configuración de fábrica si la ficha la da sin contexto.
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = resolve(import.meta.dirname, '..', '..');
const ruta = resolve(raiz, 'ui', 'fixtures', 'arquitectura.json');
const tmp = mkdtempSync(join(tmpdir(), 'kj-fixture-'));
try {
  await build({
    stdin: { contents: "export { COMPONENTES, ENLACES, FAMILIAS } from './src/componentes'; export { FICHAS } from './src/fichas-componentes';", resolveDir: raiz, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'modelo.mjs'), logLevel: 'warning',
  });
  const { COMPONENTES, ENLACES, FAMILIAS, FICHAS } = await import(pathToFileURL(join(tmp, 'modelo.mjs')).href);
  const previo = JSON.parse(readFileSync(ruta, 'utf8'));
  const version = JSON.parse(readFileSync(resolve(raiz, '..', 'atlas-package.json'), 'utf8')).version;
  const porId = new Map(previo.componentes.map((c) => [c.id, c]));
  const ordenPrevio = new Map(previo.familias.map((f) => [f.id, f.orden]));

  const componentes = COMPONENTES.map((c) => {
    const ya = porId.get(c.id);
    const f = FICHAS[c.id];
    const ficha = f
      ? { resumen: f.resumen, como_funciona: f.como_funciona, reglas: f.reglas ?? [] }
      : { resumen: c.responsabilidad, como_funciona: { entradas: [], pasos: [], salidas: [] }, reglas: [] };
    const umbralesPrevios = new Map((ya?.escenarios ?? []).map((e) => [e.id, e.umbrales ?? {}]));
    const escenarios = (c.laboratorio?.escenarios ?? []).map((e) => ({ id: e.id, tipo: e.tipo, descripcion: e.descripcion, umbrales: umbralesPrevios.get(e.id) ?? {} }));
    let configuracion = ya?.configuracion ?? {};
    if (!ya && f) { try { configuracion = f.configuracion({}); } catch { configuracion = {}; } }
    return {
      id: c.id, familia: c.familia, responsabilidad: c.responsabilidad, modulos: c.modulos, pendiente: c.pendiente ?? null, ficha,
      estado: ya?.estado ?? (c.laboratorio ? 'sin_ejecutar' : 'pendiente'), configuracion, escenarios,
      ultimas: ya?.ultimas ?? [], historial: ya?.historial ?? {}, detalle: ya?.detalle ?? {}, hallazgos: ya?.hallazgos ?? [], operacion: ya?.operacion ?? null,
    };
  });
  const nuevo = {
    version, modo: previo.modo, generado: previo.generado,
    familias: FAMILIAS.map((f) => ({ id: f.id, nombre: f.nombre, orden: ordenPrevio.get(f.id) ?? f.orden + 1, componentes: COMPONENTES.filter((c) => c.familia === f.id).map((c) => c.id) })),
    componentes,
    enlaces: ENLACES.map((e) => ({ de: e.de, a: e.a, etiqueta: e.etiqueta, ...(e.previsto ? { previsto: true } : {}) })),
  };
  const texto = (n) => `${JSON.stringify(n, null, 2)}\n`;
  const actual = readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
  if (process.argv.includes('--comprobar')) {
    process.stdout.write(texto(nuevo) === actual ? 'La fixture está al día.\n' : 'La fixture está desactualizada: node atlas/ui/dev/regenerar-fixture.mjs\n');
    process.exitCode = texto(nuevo) === actual ? 0 : 1;
  } else {
    if (texto(nuevo) !== actual) nuevo.generado = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(ruta, texto(nuevo), 'utf8');
    process.stdout.write(`${ruta} regenerado (${componentes.length} componentes, versión ${version}).\n`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
