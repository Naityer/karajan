# Preparado: ¿son correctas estas skills? (sí/no)

Especificación para el **borrador de Atlas dev** que conecta el panel `PanelSkills` de Karajan con la fase «Preparado» de una tarea. Karajan ya aporta el componente y las rutas; falta montarlo en Atlas dev (esa integración va como borrador, nunca se aplica directo).

## Qué hace Karajan (ya hecho)

| Pieza | Dónde |
| --- | --- |
| Componente `PanelSkills` | `atlas/ui/panel-skills.tsx` (lógica pura en `atlas/ui/panel-skills-logica.ts`, probada en `atlas/tests/panel-skills.test.ts`) |
| Registro | `window.AtlasPaquetes['karajan'].panelSkills` (`atlas/ui/ui.tsx`, junto a `ventana`) |
| Sugerencias ponderadas + buscador | `GET /laboratorio/sugerencias-skills?prompt=&q=` (usa `puntuarSkills`) |
| Guardar la respuesta | `POST /laboratorio/calibracion` `{tarea, componente:'selector', propuesta, respuesta, correccion}`; las skills de `correccion` que no existan (ni instaladas ni en la biblioteca) se descartan y vuelven en `descartadas` |
| Leer la última respuesta | `GET /laboratorio/calibracion?tarea=<id>` → `{calibrada:false}` o `{calibrada:true, respuesta, propuesta, correccion, creada}` |
| Quién la consume | el escenario `calibracion` del selector (`atlas/src/lab/selector.lab.ts`): «sí» = lo propuesto es la verdad; «no» = la corrección |

Solo se guarda el **hash** del id de la tarea (sal local); el prompt nunca se persiste.

## Contrato de montaje

Atlas dev ya carga `ui.js` del paquete y registra `window.AtlasPaquetes[<id>]` (`web/src/features/paquetes/cargar-paquetes.tsx`; el tipo `RegistroUi` solo conoce `widgets` y `ventana`, hay que añadirle `panelSkills?`). El componente se pinta igual que `ventana.Panel`: dentro de `aislarPaquete(...)`, con la `api` del proxy.

```tsx
const Panel = window.AtlasPaquetes?.['karajan']?.panelSkills;   // ComponentType<PropsPanelSkills> | undefined
{Panel && aislarPaquete('Skills de Karajan',
  <Panel api="/paquetes/karajan/api" tarea={tarea.id} prompt={tarea.prompt}
         propuestas={skillsDeCabecera} alConfirmar={(skills, respuesta) => …} />)}
```

| Prop | Tipo | Valor |
| --- | --- | --- |
| `api` | `string` | `/paquetes/karajan/api` (proxy del paquete) |
| `tarea` | `string` | `tarea.id` (el servidor lo hashea; `/^[\w-]{1,40}$/`) |
| `prompt` | `string` | `tarea.prompt` (el panel solo manda los primeros 1500 caracteres en la URL) |
| `propuestas` | `string[]` | las skills de la cabecera: `cabecera.decisiones` con `campo === 'skills'`, separadas por «, » (ignorar `las elige el agente` y `Ninguna`) o, si la hoja las fija, `tarea.hoja.skills` |
| `alConfirmar` | `(skills: string[], respuesta: 'si'\|'no'\|'sin_revisar') => void` | opcional; se llama **después** de guardar la calibración |

Si `panelSkills` no está registrado (paquete antiguo, deshabilitado o `ui.js` sin recargar) no se pinta nada y la fase sigue como hoy.

## Dónde montarlo (atlas-dev, solo lectura aquí)

- Fichero: `web/src/features/operaciones/monitor/detalle-fases.tsx`, componente `PanelPreparado({ tarea, items })`.
- Posición: un `Bloque titulo="Skills" tono="mostaza"` entre «Cabecera» y «Cuerpo», solo si hay propuesta (`propuestas.length > 0` o la cabecera trae `skills`) y la tarea está en una fase en la que aún se puede cambiar (`borrador`/`encolada`, o `preparada` si se introduce la pausa de abajo).
- Helper nuevo (mismo fichero o `pipeline.tsx`, junto a `completarCabecera`): `skillsPropuestas(cab, hoja): string[]`.
- Aislado con `aislarPaquete` (un fallo del paquete no rompe el monitor).

