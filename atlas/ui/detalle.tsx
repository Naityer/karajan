import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cumple, duracion, ejecutar, etiquetaMetrica, fechaHora, formatear, metricaClave, parsearUmbral, poner, umbralDe, useVista, type Pestana } from './datos';
import { DiagramaFuncionamiento } from './diagrama';
import { BarrasHorizontales, BarrasSelector, GraficaMetrica, MatrizConcordancia } from './graficas';
import { ESTADOS, type Arquitectura, type Componente, type Escenario, type Hallazgo, type UltimaEjecucion } from './tipos';

/** El cajón de detalle de un componente: Resumen · Laboratorio · Cómo funciona · Rendimiento. */
const PESTANAS: { id: Pestana; nombre: string }[] = [
  { id: 'resumen', nombre: 'Resumen' }, { id: 'laboratorio', nombre: 'Laboratorio' }, { id: 'funciona', nombre: 'Cómo funciona' }, { id: 'rendimiento', nombre: 'Rendimiento' },
];

export function Estadillo({ estado }: { estado: Componente['estado'] }) {
  const e = ESTADOS.find((x) => x.id === estado);
  return <span className="kj-estado" data-estado={estado}><i className="kj-punto" data-estado={estado} aria-hidden="true" />{e?.corto ?? estado}</span>;
}

export function Detalle({ c, datos, alCerrar }: { c: Componente; datos: Arquitectura; alCerrar: () => void }) {
  const { pestana } = useVista();
  const lista = useRef<HTMLDivElement>(null);
  const familia = datos.familias.find((f) => f.id === c.familia);
  const teclas = (e: KeyboardEvent) => {
    const i = PESTANAS.findIndex((p) => p.id === pestana);
    const j = e.key === 'ArrowRight' ? (i + 1) % PESTANAS.length : e.key === 'ArrowLeft' ? (i + PESTANAS.length - 1) % PESTANAS.length : e.key === 'Home' ? 0 : e.key === 'End' ? PESTANAS.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    poner({ pestana: PESTANAS[j]!.id });
    (lista.current?.querySelectorAll<HTMLElement>('[role=tab]')[j])?.focus();
  };
  return (
    <aside className="kj-detalle" aria-label={`Detalle de ${c.id}`}>
      <header className="kj-detalle-cab">
        <div>
          <small>{familia?.nombre ?? c.familia}</small>
          <h2>{c.id}</h2>
        </div>
        <Estadillo estado={c.estado} />
        <button type="button" className="kj-cerrar" onClick={alCerrar} aria-label="Cerrar el detalle">×</button>
      </header>
      <div className="kj-pestanas" role="tablist" aria-label={`Secciones de ${c.id}`} ref={lista} onKeyDown={teclas}>
        {PESTANAS.map((p) => (
          <button key={p.id} type="button" role="tab" id={`kj-tab-${p.id}`} aria-selected={pestana === p.id} aria-controls="kj-panel-detalle" tabIndex={pestana === p.id ? 0 : -1} className={pestana === p.id ? 'on' : ''} onClick={() => poner({ pestana: p.id })}>{p.nombre}</button>
        ))}
      </div>
      <div className="kj-detalle-cuerpo" role="tabpanel" id="kj-panel-detalle" aria-labelledby={`kj-tab-${pestana}`}>
        {pestana === 'resumen' && <Resumen c={c} datos={datos} />}
        {pestana === 'laboratorio' && <Laboratorio c={c} datos={datos} />}
        {pestana === 'funciona' && <Funciona c={c} />}
        {pestana === 'rendimiento' && <Rendimiento c={c} />}
      </div>
    </aside>
  );
}

// ── Piezas comunes ──────────────────────────────────────────────────────────────────────────────────

function Seccion({ titulo, children, nota }: { titulo: string; children: ReactNode; nota?: string }) {
  return <section className="kj-seccion"><h3>{titulo}{nota && <small>{nota}</small>}</h3>{children}</section>;
}

