import type { Hallazgo } from '../pasarela-borradores';
import type { RunAnalitica } from '../produccion';
import { motivoFallo, modeloPara, PROVEEDORES, type Tier } from '../proveedores';
import { proporcion, wilson, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';

/**
 * Laboratorio de los proveedores. Nunca lanza un agente: mide lo que ya pasó y la configuración.
 *   contrato  cada proveedor declara binario, argumentos y un modelo para todos los niveles, y su binario se encuentra en el PATH
 *             (`buscarBinario`, sin ejecutarlo). Que falte en este equipo es un aviso, no un fallo del código.
 *   replay    sobre los runs ya registrados: tasa de fallo por proveedor con Wilson y muestra mínima, motivos de fallo agrupados con
 *             `motivoFallo`, y hallazgo si un proveedor falla significativamente más que el resto.
 */
export interface ContextoProveedores extends ContextoLab {
  /** Los runs registrados (de `task_logs.db`), sin prompts. */
  runs(): RunAnalitica[];
  /** Dónde está un binario en este equipo, o null (`buscarBinario`); inyectado para no depender de la máquina. */
  buscar(binario: string): string | null;
}

export const UMBRALES_PROVEEDORES = { muestraMinima: 10, motivosVisibles: 5 };
const NIVELES: Tier[] = ['cheap_model', 'cheap_or_medium_model', 'medium_model', 'strong_model', 'strong_model_with_human_review'];

function contrato(ctx: ContextoProveedores): Resultado {
  const hallazgos: Hallazgo[] = [];
  const incompletos: string[] = [];
  const sinBinario: string[] = [];
  for (const p of PROVEEDORES) {
    const modelos = NIVELES.map((n) => modeloPara(p, n));
    // Los que reciben la instrucción como argumento se comprueban con una instrucción de prueba (si no, su argumento sería vacío).
    const args = p.args(modelos[0]!, p.instruccionEnArgumento ? 'prueba de contrato' : undefined);
    if (!p.nombre || !p.binario || !modelos.every(Boolean) || !args.length || !args.every((a) => typeof a === 'string' && a)) incompletos.push(p.nombre || '(sin nombre)');
    if (!ctx.buscar(p.binario)) sinBinario.push(`${p.nombre} («${p.binario}»)`);
  }
  if (new Set(PROVEEDORES.map((p) => p.nombre)).size !== PROVEEDORES.length) incompletos.push('nombres repetidos');
  if (incompletos.length) hallazgos.push({
    clave: 'proveedor-incompleto', severidad: 'alta', titulo: `Proveedores mal declarados: ${incompletos.join(', ')}`,
    evidencia: 'Les falta nombre, binario, argumentos o un modelo para algún nivel, o hay nombres repetidos.', propuesta: 'Completar la tabla `PROVEEDORES` de `atlas/src/proveedores.ts`.',
  });
  if (sinBinario.length) hallazgos.push({
    clave: 'binario-ausente', severidad: 'baja', titulo: `Binarios que no están en el PATH de este equipo: ${sinBinario.join(', ')}`,
    evidencia: 'Sus tareas irán al respaldo del delegador.', propuesta: 'Instalar el CLI o quitarlo del perfil de este equipo.',
  });
  return {
    muestra: PROVEEDORES.length, suficiente: true, hallazgos,
    metricas: { proveedores: PROVEEDORES.length, binarios_encontrados: PROVEEDORES.length - sinBinario.length, incompletos: incompletos.length },
    umbrales: { incompletos: '= 0', binarios_encontrados: 'aviso si falta alguno' },
    detalle: { binarios: PROVEEDORES.map((p) => ({ proveedor: p.nombre, binario: p.binario, encontrado: ctx.buscar(p.binario) !== null })) },
  };
}

const fallo = (r: RunAnalitica) => r.status === 'failed' || Boolean(r.error);
/** Un motivo estable para agrupar: sin números (tiempos, códigos, rutas con ids) y acotado. */
const clave = (texto: string) => motivoFallo(texto).replace(/\d+/g, '#').slice(0, 100);

function replay(ctx: ContextoProveedores): Resultado {
  const U = UMBRALES_PROVEEDORES;
  const porProveedor = new Map<string, { n: number; fallos: number; motivos: Map<string, number> }>();
  for (const r of ctx.runs()) {
    if (!r.provider_name) continue;
    const p = porProveedor.get(r.provider_name) ?? { n: 0, fallos: 0, motivos: new Map<string, number>() };
    p.n++;
    if (fallo(r)) { p.fallos++; const k = clave(r.error ?? 'sin motivo'); p.motivos.set(k, (p.motivos.get(k) ?? 0) + 1); }
    porProveedor.set(r.provider_name, p);
  }
  const total = [...porProveedor.values()].reduce((s, p) => s + p.n, 0);
  const evaluables = [...porProveedor.entries()].filter(([, p]) => p.n >= U.muestraMinima);
  const hallazgos: Hallazgo[] = [];
  for (const [nombre, p] of evaluables) {
    const resto = [...porProveedor.entries()].filter(([k]) => k !== nombre).reduce((s, [, x]) => ({ n: s.n + x.n, f: s.f + x.fallos }), { n: 0, f: 0 });
    // Significativo: el suelo del IC95 del proveedor queda por encima del techo del IC95 del resto (que ha de tener muestra).
    if (resto.n < U.muestraMinima || wilson(p.fallos, p.n)[0] <= wilson(resto.f, resto.n)[1]) continue;
    const motivos = [...p.motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, U.motivosVisibles);
    hallazgos.push({
      clave: `falla-mas:${nombre}`, severidad: 'media', titulo: `${nombre} falla significativamente más que el resto`,
      evidencia: `${p.fallos}/${p.n} runs fallidos (IC95 ${wilson(p.fallos, p.n).map((x) => x.toFixed(2)).join('–')}) frente a ${resto.f}/${resto.n} en los demás (IC95 ${wilson(resto.f, resto.n).map((x) => x.toFixed(2)).join('–')}). Motivos más repetidos:\n${motivos.map(([m, c]) => `- ${c}× ${m}`).join('\n')}`,
      propuesta: `Revisar la instalación, la sesión y el tiempo máximo de ${nombre}, y el perfil que le da tareas; mientras tanto, moverlas a otro agente.`,
    });
  }
  const tasa = (k: number, n: number) => (n ? { tasa: proporcion(k, n), ic_inf: Math.round(wilson(k, n)[0] * 1000) / 1000, ic_sup: Math.round(wilson(k, n)[1] * 1000) / 1000 } : { tasa: null, ic_inf: null, ic_sup: null });
  return {
    muestra: total, suficiente: evaluables.length > 0, hallazgos: evaluables.length ? hallazgos : [],
    metricas: { runs: total, proveedores: porProveedor.size, proveedores_evaluables: evaluables.length, fallos: [...porProveedor.values()].reduce((s, p) => s + p.fallos, 0) },
    umbrales: { muestra: `≥ ${U.muestraMinima} runs por proveedor`, falla_mas: 'IC95 inferior del proveedor > IC95 superior del resto' },
    detalle: { proveedores: Object.fromEntries([...porProveedor.entries()].map(([k, p]) => [k, { runs: p.n, fallos: p.fallos, ...tasa(p.fallos, p.n), evaluable: p.n >= U.muestraMinima,
      motivos: [...p.motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, U.motivosVisibles).map(([motivo, veces]) => ({ motivo, veces })) }])) },
  };
}

export const laboratorioProveedores: Laboratorio<ContextoProveedores> = {
  escenarios: [
    { id: 'contrato', tipo: 'contrato', descripcion: 'Cada proveedor está completo y su binario se encuentra en el PATH (sin ejecutarlo)', ejecutar: (c) => contrato(c) },
    { id: 'fallos', tipo: 'replay', descripcion: 'Sobre los runs registrados: tasa de fallo por proveedor (Wilson) y motivos agrupados', ejecutar: (c) => replay(c) },
  ],
};
