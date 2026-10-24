import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { coincide, componentePorId, etiquetaMetrica, formatear, metricaClave, poner, serieDe, valorActual, type Filtro } from './datos';
import { Sparkline } from './graficas';
import { ESTADOS, type Arquitectura, type Componente } from './tipos';

/**
 * El esquema: una banda por familia (la primera arriba), con su nombre a la izquierda, una caja por componente y llaves a la
 * derecha que agrupan bandas. Las flechas del «flujo» son las `enlaces` del contrato, dibujadas sobre las bandas y bajo las cajas.
 * Todo el color sale de tokens (`--kj-fam-*` apunta a los `--atlas-hue-*` con respaldo), así que sirve en claro y en oscuro.
 */
const TONO: Record<string, string> = { interfaz: 'lavanda', modificadores: 'mostaza', observacion: 'lago', ejecucion: 'vino', decision: 'cobre', base: 'musgo' };
const TONOS = ['musgo', 'cobre', 'mostaza', 'lago', 'vino', 'lavanda'];
const GRUPOS: { nombre: string; familias: string[] }[] = [
  { nombre: 'Superficie', familias: ['interfaz', 'modificadores'] },
  { nombre: 'Operación', familias: ['observacion', 'ejecucion'] },
  { nombre: 'Núcleo', familias: ['decision', 'base'] },
];
const DESCRIPCION: Record<string, string> = {
  interfaz: 'Cómo se maneja', modificadores: 'Cambian lo que recibe el agente', observacion: 'Mide lo que ocurre', ejecucion: 'Lanza y aísla agentes', decision: 'Elige agente y skills', base: 'Datos, guardián y motor',
};
const tonoDe = (familia: string, indice: number) => TONO[familia] ?? TONOS[indice % TONOS.length]!;

interface Props { datos: Arquitectura; seleccion: string | null; filtro: Filtro; busqueda: string; flujo: boolean }

export function Esquema({ datos, seleccion, filtro, busqueda, flujo }: Props) {
  const raiz = useRef<HTMLDivElement>(null);
  const cajas = useRef(new Map<string, HTMLElement>());
  const familias = useMemo(() => [...datos.familias].sort((a, b) => a.orden - b.orden), [datos.familias]);
  const registrar = useCallback((id: string, el: HTMLElement | null) => { if (el) cajas.current.set(id, el); else cajas.current.delete(id); }, []);
  // Llaves: cada grupo cubre las filas de sus familias si están seguidas.
  const llaves = useMemo(() => GRUPOS.map((g) => {
    const filas = g.familias.map((f) => familias.findIndex((x) => x.id === f)).filter((i) => i >= 0).sort((a, b) => a - b);
    return filas.length && filas[filas.length - 1]! - filas[0]! === filas.length - 1 ? { nombre: g.nombre, desde: filas[0]! + 1, hasta: filas[filas.length - 1]! + 1 } : null;
  }).filter((x): x is { nombre: string; desde: number; hasta: number } => x !== null), [familias]);

  return (
    <div className="kj-esquema" ref={raiz} role="group" aria-label="Esquema de componentes de Karajan por familia">
      {familias.map((f, i) => {
        const fila = i + 1;
        const comps = f.componentes.map((id) => componentePorId(datos, id)).filter((c): c is Componente => c !== null);
        return (
          <div key={f.id} className="kj-banda-fila" style={{ ['--kj-fila' as string]: fila, ['--kj-tono' as string]: `var(--kj-fam-${tonoDe(f.id, i)})`, ['--kj-tono-suave' as string]: `var(--kj-fam-${tonoDe(f.id, i)}-suave)` }}>
            <h3 className="kj-banda-nombre" style={{ gridRow: fila }}><span>{f.nombre}</span><small>{comps.length} {comps.length === 1 ? 'componente' : 'componentes'}</small>{DESCRIPCION[f.id] && <em>{DESCRIPCION[f.id]}</em>}</h3>
            <div className="kj-banda-cajas" style={{ gridRow: fila }}>
              {comps.map((c) => <Caja key={c.id} c={c} registrar={registrar} activa={seleccion === c.id} atenuada={!coincide(c, filtro, busqueda)} />)}
            </div>
          </div>
        );
      })}
      {llaves.map((l) => (
        <div key={l.nombre} className="kj-llave" style={{ gridRow: `${l.desde} / ${l.hasta + 1}` }} aria-hidden="true">
          <svg viewBox="0 0 14 100" preserveAspectRatio="none"><path d="M2 3 Q9 3 9 14 L9 38 Q9 50 13 50 Q9 50 9 62 L9 86 Q9 97 2 97" vectorEffect="non-scaling-stroke" /></svg>
          <span>{l.nombre}</span>
        </div>
      ))}
      {flujo && <Flechas raiz={raiz} cajas={cajas} datos={datos} seleccion={seleccion} />}
    </div>
  );
}

