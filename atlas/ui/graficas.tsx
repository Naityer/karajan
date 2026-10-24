import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { cumple, esPorcentaje, etiquetaMetrica, fechaCorta, formatear, type Umbral } from './datos';
import type { PuntoHistorial } from './tipos';

/** Las gráficas del detalle. recharts es el de Atlas dev (compartido); el resto es SVG o CSS grid propio. */
const trazo = 'rgb(var(--atlas-accent))';
const rejilla = 'rgb(var(--atlas-border))';
const texto = 'rgb(var(--atlas-text-muted))';

/** Mini línea de tendencia para las cajas del esquema. */
export function Sparkline({ valores, ancho = 64, alto = 18 }: { valores: number[]; ancho?: number; alto?: number }) {
  if (valores.length < 2) {
    return <svg className="kj-spark" width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} aria-hidden="true"><line x1="2" x2={ancho - 2} y1={alto / 2} y2={alto / 2} strokeDasharray="2 3" />{valores.length === 1 && <circle cx={ancho - 3} cy={alto / 2} r="2.4" className="kj-spark-punto" />}</svg>;
  }
  const min = Math.min(...valores), max = Math.max(...valores), rango = max - min || 1;
  const px = (i: number) => 2 + (i * (ancho - 6)) / (valores.length - 1);
  const py = (v: number) => alto - 3 - ((v - min) / rango) * (alto - 6);
  const pts = valores.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  return (
    <svg className="kj-spark" width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} aria-hidden="true">
      <polyline points={pts} fill="none" />
      <circle cx={px(valores.length - 1)} cy={py(valores[valores.length - 1]!)} r="2.4" className="kj-spark-punto" />
    </svg>
  );
}

function PuntoHueco({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { suficiente: boolean } }) {
  if (cx === undefined || cy === undefined) return null;
  return <circle cx={cx} cy={cy} r={3.6} stroke={trazo} strokeWidth={1.8} fill={payload?.suficiente ? trazo : 'rgb(var(--atlas-raised))'} />;
}

