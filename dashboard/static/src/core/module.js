// ---- manifiesto de módulo (frontend) --------------------------------------
// Espejo de `app/core/module.py` en el backend: mismo campo, mismo propósito
// (nota "Plan de mejora", §10/§24) — que un host pueda leer qué es un módulo,
// qué vistas expone y qué capacidades necesita sin tener que parsear el DOM
// ni importar su código.
export class ModuleManifest {
  constructor({ id, title, icon, capabilities = [], views = [], objects = [], publishes = [], consumes = [] }) {
    this.id = id;
    this.title = title;
    this.icon = icon;
    this.capabilities = capabilities;
    this.views = views; // [{ id, dataView, label }] — dataView = data-view del tab legacy
    // [{ id, type, title, description, capabilities }] — espejo de
    // `UIObjectDescriptor` en `app/core/module.py`; solo metadatos, el
    // `factory()` montable vive en el registro (`registry-bootstrap.js`).
    this.objects = objects;
    this.publishes = publishes;
    this.consumes = consumes;
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      icon: this.icon,
      capabilities: this.capabilities,
      views: this.views,
      objects: this.objects,
      events: { publishes: this.publishes, consumes: this.consumes },
    };
  }
}
