// Punto de entrada del dashboard (nota "Plan de mejora", §18).
//
// `shell.js` importa transitivamente `decision.js`, `flow.js`, `monitor.js` e
// `inspiration.js` (y todos esos, `shared.js`) — cargarlo basta para que las
// cuatro vistas y el arranque (`init()`, al final de shell.js) queden listos.
// `human-control.js` es la única pieza que nadie más importa: expone
// `window.karajanCanvas` como efecto lateral de su propia IIFE, así que se
// carga explícitamente aquí.
import "./modules/shell.js";
import "./modules/human-control.js";
import "./registry-bootstrap.js";