/** Serie de una métrica entre ejecuciones, con el umbral como línea. Los puntos huecos son ejecuciones con muestra insuficiente. */
export function GraficaMetrica({ metrica, puntos, umbral }: { metrica: string; puntos: PuntoHistorial[]; umbral: Umbral | null }) {
  const datos = puntos.filter((p) => typeof p.valor === 'number').map((p) => ({ fecha: fechaCorta(p.inicio), valor: p.valor as number, suficiente: p.suficiente, escenario: p.escenario }));
  const ultimo = datos.at(-1);
  const pasa = umbral && ultimo ? cumple(ultimo.valor, umbral) : null;
  const vals = [...datos.map((d) => d.valor), ...(umbral ? [umbral.valor] : [])];
  const min = Math.min(...vals), max = Math.max(...vals), margen = (max - min || Math.abs(max) || 1) * 0.18;
  // Porcentajes: ejes en múltiplos de 5 puntos para que las marcas sean redondas; el resto, el ajuste automático de recharts.
  const pct = esPorcentaje(metrica);
  const dominio: [number | string, number | string] = pct ? [Math.max(0, Math.floor((min - margen) * 20) / 20), Math.min(1, Math.ceil((max + margen) * 20) / 20)] : ['auto', 'auto'];
  const marca = (v: number) => (pct ? `${Math.round(v * 100)} %` : v.toLocaleString('es-ES', { maximumFractionDigits: 2 }));
  return (
    <figure className="kj-figura">
      <figcaption>
        <b>{etiquetaMetrica(metrica)}</b>
        <span className="kj-fig-valor" data-pasa={pasa === null ? undefined : String(pasa)}>{formatear(metrica, ultimo?.valor)}</span>
        {umbral && <small>umbral {umbral.texto}{pasa !== null && <i className={pasa ? 'si' : 'no'}>{pasa ? ' ✓' : ' ✗'}</i>}</small>}
      </figcaption>
      <div className="kj-fig-lienzo">
        <ResponsiveContainer width="100%" height={112}>
          <LineChart data={datos} margin={{ top: 8, right: 10, bottom: 0, left: 2 }}>
            <CartesianGrid stroke={rejilla} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="fecha" tick={{ fill: texto, fontSize: 10 }} tickLine={false} axisLine={{ stroke: rejilla }} />
            <YAxis domain={dominio} tick={{ fill: texto, fontSize: 10 }} tickLine={false} axisLine={false} width={46} tickCount={4} tickFormatter={marca} />
            <Tooltip
              contentStyle={{ background: 'rgb(var(--atlas-raised))', border: '1px solid rgb(var(--atlas-border))', borderRadius: 8, fontSize: 12, color: 'rgb(var(--atlas-text))' }}
              formatter={(v) => [formatear(metrica, v as number), etiquetaMetrica(metrica)]}
              labelFormatter={(l, items) => { const p = items?.[0]?.payload as { escenario?: string; suficiente?: boolean } | undefined; return `${String(l)}${p?.escenario ? ` · ${p.escenario}` : ''}${p?.suficiente === false ? ' · muestra corta' : ''}`; }}
            />
            {umbral && <ReferenceLine y={umbral.valor} stroke="rgb(var(--atlas-warning))" strokeDasharray="5 4" strokeWidth={1.4} />}
            <Line type="monotone" dataKey="valor" stroke={trazo} strokeWidth={2} dot={<PuntoHueco />} activeDot={{ r: 5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Hit@1 / Precisión@3 / Recall@3 / F1 del selector: lo que hace hoy frente a los pesos calibrados. */
export function BarrasSelector({ actual, calibrado }: { actual: Record<string, number | null>; calibrado: Record<string, number | null> }) {
  const filas = [
    { nombre: 'Hit@1', actual: actual.hit1 ?? actual.hit1_actual ?? null, calibrado: calibrado.hit1_calibrado ?? null },
    { nombre: 'Precisión@3', actual: actual.precision3 ?? null, calibrado: null },
    { nombre: 'Recall@3', actual: actual.recall3 ?? null, calibrado: null },
    { nombre: 'F1', actual: actual.f1 ?? actual.f1_actual ?? null, calibrado: calibrado.f1_calibrado ?? null },
  ];
  return (
    <figure className="kj-figura">
      <figcaption><b>Selector: actual frente a calibrado</b><small>el calibrado solo existe para Hit@1 y F1</small></figcaption>
      <div className="kj-fig-lienzo">
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={filas} margin={{ top: 8, right: 8, bottom: 0, left: 2 }} barGap={3}>
            <CartesianGrid stroke={rejilla} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="nombre" tick={{ fill: texto, fontSize: 10 }} tickLine={false} axisLine={{ stroke: rejilla }} />
            <YAxis domain={[0, 1]} tick={{ fill: texto, fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickCount={5} tickFormatter={(v: number) => `${Math.round(v * 100)} %`} />
            <Tooltip cursor={{ fill: 'rgb(var(--atlas-border) / 0.35)' }} contentStyle={{ background: 'rgb(var(--atlas-raised))', border: '1px solid rgb(var(--atlas-border))', borderRadius: 8, fontSize: 12, color: 'rgb(var(--atlas-text))' }} formatter={(v) => formatear('f1', v as number)} />
            <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 11, color: texto }} />
            <Bar dataKey="actual" name="Actual" fill="rgb(var(--atlas-hue-lago))" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="calibrado" name="Calibrado" fill="rgb(var(--atlas-hue-cobre))" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Humano frente a Karajan: filas = lo que eligió la persona, columnas = lo que habría elegido Karajan. La diagonal son los aciertos. */
export function MatrizConcordancia({ matriz }: { matriz: Record<string, Record<string, number>> }) {
  const filas = Object.keys(matriz);
  const cols = [...new Set([...filas, ...filas.flatMap((f) => Object.keys(matriz[f]!))])];
  const total = filas.reduce((s, f) => s + Object.values(matriz[f]!).reduce((a, b) => a + b, 0), 0);
  const max = Math.max(1, ...filas.flatMap((f) => Object.values(matriz[f]!)));
  const aciertos = filas.reduce((s, f) => s + (matriz[f]![f] ?? 0), 0);
  return (
    <figure className="kj-figura">
      <figcaption><b>Persona frente a Karajan</b><small>{aciertos} de {total} coinciden · filas: persona, columnas: Karajan</small></figcaption>
      <div className="kj-matriz" role="table" aria-label="Matriz de concordancia: filas, agente que eligió la persona; columnas, agente que habría elegido Karajan" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}>
        <span role="presentation" />
        {cols.map((c) => <span key={c} className="kj-matriz-col" role="columnheader">{c}</span>)}
        {filas.map((f) => (
          <div key={f} className="kj-matriz-fila" role="row">
            <span className="kj-matriz-lado" role="rowheader">{f}</span>
            {cols.map((c) => {
              const n = matriz[f]![c] ?? 0;
              const diag = f === c;
              return (
                <span key={c} role="cell" className={`kj-celda${diag ? ' diag' : ''}`} style={{ ['--i' as string]: `${Math.round((n / max) * 70 + (n ? 10 : 0))}%` }} title={`${f} → ${c}: ${n}`}>
                  <b>{n}</b>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </figure>
  );
}

/** Barras horizontales etiquetadas (CSS puro): segmentos, uso de reglas, fuentes de verdad… */
export function BarrasHorizontales({ titulo, nota, filas, formato = (v) => String(v), max }: { titulo: string; nota?: string; filas: { nombre: string; valor: number; extra?: string; secundario?: number }[]; formato?: (v: number) => string; max?: number }) {
  const tope = max ?? Math.max(1, ...filas.map((f) => Math.max(f.valor, f.secundario ?? 0)));
  return (
    <figure className="kj-figura">
      <figcaption><b>{titulo}</b>{nota && <small>{nota}</small>}</figcaption>
      <ul className="kj-barras">
        {filas.map((f) => (
          <li key={f.nombre}>
            <span className="kj-barras-nombre" title={f.nombre}>{f.nombre}</span>
            <span className="kj-barras-pista" role="img" aria-label={`${f.nombre}: ${formato(f.valor)}${f.secundario !== undefined ? `, de ${formato(f.secundario)}` : ''}`}>
              {f.secundario !== undefined && <i className="sec" style={{ width: `${(f.secundario / tope) * 100}%` }} />}
              <i style={{ width: `${(f.valor / tope) * 100}%` }} />
            </span>
            <span className="kj-barras-valor">{formato(f.valor)}{f.extra && <small> {f.extra}</small>}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