## Qué se hace con la respuesta

- **Sí**: no cambia nada en la tarea; Karajan guarda la calibración `si`.
- **No** (o «sí» tras corregir): `alConfirmar(skills)` debe actualizar `hoja.skills` con `useAccionesCola().editar({ id, skills })` para que el agente reciba las skills corregidas; el panel ya guardó la calibración `no` con la corrección.
- La tarea y su hoja se tocan siempre por la acción de Atlas dev; el panel nunca escribe en la cola.

## Cuándo pausar la tarea

Pausar es opcional y por tarea; no debe frenar la cola de forma indefinida.

1. Al pasar a «Preparado» con propuesta no vacía y sin calibración previa (`GET /laboratorio/calibracion?tarea=` → `calibrada:false`), la tarea espera la respuesta **hasta 10 minutos** (valor propuesto; ajuste de la cola, no de Karajan). El Monitor lo marca como «esperando tu respuesta» (mostaza, igual que `esperando`).
2. Si la persona responde (sí o no) antes del límite, la tarea sigue en cuanto `alConfirmar` termine.
3. Si **no responde** en el tiempo límite, la tarea sigue con la propuesta tal cual y Atlas dev llama a `POST /laboratorio/calibracion` con `{tarea, componente:'selector', propuesta, respuesta:'sin_revisar', correccion:[]}`. `sin_revisar` no entrena al selector (el escenario `calibracion` ignora esas filas) pero deja constancia.
4. Si ya hay calibración previa (la tarea se reencola o reentra), no se pausa ni se vuelve a preguntar; el panel enseña la respuesta guardada con «Cambiar respuesta».
5. Tareas en modo `auto` sin skills propuestas, o lanzadas por rutinas (vigilantes), no se pausan.

## Criterios de aceptación

1. En «Preparado» aparece el bloque «Skills» con la pregunta «¿Son correctas estas skills?» y los botones **Sí** / **No**, usando solo `window.AtlasPaquetes['karajan'].panelSkills`; sin el paquete no cambia nada.
2. **Sí** guarda una fila `si` (una sola) en la tabla `calibracion` y deja la hoja intacta.
3. **No** muestra las sugerencias ponderadas del prompt y un buscador (espera 300 ms tras la última tecla); cada tarjeta enseña nombre, descripción, estrellas (propias o «heredadas»), grupo y si está instalada, en el almacén o instalable; el enlace «GitHub ↗» abre `repo_url` en otra pestaña (`rel="noopener noreferrer"`) y solo si es `https://github.com/…`.
4. Al confirmar tras **No** se guarda `respuesta:'no'` con `correccion` = skills finales, `hoja.skills` se actualiza con ellas y la tarea continúa. Si la persona deja las mismas skills, se guarda `si`.
5. Recargar el Monitor sobre una tarea ya calibrada no vuelve a preguntar: muestra el resultado y permite cambiarlo.
6. Sin respuesta en el tiempo límite la tarea sigue con la propuesta y queda `sin_revisar`.
7. Sin Karajan en marcha (proxy 502) el bloque muestra el error del panel y la tarea sigue sin pausarse.
8. Es operable con teclado (Tab, Espacio en las tarjetas, Intro en botones), cada tarjeta es una casilla con nombre accesible, el resultado de la búsqueda se anuncia (`aria-live`) y respeta modo oscuro y `prefers-reduced-motion`.
9. Dos ejecuciones de la misma tarea no duplican filas con la misma respuesta si no hay cambio (la integración comprueba `GET /laboratorio/calibracion` antes de guardar `sin_revisar`).
10. Tests de Atlas dev: el bloque no se pinta sin `panelSkills`; con él, `alConfirmar` actualiza `hoja.skills`; el temporizador marca `sin_revisar`.

## Ver el panel sin Atlas dev

`node atlas/ui/dev.mjs` y abrir `http://localhost:4260/?vista=skills` (añade `&tema=dark` para el modo oscuro). Las dos rutas del servidor están simuladas con `atlas/ui/fixtures/skills.json`; `npm run build --prefix atlas` empaqueta el componente en `dist-atlas/ui.js`.
