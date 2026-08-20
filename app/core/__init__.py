"""Núcleo de Karajan: dominio y contratos, sin dependencias de framework.

Nada bajo `app/core/` debe importar FastAPI, SQLite ni conocer el modo de
ejecución (standalone / add-on de Atlas / SaaS). Esa es la frontera que permite
que los tres modos sean adaptadores del mismo Karajan y no tres aplicaciones.
"""
