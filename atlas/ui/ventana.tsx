import { useEffect, useRef, useState, type ComponentType } from 'react';

import { cargar, coincide, componentePorId, contarEstados, ejecutar, fechaHora, poner, useVista } from './datos';
import { CampoTarea, Detalle, Estadillo } from './detalle';
import { Esquema } from './esquema';
import { ESTADOS, type Arquitectura } from './tipos';

/**
 * Ventana de Karajan en Atlas dev (`ui.ventana` del manifiesto): un icono en la barra de actividad con
 *  - un panel lateral: modo, contadores, búsqueda y filtro por estado, y «Ejecutar todos los laboratorios»;
 *  - una página central: el esquema por familias y, al pulsar una caja, el detalle del componente.
 * Los dos leen el mismo estado (`datos.ts`), así que filtrar o elegir en el panel se ve al instante en el esquema.
 */
interface Props { api: string }

type Compartido = { ui?: { SinConexionApp?: ComponentType<{ app: string; como: string }> } };
function SinConexion({ error, alReintentar }: { error: string; alReintentar: () => void }) {
  const Fuera = (window as unknown as { AtlasShared?: Compartido }).AtlasShared?.ui?.SinConexionApp;
  return (
    <div className="kj-sin-conexion" role="alert">
      {Fuera ? <Fuera app="Karajan" como="Karajan no responde. Reinstala o arranca el paquete en Paquetes y vuelve a intentarlo." /> : <p><b>Karajan no responde.</b> Reinstala o arranca el paquete en Paquetes y vuelve a intentarlo.</p>}
      <p className="kj-nota">{error}</p>
      <button type="button" className="kj-boton" onClick={alReintentar}>Reintentar</button>
    </div>
  );
}

function Esqueleto() {
  return <div className="kj-esqueleto" aria-busy="true" aria-label="Cargando la arquitectura">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} />)}</div>;
}

function Modo({ modo }: { modo: Arquitectura['modo'] }) {
  return <span className={`kj-modo ${modo}`} title={modo === 'produccion' ? 'Cambios bloqueados sin una tarea aceptada de Atlas dev' : 'Modo desarrollo: sin guardián'}>{modo === 'produccion' ? 'Producción' : 'Desarrollo'}</span>;
}

