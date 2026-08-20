// Protocolo host de Atlas (v1) — lado add-on.
//
// El dashboard puede correr suelto o embebido en Atlas como módulo. Embebido, Atlas
// pone el marco:
//
//   - **Navegación**: las vistas se conmutan desde el panel lateral de Atlas. Como
//     son pestañas `data-view` y no rutas, se usa `?atlas_view=` al arrancar y
//     `postMessage` para cambiar sin recargar (así el estado del dashboard —filtros,
//     tarea seleccionada, mapa isométrico— sobrevive a navegar).
//   - **Marco**: con `?atlas_chrome=host` se ocultan la marca, las pestañas de vista
//     y el selector de paleta. Duplicarlos obliga al usuario a mirar dos
//     navegaciones que hacen lo mismo.
//   - **Herramientas**: el tutorial y los contadores de decisiones/agentes se
//     **describen** y Atlas los dibuja con sus componentes.
//   - **Tema**: el de Atlas manda, incluida su paleta.
//
// Todo lo hace este archivo leyendo y accionando el DOM que ya existe: `app.js` no
// se toca (más allá de la base de API, que sí necesita saber dónde está montado).
// Conmutar = accionar el control real, no duplicar su lógica.
//
// La navegación (`applyView`) pasa por `objectForDataView` — el registry de
// `src/registry-bootstrap.js` (nota "Plan de mejora", §6-§11) — en vez de
// buscar la pestaña a mano: el `data-view` que manda Atlas sigue siendo el
// mismo vocabulario de siempre, pero ahora se resuelve contra el catálogo de
// objetos UI en vez del DOM directamente. `type="module"` (como `app.js`,
// cargado antes en el documento) es lo que hace seguro este `import`: los
// módulos se difieren igual que `defer` y se evalúan en orden de documento,
// así que el registry ya existe cuando este script arranca.
//
// `?atlas_object=<id>` (nota §7/§12, F7) es un segundo modo de hospedaje,
// distinto de `?atlas_view=`: en vez de la pestaña completa, monta UN objeto
// de grano fino del catálogo (`mountObjectById`) — pensado para vivir en su
// propio iframe sandbox, más pequeño que el documento del dashboard, que es
// lo que `addon-object-host.tsx` de Atlas abre por objeto.
import { objectForDataView, mountObjectById } from './src/registry-bootstrap.js';