function descripcion(c: Componente): string {
  const e = ESTADOS.find((x) => x.id === c.estado);
  const k = metricaClave(c);
  const v = k ? formatear(k, valorActual(c, k)) : null;
  return `${c.id}, ${e?.largo ?? c.estado}${k && v && v !== '—' ? `, ${etiquetaMetrica(k)} ${v}` : ''}${c.hallazgos.length ? `, ${c.hallazgos.length} ${c.hallazgos.length === 1 ? 'hallazgo' : 'hallazgos'}` : ''}`;
}

function Caja({ c, registrar, activa, atenuada }: { c: Componente; registrar: (id: string, el: HTMLElement | null) => void; activa: boolean; atenuada: boolean }) {
  const k = metricaClave(c);
  const valor = k ? valorActual(c, k) : null;
  const serie = k ? serieDe(c, k) : [];
  const pendiente = c.estado === 'pendiente';
  const grande = c.escenarios.length >= 3;
  return (
    <button
      type="button" ref={(el) => registrar(c.id, el)}
      className={`kj-caja${grande ? ' grande' : ''}`} data-estado={c.estado} data-atenuada={atenuada || undefined}
      aria-pressed={activa} aria-label={descripcion(c)} title={c.responsabilidad}
      onClick={() => poner({ seleccion: activa ? null : c.id })}
    >
      <span className="kj-caja-cab">
        <i className="kj-punto" data-estado={c.estado} aria-hidden="true" />
        <b>{c.id}</b>
        {c.hallazgos.length > 0 && <em className="kj-caja-n" aria-hidden="true">{c.hallazgos.length}</em>}
      </span>
      {pendiente ? (
        <span className="kj-caja-pie kj-caja-pendiente">{c.pendiente ?? 'pendiente'}</span>
      ) : k && valor !== null ? (
        <span className="kj-caja-pie">
          <span className="kj-caja-metrica"><strong>{formatear(k, valor)}</strong><small>{etiquetaMetrica(k)}</small></span>
          <Sparkline valores={serie} />
        </span>
      ) : (
        <span className="kj-caja-pie kj-caja-vacia">{c.estado === 'error' ? 'falló' : c.ultimas.length ? 'muestra corta' : 'sin ejecutar'}<small>{c.escenarios.length} {c.escenarios.length === 1 ? 'escenario' : 'escenarios'}</small></span>
      )}
    </button>
  );
}

// ── Flechas ─────────────────────────────────────────────────────────────────────────────────────────

interface Trazo { ancho: number; clave: string; d: string; etiqueta?: string; lx: number; ly: number; resaltado: boolean; tenue: boolean }

