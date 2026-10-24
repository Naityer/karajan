import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import * as recharts from 'recharts';

/**
 * Arnés de desarrollo (solo para ver la UI sin Atlas dev): pone en `window.AtlasShared` lo mismo que Atlas dev y monta la ventana.
 * Lo carga ui/dev.mjs antes que `ui.js`; nada de esto entra en el paquete.
 */
const SinConexionApp = ({ app, como }: { app: string; como: string }) => (
  <div style={{ padding: 12, border: '1px dashed rgb(var(--atlas-border-strong))', borderRadius: 10 }}><b>{app} no responde</b><br />{como}</div>
);
interface PropsSkills { api: string; tarea: string; prompt: string; propuestas: string[]; alConfirmar?: (skills: string[], respuesta: string) => void }
const w = window as unknown as {
  AtlasShared: unknown; AtlasPaquetes: Record<string, { ventana: { Panel: React.ComponentType<{ api: string }>; Pagina: React.ComponentType<{ api: string }> }; panelSkills: React.ComponentType<PropsSkills> }>; montarKarajan: () => void;
};
w.AtlasShared = { React, jsxRuntime, recharts, ui: { SinConexionApp } };
w.AtlasPaquetes = {};

w.montarKarajan = () => {
  const p = new URLSearchParams(location.search);
  if (p.get('tema') === 'dark') document.documentElement.classList.add('dark');
  const v = w.AtlasPaquetes['karajan']!.ventana;
  const api = p.get('api') ?? '/paquetes/karajan/api';
  if (p.get('vista') === 'skills') { void montarSkills(api); return; }
  createRoot(document.getElementById('panel')!).render(<v.Panel api={api} />);
  createRoot(document.getElementById('pagina')!).render(<v.Pagina api={api} />);
};

/** ?vista=skills: el panel sí/no de skills solo, como lo montaría Atlas dev en «Preparando» (datos de ui/fixtures/skills.json). */
async function montarSkills(api: string) {
  const demo = (await import('../fixtures/skills.json')).default;
  const Panel = w.AtlasPaquetes['karajan']!.panelSkills;
  document.getElementById('panel')!.innerHTML = '<b>Arnés · panel de skills</b><p>Las rutas del servidor están simuladas.</p>';
  createRoot(document.getElementById('pagina')!).render(
    <div style={{ maxWidth: 760 }}><Panel api={api} tarea={demo.tarea} prompt={demo.prompt} propuestas={demo.propuestas} alConfirmar={(s, r) => console.log('alConfirmar', r, s)} /></div>,
  );
}