export function crearVentana(): { Panel: ComponentType<Props>; Pagina: ComponentType<Props> } {
  function Panel({ api }: Props) {
    const v = useVista();
    const [confirmar, setConfirmar] = useState(false);
    useEffect(() => { void cargar(api); }, [api]);
    const d = v.datos;
    const n = d ? contarEstados(d) : null;
    const total = d?.componentes.length ?? 0;
    const conLab = d?.componentes.filter((c) => c.escenarios.length > 0).length ?? 0;
    const hallazgos = d?.componentes.reduce((s, c) => s + c.hallazgos.length, 0) ?? 0;
    const produccion = d?.modo === 'produccion';
    const sinTarea = produccion && !v.tarea.trim();
    const visibles = d ? d.componentes.filter((c) => coincide(c, v.filtro, v.busqueda)) : [];
    return (
      <div className="kj-atlas kj-panel">
        {v.fase === 'cargando' && !d && <Esqueleto />}
        {v.fase === 'error' && !d && <SinConexion error={v.error ?? ''} alReintentar={() => void cargar(api)} />}
        {d && n && (
          <>
            <div className="kj-panel-cab"><b>Arquitectura</b><Modo modo={d.modo} />{v.demo && <span className="kj-modo demo">Demo</span>}</div>
            <div className="kj-kpis panel" aria-label="Resumen de la arquitectura">
              <div className="kj-kpi"><b>{total}</b><small>componentes</small></div>
              <div className="kj-kpi"><b>{conLab}</b><small>con laboratorio</small></div>
              <div className="kj-kpi" data-alerta={hallazgos > 0 || undefined}><b>{hallazgos}</b><small>hallazgos</small></div>
              <div className="kj-kpi"><b>{n.sin_ejecutar}</b><small>sin ejecutar</small></div>
            </div>
            <label className="kj-buscar">
              <span className="kj-solo-lectores">Buscar componente</span>
              <input type="search" value={v.busqueda} placeholder="Buscar componente…" onChange={(e) => poner({ busqueda: e.target.value })} />
            </label>
            <div className="kj-chips" role="group" aria-label="Filtrar por estado">
              <button type="button" aria-pressed={v.filtro === 'todos'} className={v.filtro === 'todos' ? 'on' : ''} onClick={() => poner({ filtro: 'todos' })}>Todos <small>{total}</small></button>
              {ESTADOS.filter((e) => n[e.id] > 0).map((e) => (
                <button key={e.id} type="button" aria-pressed={v.filtro === e.id} className={v.filtro === e.id ? 'on' : ''} onClick={() => poner({ filtro: v.filtro === e.id ? 'todos' : e.id })}><i className="kj-punto" data-estado={e.id} aria-hidden="true" />{e.corto} <small>{n[e.id]}</small></button>
              ))}
            </div>
            <ul className="kj-lista" aria-label="Componentes">
              {visibles.map((c) => (
                <li key={c.id}>
                  <button type="button" aria-pressed={v.seleccion === c.id} className={v.seleccion === c.id ? 'on' : ''} onClick={() => poner({ seleccion: v.seleccion === c.id ? null : c.id })}>
                    <i className="kj-punto" data-estado={c.estado} aria-hidden="true" /><span>{c.id}</span>
                    {c.hallazgos.length > 0 && <em className="kj-caja-n">{c.hallazgos.length}</em>}
                    <span className="kj-solo-lectores">{ESTADOS.find((e) => e.id === c.estado)?.largo}</span>
                  </button>
                </li>
              ))}
              {!visibles.length && <li className="kj-vacio">Ningún componente coincide.</li>}
            </ul>
            <div className="kj-acciones">
              {produccion && <CampoTarea id="kj-tarea-todos" />}
              {!confirmar ? (
                <button type="button" className="kj-boton primario ancho" disabled={v.ejecutando !== null || sinTarea || conLab === 0} onClick={() => setConfirmar(true)} aria-busy={v.ejecutando === 'todos'}>
                  {v.ejecutando === 'todos' ? 'Ejecutando…' : 'Ejecutar todos los laboratorios'}
                </button>
              ) : (
                <div className="kj-confirmar" role="alertdialog" aria-label="Confirmar la ejecución de todos los laboratorios">
                  <p>Se ejecutarán los {conLab} laboratorios sin proponer cambios. Tardan unos segundos.</p>
                  <div className="kj-acciones-fila">
                    <button type="button" className="kj-boton primario" autoFocus onClick={() => { setConfirmar(false); void ejecutar('todos'); }}>Ejecutar</button>
                    <button type="button" className="kj-boton" onClick={() => setConfirmar(false)}>Cancelar</button>
                  </div>
                </div>
              )}
              {sinTarea && <p className="kj-nota">En producción hace falta una tarea aceptada de Atlas dev.</p>}
              {v.aviso && <p className={`kj-aviso ${v.aviso.tipo}`} role={v.aviso.tipo === 'error' ? 'alert' : 'status'}>{v.aviso.texto}</p>}
            </div>
          </>
        )}
      </div>
    );
  }

  function Pagina({ api }: Props) {
    const v = useVista();
    const cajon = useRef<HTMLDivElement>(null);
    useEffect(() => { void cargar(api); }, [api]);
    const d = v.datos;
    const c = componentePorId(d, v.seleccion);
    // En pantallas estrechas el detalle va debajo del esquema: se lleva a la vista al elegir una caja.
    useEffect(() => {
      if (!c || !cajon.current) return;
      const el = cajon.current;
      if (el.getBoundingClientRect().top > window.innerHeight * 0.7) el.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }, [c?.id]);
    return (
      <div className="kj-atlas kj-pagina" onKeyDown={(e) => { if (e.key === 'Escape' && v.seleccion && !(e.target as HTMLElement).closest('input,textarea')) poner({ seleccion: null }); }}>
        <header className="kj-cab">
          <div>
            <h1>Arquitectura de Karajan</h1>
            {d && <p className="kj-sub"><span>v{d.version}</span><span>generada {fechaHora(d.generado)}</span>{v.demo && <span className="kj-modo demo">Datos de ejemplo</span>}</p>}
          </div>
          <span className="kj-relleno" />
          {d && <Modo modo={d.modo} />}
          <button type="button" className={`kj-boton${v.flujo ? ' on' : ''}`} aria-pressed={v.flujo} onClick={() => poner({ flujo: !v.flujo })} title="Dibuja las flechas entre componentes (enlaces)">Mostrar flujo</button>
          <button type="button" className="kj-boton" onClick={() => void cargar(api)} disabled={v.fase === 'cargando'}>Refrescar</button>
        </header>
        {v.fase === 'cargando' && !d && <Esqueleto />}
        {v.fase === 'error' && !d && <SinConexion error={v.error ?? ''} alReintentar={() => void cargar(api)} />}
        {v.fase === 'error' && d && <p className="kj-aviso error" role="alert">No se pudo refrescar: {v.error}</p>}
        {d && (
          <>
            <ul className="kj-leyenda" aria-label="Leyenda de estados">
              {ESTADOS.map((e) => <li key={e.id}><i className="kj-punto" data-estado={e.id} aria-hidden="true" />{e.corto}</li>)}
              <li className="kj-leyenda-sec">Pulsa una caja para ver su detalle</li>
            </ul>
            <div className={`kj-cuerpo${c ? ' con-detalle' : ''}`}>
              <Esquema datos={d} seleccion={v.seleccion} filtro={v.filtro} busqueda={v.busqueda} flujo={v.flujo} />
              {c && <div className="kj-cajon" ref={cajon}><Detalle key={c.id} c={c} datos={d} alCerrar={() => poner({ seleccion: null })} /></div>}
            </div>
          </>
        )}
      </div>
    );
  }

  return { Panel, Pagina };
}

export { Estadillo };
