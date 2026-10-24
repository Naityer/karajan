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
const w = window as unknown as {
  AtlasShared: unknown; AtlasPaquetes: Record<string, { ventana: { Panel: React.ComponentType<{ api: string }>; Pagina: React.ComponentType<{ api: string }> } }>; montarKarajan: () => void;
};
w.AtlasShared = { React, jsxRuntime, recharts, ui: { SinConexionApp } };
w.AtlasPaquetes = {};

w.montarKarajan = () => {
  const p = new URLSearchParams(location.search);
  if (p.get('tema') === 'dark') document.documentElement.classList.add('dark');
  const v = w.AtlasPaquetes['karajan']!.ventana;
  const api = p.get('api') ?? '/paquetes/karajan/api';
  createRoot(document.getElementById('panel')!).render(<v.Panel api={api} />);
  createRoot(document.getElementById('pagina')!).render(<v.Pagina api={api} />);
};
