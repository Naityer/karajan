import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AtlasDev } from '../atlas-dev';
import { type Hallazgo, type Pasarela } from '../pasarela-borradores';
import { configDesde, guardarConfig, leerConfig, type ConfigAnalisis } from './config';
import { destilar, type PropuestaDestilacion } from './destilacion';
import { Cadena, type Backend } from './proveedores';
import { bitacoraEnFichero, Repositorio, dirRegistroPorDefecto } from './repositorio';
import { estadoHistorico, exportarMuestras, procesarPendientes, type Informe, type TareaCola } from './rutina';
import { TAXONOMIA, TAXONOMIA_VERSION } from './taxonomia';

/**
 * Servicio del análisis: une configuración, registro, cola de Atlas dev, cadena de proveedores y bitácora para que las rutas y la CLI
 * sean finas. Solo hay una pasada a la vez (una segunda recibe 409): dos rutinas escribiendo el mismo `analisis.json` no aportan nada.
 */
export interface OpcionesServicio {
  /** Carpeta de datos del paquete (`<datos>`); aquí van `analisis.json`, la bitácora y el último informe. */
  datos: string; atlasDev?: Pick<AtlasDev, 'tareas'>; pasarela?: Pick<Pasarela, 'proponer'>; backend?: Backend; env?: NodeJS.ProcessEnv;
}
export interface PeticionProceso { limite?: number; forzar?: boolean; soloRegistro?: boolean }

export class ErrorServicio extends Error { constructor(readonly estado: number, mensaje: string) { super(mensaje); } }

export class ServicioAnalisis {
  private enCurso = false;
  readonly rutaConfig: string; readonly rutaBitacora: string; private readonly rutaInforme: string; private readonly rutaDestilacion: string;
  constructor(private readonly o: OpcionesServicio) {
    const dir = join(o.datos, 'analisis');
    this.rutaConfig = join(o.datos, 'analisis.json'); this.rutaBitacora = join(dir, 'bitacora.jsonl');
    this.rutaInforme = join(dir, 'ultimo-informe.json'); this.rutaDestilacion = join(dir, 'destilacion.json');
  }

  config(): ConfigAnalisis { return leerConfig(this.rutaConfig); }
  guardarConfig(parcial: unknown): ConfigAnalisis {
    const p = (parcial && typeof parcial === 'object' ? parcial : {}) as Record<string, unknown>;
    const nueva = configDesde({ ...this.config(), ...p, destilacion: { ...this.config().destilacion, ...((p['destilacion'] as object | undefined) ?? {}) } });
    guardarConfig(this.rutaConfig, nueva);
    return nueva;
  }

  private repo(): Repositorio {
    const dir = this.config().dirRegistro ?? dirRegistroPorDefecto(this.o.env);
    if (!dir) throw new ErrorServicio(422, 'no hay carpeta de registro: define dirRegistro en analisis.json o ATLAS_REGISTRO_DIR / ATLAS_VAULT');
    return new Repositorio(dir);
  }

  async procesar(p: PeticionProceso = {}): Promise<Informe> {
    if (this.enCurso) throw new ErrorServicio(409, 'ya hay un análisis en curso');
    this.enCurso = true;
    try {
      const cfg = this.config(), repo = this.repo();
      const cadena = new Cadena(cfg.cadena, { permitirGemini: cfg.permitirGemini, maxGeminiPorEjecucion: cfg.maxGeminiPorEjecucion, timeoutMs: cfg.timeoutMs }, this.o.backend);
      const atlas = this.o.atlasDev;
      const cola = cfg.usarCola && !p.soloRegistro && atlas ? async (): Promise<TareaCola[]> => (await atlas.tareas()).map((t) => ({ id: t.id, titulo: t.titulo, estado: t.estado, prompt: t.prompt, hoja: t.hoja ?? undefined })) : undefined;
      const informe = await procesarPendientes({ repo, ...(cola ? { cola } : {}) }, cadena, {
        limite: p.limite ?? cfg.limitePorEjecucion, forzar: p.forzar === true, maxIntentos: cfg.maxIntentos, bitacora: bitacoraEnFichero(this.rutaBitacora),
      });
      this.escribir(this.rutaInforme, informe);
      return informe;
    } finally { this.enCurso = false; }
  }

  estado() {
    const ultimo = this.leer<Informe>(this.rutaInforme);
    return { ...estadoHistorico(this.repo()), en_curso: this.enCurso, ultimo_informe: ultimo, destilacion: this.leer<PropuestaDestilacion>(this.rutaDestilacion), bitacora: this.rutaBitacora };
  }

  tarea(id: string) {
    const f = this.repo().todos().find((x) => x.tarea_id === id);
    if (!f) throw new ErrorServicio(404, 'Sin análisis para esa tarea');
    return f;
  }

  taxonomia() { return { version: TAXONOMIA_VERSION, ejes: TAXONOMIA }; }
  exportar() { return { version_taxonomia: TAXONOMIA_VERSION, muestras: exportarMuestras(this.repo()) }; }

  /** Etapa de destilación (apagada por defecto): propone alias/términos nuevos; la persona decide, porque entra como borrador. */
  async destilar(): Promise<PropuestaDestilacion & { borrador: unknown }> {
    const cfg = this.config(), propuesta = await destilar(this.repo(), cfg.destilacion, { permitirGemini: cfg.permitirGemini, timeoutMs: cfg.timeoutMs }, this.o.backend);
    this.escribir(this.rutaDestilacion, propuesta);
    let borrador: unknown = null;
    if (propuesta.acciones.length && this.o.pasarela) {
      const h: Hallazgo = {
        clave: `taxonomia-v${TAXONOMIA_VERSION}`, severidad: 'media', titulo: `Revisar la taxonomía del análisis de tareas (v${TAXONOMIA_VERSION})`,
        evidencia: `${propuesta.pendientes} valores sin normalizar. Propuesta de ${propuesta.proveedor ?? '?'}:\n${JSON.stringify(propuesta.acciones, null, 2)}`,
        propuesta: 'Aplicar las acciones que se consideren correctas en atlas/src/analisis/taxonomia.ts y subir TAXONOMIA_VERSION y VERSION_ANALISIS.',
      };
      borrador = await this.o.pasarela.proponer('analisis', h);
    }
    return { ...propuesta, borrador };
  }

  private leer<T>(ruta: string): T | null { try { return JSON.parse(readFileSync(ruta, 'utf8')) as T; } catch { return null; } }
  private escribir(ruta: string, v: unknown) {
    try { mkdirSync(dirname(ruta), { recursive: true }); writeFileSync(`${ruta}.tmp`, JSON.stringify(v, null, 2), 'utf8'); renameSync(`${ruta}.tmp`, ruta); } catch { /* sin disco no se rompe la rutina */ }
  }
}
