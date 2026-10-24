import { existsSync, readFileSync } from 'node:fs';

import { claudeExcedido, leerLimites, umbralClaude, type Limites } from '../limites';
import type { Hallazgo } from '../pasarela-borradores';
import type { ContextoLab, Laboratorio, Resultado } from '../laboratorio';

/**
 * Laboratorio de los límites: ¿el aviso «Claude pasó su umbral semanal» se puede creer? Solo lectura del fichero de límites.
 *   fichero    existe, se lee, es fresco (≤ 2 h, si no `leerLimites` lo descarta y nada se limita) y el umbral está en (0, 100].
 *   decision   `claudeExcedido` coincide con «% semanal > umbral» calculado aparte, también en los bordes y con el dato ausente.
 */
export interface ContextoLimites extends ContextoLab {
  /** Fichero de límites del plan (`rutaLimites()`); el laboratorio no lo escribe. */
  ruta: string;
  ahora(): number;
}

const MAX_EDAD_MS = 2 * 3600_000;
const leer = (ruta: string): Limites | null => {
  try { return JSON.parse(readFileSync(ruta, 'utf8')) as Limites; } catch { return null; }
};

function fichero(ctx: ContextoLimites): Resultado {
  const umbral = umbralClaude();
  const hallazgos: Hallazgo[] = [];
  const umbralOk = umbral > 0 && umbral <= 100;
  if (!umbralOk) hallazgos.push({
    clave: 'umbral-fuera-de-rango', severidad: 'alta', titulo: `El umbral de Claude (${umbral} %) está fuera de (0, 100]`,
    evidencia: 'Con ese valor Claude nunca (o siempre) se considera excedido: `KARAJAN_LIMITE_CLAUDE` no es un porcentaje.', propuesta: 'Corregir `KARAJAN_LIMITE_CLAUDE` a un valor entre 1 y 100 (50 por defecto).',
  });
  const existe = existsSync(ctx.ruta);
  const datos = existe ? leer(ctx.ruta) : null;
  const leido = datos ? Date.parse(datos.leido) : Number.NaN;
  const edadMin = Number.isFinite(leido) ? Math.round((ctx.ahora() - leido) / 60_000) : null;
  const fresco = leerLimites(ctx.ahora(), ctx.ruta) !== null;
  const semanal = datos?.claude?.semanal;
  const semanalOk = semanal === undefined || semanal === null || (Number.isFinite(Number(semanal)) && Number(semanal) >= 0 && Number(semanal) <= 100);
  if (!existe) hallazgos.push({
    clave: 'sin-fichero', severidad: 'baja', titulo: 'No hay fichero de límites del plan', evidencia: `No existe ${ctx.ruta}: nada se limita nunca.`,
    propuesta: 'Comprobar que Atlas dev escribe `limites-plan.json` (o apuntar `KARAJAN_LIMITES_PLAN` a él).',
  });
  else if (!datos || edadMin === null) hallazgos.push({
    clave: 'fichero-ilegible', severidad: 'media', titulo: 'El fichero de límites no se puede leer', evidencia: `${ctx.ruta} no es un JSON con el campo «leido» como fecha.`,
    propuesta: 'Revisar quién escribe `limites-plan.json` (Atlas dev) y su formato.',
  });
  else if (!fresco) hallazgos.push({
    clave: 'fichero-caducado', severidad: 'media', titulo: `El fichero de límites tiene ${Math.round(edadMin / 60)} h: se descarta`,
    evidencia: `Pasadas ${MAX_EDAD_MS / 3600_000} h \`leerLimites\` lo ignora y Claude no se limita nunca aunque esté al máximo.`, propuesta: 'Comprobar que la rutina de Atlas dev que lo refresca sigue en marcha.',
  });
  if (!semanalOk) hallazgos.push({
    clave: 'semanal-fuera-de-rango', severidad: 'media', titulo: `El % semanal de Claude (${String(semanal)}) no es un porcentaje`, evidencia: `${ctx.ruta} guarda un valor fuera de [0, 100].`,
    propuesta: 'Revisar cómo Atlas dev lee el límite semanal de la CLI de Claude.',
  });
  return {
    muestra: existe ? 1 : 0, suficiente: existe && datos !== null, hallazgos,
    metricas: { existe: existe ? 1 : 0, fresco: fresco ? 1 : 0, edad_min: edadMin, umbral, umbral_en_rango: umbralOk ? 1 : 0, claude_semanal: typeof semanal === 'number' ? semanal : null },
    umbrales: { edad: `≤ ${MAX_EDAD_MS / 3600_000} h`, umbral: '0 < umbral ≤ 100' },
  };
}

function decision(ctx: ContextoLimites): Resultado {
  const umbral = umbralClaude();
  const datos = leerLimites(ctx.ahora(), ctx.ruta);
  const real = claudeExcedido(datos);
  const pct = Number(datos?.claude?.semanal);
  const esperado = datos?.claude?.semanal !== undefined && datos?.claude?.semanal !== null && Number.isFinite(pct) && pct > umbral ? pct : null;
  // Los bordes de verdad: justo en el umbral no se excede, un punto por encima sí, y sin dato no se limita.
  const bordes: [string, Limites | null, boolean][] = [
    ['en el umbral', { claude: { semanal: umbral }, leido: '' }, false], ['sobre el umbral', { claude: { semanal: umbral + 1 }, leido: '' }, true],
    ['sin dato', null, false], ['semanal nulo', { claude: { semanal: null }, leido: '' }, false],
  ];
  const fallidos = bordes.filter(([, l, debe]) => (claudeExcedido(l) !== null) !== debe).map(([n]) => n);
  const coincide = real === esperado;
  const hallazgos: Hallazgo[] = [];
  if (!coincide || fallidos.length) hallazgos.push({
    clave: 'decision-incoherente', severidad: 'alta', titulo: 'La decisión «Claude excedido» no coincide con el umbral',
    evidencia: `${coincide ? '' : `Con el fichero real: \`claudeExcedido\` da ${String(real)} y «% semanal > ${umbral}» da ${String(esperado)}. `}${fallidos.length ? `Fallan los bordes: ${fallidos.join(', ')}.` : ''}`,
    propuesta: 'Revisar `claudeExcedido` en `atlas/src/limites.ts`: debe ser estrictamente «mayor que el umbral» y nulo sin dato reciente.',
  });
  return {
    muestra: bordes.length + (datos ? 1 : 0), suficiente: true, hallazgos,
    metricas: { coincide_con_fichero: datos ? (coincide ? 1 : 0) : null, bordes_fallidos: fallidos.length, excedido: real !== null ? 1 : 0, claude_semanal: Number.isFinite(pct) ? pct : null, umbral },
    umbrales: { bordes_fallidos: '= 0', coincide_con_fichero: '= 1' },
  };
}

export const laboratorioLimites: Laboratorio<ContextoLimites> = {
  escenarios: [
    { id: 'fichero', tipo: 'contrato', descripcion: 'El fichero de límites existe, es fresco y el umbral de Claude está en rango (solo lectura)', ejecutar: (c) => fichero(c) },
    { id: 'decision', tipo: 'contrato', descripcion: '«Claude excedido» coincide con «% semanal > umbral», también en los bordes', ejecutar: (c) => decision(c) },
  ],
};