/** Pinta cualquier valor de configuración: escalares como texto, listas como etiquetas y objetos como lista de claves. */
function Valor({ v, nivel = 0 }: { v: unknown; nivel?: number }): ReactNode {
  if (v === null || v === undefined) return <span className="kj-nulo">—</span>;
  if (typeof v === 'boolean') return <span className="kj-ficha-valor">{v ? 'sí' : 'no'}</span>;
  if (typeof v === 'number') return <span className="kj-ficha-valor">{v.toLocaleString('es-ES', { maximumFractionDigits: 4 })}</span>;
  if (typeof v === 'string') return <span className="kj-ficha-valor">{v}</span>;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return <span className="kj-etiquetas">{v.map((x, i) => <code key={i}>{String(x)}</code>)}</span>;
    return <ul className="kj-lista-valor">{v.map((x, i) => <li key={i}><Valor v={x} nivel={nivel + 1} /></li>)}</ul>;
  }
  if (typeof v === 'object') {
    if (nivel > 2) return <code>{JSON.stringify(v)}</code>;
    return (
      <dl className={`kj-dl${nivel ? ' anidada' : ''}`}>
        {Object.entries(v as Record<string, unknown>).map(([k, x]) => <div key={k}><dt>{k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}</dt><dd><Valor v={x} nivel={nivel + 1} /></dd></div>)}
      </dl>
    );
  }
  return <span>{String(v)}</span>;
}

/** Campo para la tarea aceptada de Atlas dev: solo hace falta en modo producción (el guardián la exige para ejecutar). */
export function CampoTarea({ id }: { id: string }) {
  const { tarea } = useVista();
  return (
    <label className="kj-campo" htmlFor={id}>
      <span>Tarea aceptada (id)</span>
      <input id={id} type="text" value={tarea} spellCheck={false} autoComplete="off" placeholder="p. ej. a1b2" onChange={(e) => poner({ tarea: e.target.value })} />
    </label>
  );
}

// ── Resumen ─────────────────────────────────────────────────────────────────────────────────────────

function Resumen({ c, datos }: { c: Componente; datos: Arquitectura }) {
  const recibe = datos.enlaces.filter((e) => e.a === c.id), entrega = datos.enlaces.filter((e) => e.de === c.id);
  const ir = (id: string) => poner({ seleccion: id });
  const enlace = (id: string, etiqueta?: string) => <li key={id}><button type="button" className="kj-enlace" onClick={() => ir(id)}>{id}</button>{etiqueta && <small> · {etiqueta}</small>}</li>;
  return (
    <>
      <p className="kj-responsabilidad">{c.responsabilidad}</p>
      <p className="kj-resumen-texto">{c.ficha.resumen}</p>
      {c.pendiente && (
        <div className="kj-pendiente" role="note">
          <b>Pendiente</b>
          <span>{c.pendiente}</span>
        </div>
      )}
      <Seccion titulo="Módulos" nota={c.modulos.length ? `${c.modulos.length} en atlas/src/` : undefined}>
        {c.modulos.length ? <span className="kj-etiquetas">{c.modulos.map((m) => <code key={m}>{m}</code>)}</span> : <p className="kj-vacio">Sin módulos propios todavía: lo traerá el borrador indicado.</p>}
      </Seccion>
      <Seccion titulo="Dependencias">
        <div className="kj-deps">
          <div><small>Recibe de</small>{recibe.length ? <ul>{recibe.map((e) => enlace(e.de, e.etiqueta))}</ul> : <span className="kj-nulo">nadie</span>}</div>
          <div><small>Entrega a</small>{entrega.length ? <ul>{entrega.map((e) => enlace(e.a, e.etiqueta))}</ul> : <span className="kj-nulo">nadie</span>}</div>
        </div>
      </Seccion>
      <Seccion titulo="Estado">
        <dl className="kj-dl">
          <div><dt>Laboratorio</dt><dd>{c.escenarios.length ? `${c.escenarios.length} ${c.escenarios.length === 1 ? 'escenario' : 'escenarios'}` : 'sin laboratorio'}</dd></div>
          <div><dt>Hallazgos abiertos</dt><dd>{c.hallazgos.length}</dd></div>
          <div><dt>Modo</dt><dd>{datos.modo === 'produccion' ? 'producción' : 'desarrollo'}</dd></div>
          <div><dt>Ficha</dt><dd><code>docs/laboratorio/componentes.md</code></dd></div>
        </dl>
      </Seccion>
    </>
  );
}

