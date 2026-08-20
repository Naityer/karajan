// ---- distribución standalone -----------------------------------------------
// Nota "Plan de mejora", §4: es el modo que ya existe hoy — API local propia,
// `localStorage` del navegador, `KARAJAN_TOKEN` opcional, sin nada delante.
// `createRuntimeContext()` (core/runtime.js) YA construye exactamente esto por
// defecto, así que esta distribución es la identidad: existe para que Atlas y
// SaaS tengan un sitio simétrico donde vivir, no porque standalone necesite
// nada especial.
import { createRuntimeContext } from "../core/runtime.js";

export function createStandaloneContext(overrides = {}) {
  return createRuntimeContext({ mode: "standalone", overrides });
}
