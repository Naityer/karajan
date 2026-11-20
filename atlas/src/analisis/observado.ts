import { createHash } from 'node:crypto';

import type { EntradaTarea, Observado, Resultado } from './tipos';

/**
 * Datos OBSERVADOS de una tarea: lo que el registro o la cola ya dicen, sin interpretar. Todo lo que falta se queda en `null`.
 * Formato de origen: `tarea.json` del registro de Atlas dev (docs/registro-tareas.md) con `metricas` como `{vueltas[], porEstado}`
 * (en la base viene serializada como texto).
 */
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function json(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

export function resultadoDe(estado: string | null, validada: boolean | null): Resultado {
  switch (estado) {
    case 'completada': return validada === true ? 'validada' : 'completada_sin_validar';
    case 'fallida': return 'fallida';
    case 'descartada': return 'descartada';
    case null: return 'desconocido';
    default: return 'abierta';
  }
}

/** Entrada leída de un `tarea.json` del registro. Devuelve `null` si no tiene ni id ni contenido que analizar. */
export function entradaDeRegistro(registro: unknown): EntradaTarea | null {
  const r = obj(registro), t = obj(r?.['tarea']);
  if (!r || !t || !texto(t['id'])) return null;
  const hoja = obj(json(t['config'])) ?? obj(r['hoja']);
  const correcciones = Array.isArray(hoja?.['correcciones']) ? (hoja!['correcciones'] as unknown[]).filter((c): c is { tipo?: string } => !!obj(c)) : [];
  return {
    id: String(t['id']), titulo: texto(t['titulo']) ?? '', prompt: texto(t['prompt']) ?? '', informe: texto(r['informe']) ?? texto(t['informe']) ?? '',
    estado: texto(t['estado']), tipo_cola: texto(t['tipo']), hoja: obj(r['hoja']) ?? hoja, metricas: json(t['metricas']),
    cabecera: obj(r['cabecera']), correcciones, eventos: Array.isArray(r['eventos']) ? (r['eventos'] as unknown[]).length : null, origen: 'registro',
  };
}

/** Entrada de la cola de Atlas dev (`/operaciones/tareas`): no trae métricas ni informe, así que casi todo lo observado queda `null`. */
export function entradaDeCola(t: { id: string; titulo: string; estado: string; prompt: string | null; agente?: string; hoja?: unknown; tipo?: string }): EntradaTarea {
  return { id: t.id, titulo: t.titulo ?? '', prompt: t.prompt ?? '', informe: '', estado: t.estado ?? null, tipo_cola: t.tipo ?? null, hoja: obj(t.hoja), metricas: null, cabecera: null, correcciones: [], eventos: null, origen: 'cola' };
}

export function observadoDe(e: EntradaTarea): Observado {
  const hoja = e.hoja ?? {}, m = obj(e.metricas);
  const vueltas = Array.isArray(m?.['vueltas']) ? (m!['vueltas'] as unknown[]).map(obj).filter((v): v is Record<string, unknown> => !!v) : [];
  const revisada = hoja['revisada'];
  const validada = typeof revisada === 'boolean' ? revisada : null;
  const costes = vueltas.map((v) => num(v['costeUsd'])).filter((c): c is number => c !== null);
  const duraciones = vueltas.map((v) => num(v['duracionMs'])).filter((d): d is number => d !== null);
  // Tiempo de trabajo real: el estado «ejecutando»; `borrador` y `registrada` cuentan esperas de días y no son trabajo.
  const ejecutando = num(obj(m?.['porEstado'])?.['ejecutando']);
  const tokens = vueltas.length ? vueltas.reduce<{ in: number; out: number; cache: number }>((a, v) => { const t = obj(v['tokens']); return { in: a.in + (num(t?.['in']) ?? 0), out: a.out + (num(t?.['out']) ?? 0), cache: a.cache + (num(t?.['cache']) ?? 0) }; }, { in: 0, out: 0, cache: 0 }) : null;
  const cab = obj(e.cabecera), decisiones = Array.isArray(cab?.['decisiones']) ? (cab!['decisiones'] as unknown[]).map(obj) : [];
  const decidido = (campo: string) => texto(decisiones.find((d) => d?.['campo'] === campo)?.['valor']);
  const clas = obj(hoja['clasificacion']);
  return {
    id: e.id, titulo: e.titulo, estado: e.estado, tipo_cola: e.tipo_cola, resultado: resultadoDe(e.estado, validada), validada,
    agente: texto(hoja['agente']) ?? decidido('agente'), modelo: texto(hoja['modelo']) ?? decidido('modelo') ?? (texto(vueltas.at(-1)?.['modelo'])),
    perfil: texto(hoja['perfil']) ?? texto(hoja['perfilKarajan']),
    duracion_activa_ms: ejecutando ?? (duraciones.length ? duraciones.reduce((a, b) => a + b, 0) : null),
    vueltas: vueltas.length || (m ? 0 : null), tokens, coste_usd: costes.length ? Math.round(costes.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null,
    correcciones: m || e.correcciones.length ? { total: e.correcciones.length, redirecciones: e.correcciones.filter((c) => c.tipo === 'redireccion').length } : null,
    eventos: e.eventos,
    clasificacion_origen: clas ? Object.fromEntries(Object.entries(clas).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string')])) : null,
    origen: e.origen,
  };
}

/** Huella de lo que el análisis lee: si cambia (se valida la tarea, aparece el informe…) el análisis se considera viejo. */
export function huellaOrigen(e: EntradaTarea): string {
  const base = JSON.stringify([e.id, e.titulo, e.prompt, e.informe, e.estado, e.tipo_cola, e.hoja?.['revisada'] ?? null, e.hoja?.['clasificacion'] ?? null, e.metricas, e.correcciones.length]);
  return createHash('sha256').update(base).digest('hex').slice(0, 16);
}