// ── Laboratorio ─────────────────────────────────────────────────────────────────────────────────────

function MetricaFila({ c, ultima, nombre }: { c: Componente; ultima: UltimaEjecucion; nombre: string }) {
  const v = ultima.metricas[nombre] ?? null;
  const esc = c.escenarios.find((e) => e.id === ultima.escenario);
  const u = parsearUmbral(esc?.umbrales[nombre]);
  const ok = u ? cumple(v, u) : null;
  return (
    <li className="kj-metrica">
      <span>{etiquetaMetrica(nombre)}</span>
      <b>{formatear(nombre, v)}</b>
      <span className="kj-umbral" data-ok={ok === null ? undefined : String(ok)}>{u ? <>{u.texto}<i aria-label={ok ? 'cumple' : ok === false ? 'no cumple' : 'sin dato'}>{ok === null ? '' : ok ? ' ✓' : ' ✗'}</i></> : ''}</span>
    </li>
  );
}

function EscenarioTarjeta({ c, e }: { c: Componente; e: Escenario }) {
  const u = c.ultimas.find((x) => x.escenario === e.id);
  const nombres = u ? Object.keys(u.metricas) : [];
  const otros = Object.entries(e.umbrales).filter(([k]) => !nombres.includes(k));
  return (
    <article className="kj-escenario">
      <header>
        <b>{e.id}</b>
        <span className={`kj-tipo ${e.tipo}`}>{e.tipo}</span>
      </header>
      <p>{e.descripcion}</p>
      {u ? (
        <>
          <p className="kj-ultima">
            <span>{fechaHora(u.inicio)}</span><span>muestra {u.muestra}</span><span>{duracion(u.ms)}</span>
            <span className={u.suficiente ? 'si' : 'no'}>{u.suficiente ? 'muestra suficiente' : 'muestra corta: sin conclusiones'}</span>
          </p>
          {u.error && <p className="kj-error" role="alert">{u.error}</p>}
          <ul className="kj-metricas">{nombres.map((n) => <MetricaFila key={n} c={c} ultima={u} nombre={n} />)}</ul>
        </>
      ) : <p className="kj-vacio">Sin ejecutar todavía.</p>}
      {otros.length > 0 && <p className="kj-umbrales-extra">{otros.map(([k, t]) => <span key={k}>{k.replace(/_/g, ' ')}: {t}</span>)}</p>}
    </article>
  );
}

function HallazgoTarjeta({ h }: { h: Hallazgo }) {
  return (
    <article className="kj-hallazgo" data-sev={h.severidad}>
      <header><span className="kj-sev">{h.severidad}</span><b>{h.titulo}</b></header>
      <p><small>Evidencia</small>{h.evidencia}</p>
      <p><small>Propuesta</small>{h.propuesta}</p>
      {h.borrador && <details><summary>Borrador generado</summary><pre>{h.borrador}</pre></details>}
    </article>
  );
}

