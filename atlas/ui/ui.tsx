import './atlas.css';
import { PanelSkills } from './panel-skills';
import { crearVentana } from './ventana';

/**
 * Entrada de la UI de Karajan para Atlas dev. Atlas dev pone React, su runtime JSX y recharts en `window.AtlasShared`
 * (ver `atlas/build.mjs`) y carga este fichero, que se registra como `window.AtlasPaquetes['karajan']`.
 */
declare global {
  interface Window { AtlasPaquetes?: Record<string, unknown> }
}
window.AtlasPaquetes ??= {};
// `ventana`: icono + panel + página. `panelSkills`: componente suelto que Atlas dev monta en la fase «Preparando» de una tarea
// con `<PanelSkills api={'/paquetes/karajan/api'} tarea prompt propuestas alConfirmar />` (ver docs/laboratorio/preparado-si-no.md).
window.AtlasPaquetes['karajan'] = { ventana: crearVentana(), panelSkills: PanelSkills };