(function () {
  'use strict';

  var ATLAS_HOST_SOURCE = 'atlas-host';
  var ATLAS_ADDON_SOURCE = 'atlas-addon';

  // El nav existe en el HTML servido, pero app.js puede engancharlo algo después:
  // se reintenta un rato corto en lugar de perder la petición.
  var RETRY_MS = 150;
  var MAX_ATTEMPTS = 40;

  function param(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  var hosted = param('atlas_chrome') === 'host';
  var embedded = window.parent !== window;

  function postToHost(message) {
    if (embedded) window.parent.postMessage(message, '*');
  }

  // El relay de `fetch`/`EventSource`/`localStorage` vive en `atlas-relay.js`,
  // cargado ANTES que `app.js` (ver `index.html`) — tiene que estar instalado
  // antes de que `app.js` ejecute su primera línea, y este archivo se carga
  // DESPUÉS de `app.js` a propósito (necesita el DOM que `app.js` puebla).

  // ── Navegación ─────────────────────────────────────────────────────────────
  function applyView(view, attempt) {
    if (typeof view !== 'string' || !view) return;
    var object = objectForDataView(view);
    // `app.js` puede enganchar el nav algo después de que este script arranque
    // (los módulos se difieren, pero su propio `init()` async todavía tiene
    // trabajo que hacer) — igual que el `applyView` original, reintenta en vez
    // de perder la navegación si la pestaña/objeto aún no está listo.
    if (object && object.canMount()) {
      object.mount();
      return;
    }
    if (!object) {
      var tab = document.querySelector('.view-tab[data-view="' + view + '"]');
      if (tab) {
        tab.click();
        return;
      }
    }
    if ((attempt || 0) < MAX_ATTEMPTS) {
      setTimeout(function () {
        applyView(view, (attempt || 0) + 1);
      }, RETRY_MS);
    }
  }

  // ── Tema y paleta del host ─────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  // El mapeo vive aquí porque solo este dashboard sabe qué es su `--panel` o su
  // `--panel-2`. Atlas publica roles ("mi fondo", "mi acento"); aquí se colocan.
  // Solo se toca el chrome: los colores de estado (ok/warn/bad) y el amarillo de
  // decisión son significado, no decoración.
  function applyTokens(tokens) {
    if (!tokens) return;
    var root = document.documentElement;
    var set = function (variable, value) {
      if (value) root.style.setProperty(variable, value);
    };
    set('--bg', tokens.bg);
    set('--panel', tokens.raised || tokens.surface);
    set('--panel-2', tokens.surface);
    set('--surface-soft', tokens.surface);
    set('--line', tokens.border);
    set('--text', tokens.text);
    set('--muted', tokens.textMuted);
    set('--accent', tokens.accent);
    set('--accent-ink', tokens.accentContrast);
  }

  // ── Herramientas publicadas al host ────────────────────────────────────────
  function count(id) {
    var el = document.getElementById(id);
    var value = el ? parseInt(el.textContent || '0', 10) : 0;
    return isNaN(value) ? 0 : value;
  }

  var lastPublished = '';

  function publishToolbar() {
    if (!hosted) return;
    var decisions = count('notificationBadge');
    var agents = count('agentNotificationBadge');
    var items = [
      {
        id: 'decisions',
        kind: 'button',
        label: 'Decisiones · ' + decisions,
        icon: 'Bell',
        active: decisions > 0,
      },
      {
        id: 'agents',
        kind: 'button',
        label: 'Agentes · ' + agents,
        icon: 'Bot',
        active: agents > 0,
      },
      { id: 'tutorial', kind: 'button', label: 'Tutorial', icon: 'CircleHelp' },
    ];
    // Solo se emite si algo cambió: los contadores se repintan a menudo y no tiene
    // sentido despertar al host en cada repintado.
    var serialized = JSON.stringify(items);
    if (serialized === lastPublished) return;
    lastPublished = serialized;
    postToHost({ source: ATLAS_ADDON_SOURCE, type: 'atlas:toolbar', items: items });
  }

  function handleAction(id) {
    // Accionar el control real, no reimplementarlo.
    if (id === 'tutorial') {
      var help = document.getElementById('helpTutorialBtn');
      if (help) help.click();
    } else if (id === 'decisions') {
      applyView('human', 0);
    } else if (id === 'agents') {
      applyView('agents', 0);
    }
  }

  // ── Mensajes del host ──────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== ATLAS_HOST_SOURCE) return;
    if (msg.type === 'atlas:navigate') {
      applyView(msg.view, 0);
    } else if (msg.type === 'atlas:context') {
      applyTheme(msg.theme === 'dark' ? 'dark' : 'light');
      applyTokens(msg.tokens);
    } else if (msg.type === 'atlas:action' && typeof msg.id === 'string') {
      handleAction(msg.id);
    }
  });

  // La clase `atlas-hosted` (que oculta marca, pestañas y paleta) la pone un script
  // en línea del <head>: este archivo va con `defer` y llegaría tarde, tras haberse
  // visto un instante el marco propio.

  // ── Modo objeto suelto ─────────────────────────────────────────────────────
  // `document.documentElement.classList` ya trae `atlas-object-only` puesto por
  // el script en línea del <head> (antes del primer pintado, igual que
  // `atlas-hosted` — ver index.html) si `atlas_object` está presente: aquí solo
  // queda montar. Reintenta como `applyView`: el registry puede no tener el
  // objeto listo si `app.js` todavía está terminando su `init()`.
  function mountAtlasObject(id, attempt) {
    var container = document.getElementById('atlasObjectMount');
    if (!container) return;
    var mounted = mountObjectById(id, container);
    if (mounted) {
      postToHost({ source: ATLAS_ADDON_SOURCE, type: 'atlas:ready' });
      return;
    }
    if ((attempt || 0) < MAX_ATTEMPTS) {
      setTimeout(function () {
        mountAtlasObject(id, (attempt || 0) + 1);
      }, RETRY_MS);
      return;
    }
    container.textContent = 'objeto desconocido: "' + id + '"';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var objectId = param('atlas_object');
    if (objectId) {
      // Modo objeto: sin barra de pestañas, sin toolbar, sin `atlas_view` — es
      // un widget suelto, no el dashboard completo. El acuse `atlas:ready` lo
      // manda `mountAtlasObject` una vez el objeto está montado de verdad, no
      // antes (a diferencia del modo dashboard, donde "listo" es "el DOM
      // existe" y el objeto en sí puede tardar un `fetch` más).
      mountAtlasObject(objectId, 0);
      return;
    }

    var view = param('atlas_view');
    if (view) applyView(view, 0);

    publishToolbar();
    // Los contadores los repinta app.js; observarlos evita tener que tocarlo.
    if (hosted && window.MutationObserver) {
      var observer = new MutationObserver(publishToolbar);
      ['notificationBadge', 'agentNotificationBadge'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) observer.observe(el, { childList: true, characterData: true, subtree: true });
      });
    }

    // Acuse de recibo: sin él, Atlas podría haber enviado contexto y vista antes de
    // que este script existiera y los mensajes se perderían.
    postToHost({ source: ATLAS_ADDON_SOURCE, type: 'atlas:ready' });
  });
})();
