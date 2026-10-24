import './atlas.css';
import { crearVentana } from './ventana';

/**
 * Entrada de la UI de Karajan para Atlas dev. Atlas dev pone React, su runtime JSX y recharts en `window.AtlasShared`
 * (ver `atlas/build.mjs`) y carga este fichero, que se registra como `window.AtlasPaquetes['karajan']`.
 */
declare global {
  interface Window { AtlasPaquetes?: Record<string, unknown> }
}
window.AtlasPaquetes ??= {};
window.AtlasPaquetes['karajan'] = { ventana: crearVentana() };
