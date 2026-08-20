// Punto de entrada histórico del dashboard.
//
// El código real vive ahora en `src/` (nota "Plan de mejora", §18): `shared.js`
// + `shell.js` + `decision.js` + `flow.js` + `monitor.js` + `inspiration.js` +
// `human-control.js`, en vez de este único archivo de ~11.700 líneas. Este
// fichero se conserva con su nombre y ruta (`index.html` lo referencia con
// `?v=` para el cache-busting de `_static_asset_version()`) como un simple
// reenvío, para no tener que tocar el HTML ni el versionado de estáticos en
// el mismo cambio que la extracción.
import "./src/main.js";