function Laboratorio({ c, datos }: { c: Componente; datos: Arquitectura }) {
  const { ejecutando, aviso } = useVista();
  const tiene = c.escenarios.length > 0;
  const produccion = datos.modo === 'produccion';
  const { tarea } = useVista();
  const falta = produccion && !tarea.trim();
  return (
    <>
      {(tiene || Object.keys(c.configuracion).length > 0) && (
        <Seccion titulo="Configuración usada" nota="lo que mide el laboratorio">
          {Object.keys(c.configuracion).length ? <Valor v={c.configuracion} /> : <p className="kj-vacio">Este componente no declara configuración.</p>}
        </Seccion>
      )}
      {tiene ? (
        <>
          <Seccion titulo="Escenarios" nota={`${c.escenarios.length}`}>
            <div className="kj-escenarios">{c.escenarios.map((e) => <EscenarioTarjeta key={e.id} c={c} e={e} />)}</div>
          </Seccion>
          <Seccion titulo="Hallazgos" nota={c.hallazgos.length ? `${c.hallazgos.length}` : undefined}>
            {c.hallazgos.length ? <div className="kj-hallazgos">{c.hallazgos.map((h) => <HallazgoTarjeta key={h.clave} h={h} />)}</div> : <p className="kj-vacio">Sin hallazgos abiertos.</p>}
          </Seccion>
          <div className="kj-acciones">
            {produccion && <CampoTarea id={`kj-tarea-${c.id}`} />}
            <div className="kj-acciones-fila">
              <button type="button" className="kj-boton primario" disabled={ejecutando !== null || falta} onClick={() => void ejecutar(c.id)} aria-busy={ejecutando === c.id}>
                {ejecutando === c.id ? 'Ejecutando…' : 'Ejecutar este laboratorio'}
              </button>
              <button type="button" className="kj-boton" onClick={() => poner({ pestana: 'rendimiento' })}>Ver historial</button>
            </div>
            <p className="kj-nota">{falta ? 'En producción hace falta una tarea aceptada de Atlas dev.' : 'No cambia nada: solo mide y guarda el resultado. Las propuestas no se generan desde aquí.'}</p>
            {aviso && <p className={`kj-aviso ${aviso.tipo}`} role={aviso.tipo === 'error' ? 'alert' : 'status'}>{aviso.texto}</p>}
          </div>
        </>
      ) : (
        <Seccion titulo="Laboratorio">
          <div className="kj-pendiente"><b>Sin laboratorio</b><span>{c.pendiente ?? 'Aún no tiene escenarios.'}</span></div>
        </Seccion>
      )}
    </>
  );
}

// ── Cómo funciona ───────────────────────────────────────────────────────────────────────────────────

const detalleDe = (c: Componente, escenario: string): Record<string, unknown> => ((c.detalle ?? {})[escenario] ?? {}) as Record<string, unknown>;

function Funciona({ c }: { c: Componente }) {
  const reglas = (detalleDe(c, 'fidelidad').reglas ?? []) as { regla: string; casa: number; elegida: number }[];
  return (
    <>
      <p className="kj-resumen-texto">{c.ficha.resumen}</p>
      <DiagramaFuncionamiento ficha={c.ficha} nombre={c.id} />
      {c.ficha.reglas?.length ? (
        <Seccion titulo="Reglas">
          <ol className="kj-reglas">{c.ficha.reglas.map((r, i) => <li key={i}>{r}</li>)}</ol>
        </Seccion>
      ) : null}
      {reglas.length > 0 && (
        <Seccion titulo="Ejemplo con datos reales" nota={`perfil ${String(detalleDe(c, 'fidelidad').perfil ?? '')}`}>
          <BarrasHorizontales titulo="Cada regla del perfil: veces que casa y veces que decide" nota="barra clara = casa · barra llena = elegida" filas={reglas.map((r) => ({ nombre: r.regla, valor: r.elegida, secundario: r.casa, extra: `de ${r.casa}` }))} />
          {reglas.some((r) => r.casa > 0 && r.elegida === 0) && <p className="kj-nota">Una regla que casa pero nunca decide está tapada por otra anterior: es lo que busca el laboratorio.</p>}
        </Seccion>
      )}
    </>
  );
}

