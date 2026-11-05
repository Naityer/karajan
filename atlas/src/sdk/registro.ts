import { RegistroComandos } from './comandos';
import { comandoDependencias, comandosComponente } from './componentes-cli';
import { comandosControl } from './modulos/control';
import { comandosEstadisticas } from './modulos/estadisticas';
import { comandosInspiration } from './modulos/inspiration';

/**
 * Registro de comandos de Karajan. Aquí se enchufan los módulos (fachadas: estadisticas, inspiration, control) y los comandos
 * genéricos de componente; `cli.ts` solo resuelve contra él. Patrón Registry: un módulo nuevo se añade en esta lista.
 */
export function crearRegistro(): RegistroComandos {
  return new RegistroComandos().registrar(...comandosEstadisticas, ...comandosControl, ...comandosInspiration, comandoDependencias, ...comandosComponente);
}