function Flechas({ raiz, cajas, datos, seleccion }: { raiz: React.RefObject<HTMLDivElement | null>; cajas: React.RefObject<Map<string, HTMLElement>>; datos: Arquitectura; seleccion: string | null }) {
  const [medida, setMedida] = useState<{ w: number; h: number; trazos: Trazo[] }>({ w: 0, h: 0, trazos: [] });
  const calcular = useCallback(() => {
    const r = raiz.current;
    if (!r) return;
    const base = r.getBoundingClientRect();
    const rect = (id: string) => {
      const el = cajas.current?.get(id);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left - base.left, y: b.top - base.top, w: b.width, h: b.height };
    };
    type Rc = NonNullable<ReturnType<typeof rect>>;
    interface Ext { de: string; a: string; etiqueta?: string; rd: Rc; ra: Rc; lado: 'abajo' | 'arriba' | 'lado' }
    const exts: Ext[] = [];
    for (const e of datos.enlaces) {
      const rd = rect(e.de), ra = rect(e.a);
      if (!rd || !ra) continue;
      const dy = ra.y + ra.h / 2 - (rd.y + rd.h / 2);
      exts.push({ ...e, rd, ra, lado: Math.abs(dy) < rd.h * 0.6 ? 'lado' : dy > 0 ? 'abajo' : 'arriba' });
    }
    // Reparte los puntos de anclaje de cada borde para que las flechas del mismo lado no se pisen.
    const ancla = new Map<string, number>();
    const grupos = new Map<string, { clave: string; otroX: number }[]>();
    for (const x of exts) {
      if (x.lado === 'lado') continue;
      const salida = x.lado === 'abajo' ? 'b' : 't', entrada = x.lado === 'abajo' ? 't' : 'b';
      const ks = `${x.de}:${salida}`, ke = `${x.a}:${entrada}`;
      (grupos.get(ks) ?? grupos.set(ks, []).get(ks)!).push({ clave: `${x.de}>${x.a}:s`, otroX: x.ra.x + x.ra.w / 2 });
      (grupos.get(ke) ?? grupos.set(ke, []).get(ke)!).push({ clave: `${x.de}>${x.a}:e`, otroX: x.rd.x + x.rd.w / 2 });
    }
    for (const [k, lista] of grupos) {
      const id = k.split(':')[0]!;
      const rc = rect(id)!;
      lista.sort((p, q) => p.otroX - q.otroX).forEach((it, i) => ancla.set(it.clave, rc.x + (rc.w * (i + 1)) / (lista.length + 1)));
    }
    const trazos: Trazo[] = exts.map((x) => {
      const k = `${x.de}>${x.a}`;
      let p0: [number, number], p1: [number, number], d: string;
      if (x.lado === 'lado') {
        const der = x.ra.x > x.rd.x;
        p0 = [der ? x.rd.x + x.rd.w : x.rd.x, x.rd.y + x.rd.h / 2]; p1 = [der ? x.ra.x : x.ra.x + x.ra.w, x.ra.y + x.ra.h / 2];
        const m = (p0[0] + p1[0]) / 2;
        d = `M${p0[0]} ${p0[1]} C${m} ${p0[1] - 22} ${m} ${p1[1] - 22} ${p1[0]} ${p1[1]}`;
      } else {
        const abajo = x.lado === 'abajo';
        p0 = [ancla.get(`${k}:s`) ?? x.rd.x + x.rd.w / 2, abajo ? x.rd.y + x.rd.h : x.rd.y];
        p1 = [ancla.get(`${k}:e`) ?? x.ra.x + x.ra.w / 2, abajo ? x.ra.y : x.ra.y + x.ra.h];
        const dy = Math.max(18, Math.abs(p1[1] - p0[1]) * 0.45) * (abajo ? 1 : -1);
        d = `M${p0[0]} ${p0[1]} C${p0[0]} ${p0[1] + dy} ${p1[0]} ${p1[1] - dy} ${p1[0]} ${p1[1]}`;
      }
      const resaltado = seleccion !== null && (x.de === seleccion || x.a === seleccion);
      return { ancho: Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]), clave: k, d, etiqueta: x.etiqueta, lx: (p0[0] + p1[0]) / 2, ly: (p0[1] + p1[1]) / 2, resaltado, tenue: seleccion !== null && !resaltado };
    });
    setMedida({ w: base.width, h: base.height, trazos });
  }, [raiz, cajas, datos.enlaces, seleccion]);

  useLayoutEffect(() => {
    calcular();
    const r = raiz.current;
    if (!r || typeof ResizeObserver === 'undefined') return;
    const o = new ResizeObserver(() => calcular());
    o.observe(r);
    return () => o.disconnect();
  }, [calcular, raiz]);

  if (!medida.w) return null;
  return (
    <svg className="kj-flechas" width={medida.w} height={medida.h} viewBox={`0 0 ${medida.w} ${medida.h}`} aria-hidden="true">
      <defs>
        <marker id="kj-punta" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" className="kj-punta" /></marker>
        <marker id="kj-punta-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" className="kj-punta on" /></marker>
      </defs>
      {medida.trazos.map((t) => (
        <g key={t.clave} className={`kj-flecha${t.resaltado ? ' on' : ''}${t.tenue ? ' tenue' : ''}`}>
          <path d={t.d} markerEnd={`url(#${t.resaltado ? 'kj-punta-on' : 'kj-punta'})`} />
          {t.etiqueta && t.resaltado && t.ancho > 70 && <text x={t.lx} y={t.ly - 4} textAnchor="middle">{t.etiqueta}</text>}
        </g>
      ))}
    </svg>
  );
}