// ── Rendimiento ─────────────────────────────────────────────────────────────────────────────────────

const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('es-ES'));
function Kpi({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return <div className="kj-kpi"><b>{valor}</b><small>{etiqueta}</small></div>;
}

function Rendimiento({ c }: { c: Componente }) {
  const clave = metricaClave(c);
  const op = c.operacion;
  const porEscenario = c.escenarios.map((e) => ({ e, metricas: Object.keys(c.historial).filter((m) => c.historial[m]!.some((p) => p.escenario === e.id)) })).filter((x) => x.metricas.length);
  const ultimas = Object.assign({}, ...c.ultimas.map((u) => u.metricas)) as Record<string, number | null>;
  const conc = detalleDe(c, 'concordancia');
  const matriz = conc.matriz_humano_vs_karajan as Record<string, Record<string, number>> | undefined;
  const segmentos = conc.por_segmento as Record<string, { n: number; concordancia: number }> | undefined;
  const fuentes = conc.fuentes as Record<string, number> | undefined;
  const esSelector = c.id === 'selector' && ('f1' in ultimas || 'f1_actual' in ultimas);
  const sinNada = !op && !porEscenario.length;
  return (
    <>
      {op && (
        <Seccion titulo="Actividad" nota={op.ultima_actividad ? `última: ${fechaHora(op.ultima_actividad)}` : undefined}>
          <div className="kj-kpis">
            <Kpi etiqueta="tareas" valor={n(op.tareas)} />
            <Kpi etiqueta="runs" valor={n(op.runs)} />
            <Kpi etiqueta="latencia p50" valor={duracion(op.latencia_p50_ms)} />
            <Kpi etiqueta="coste" valor={op.coste_total_usd === null || op.coste_total_usd === undefined ? '—' : `${op.coste_total_usd.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`} />
            <Kpi etiqueta="tokens" valor={n(op.tokens)} />
          </div>
          {op.extra && Object.keys(op.extra).length > 0 && <Valor v={op.extra} />}
        </Seccion>
      )}
      {c.avisos && c.avisos.length > 0 && <ul className="kj-avisos">{c.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>}
      {sinNada && (
        <div className="kj-pendiente"><b>Sin datos de rendimiento</b><span>{c.escenarios.length ? 'Ejecuta el laboratorio para ver su serie.' : (c.pendiente ?? 'Cuando tenga laboratorio y actividad registrada, sus gráficas saldrán aquí.')}</span></div>
      )}
      {esSelector && <BarrasSelector actual={ultimas} calibrado={ultimas} />}
      {matriz && Object.keys(matriz).length > 0 && <MatrizConcordancia matriz={matriz} />}
      {segmentos && Object.keys(segmentos).length > 0 && (
        <BarrasHorizontales titulo="Concordancia por segmento" nota="dominio × nivel" max={1} formato={(v) => formatear('concordancia', v)} filas={Object.entries(segmentos).map(([nombre, s]) => ({ nombre, valor: s.concordancia, extra: `n=${s.n}` }))} />
      )}
      {fuentes && <BarrasHorizontales titulo="De dónde sale la verdad humana" nota="casos por fuente" filas={Object.entries(fuentes).map(([nombre, valor]) => ({ nombre, valor }))} />}
      {porEscenario.map(({ e, metricas }, i) => (
        <details key={e.id} className="kj-historial" open={clave ? metricas.includes(clave) : i === 0}>
          <summary><b>{e.id}</b><span className={`kj-tipo ${e.tipo}`}>{e.tipo}</span><small>{metricas.length} {metricas.length === 1 ? 'métrica' : 'métricas'} · {c.historial[metricas[0]!]!.length} ejecuciones</small></summary>
          <div className="kj-figuras">
            {metricas.map((m) => <GraficaMetrica key={m} metrica={m} puntos={c.historial[m]!} umbral={umbralDe(c, m)} />)}
          </div>
        </details>
      ))}
    </>
  );
}
