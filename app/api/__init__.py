"""Factoría de la aplicación ASGI: construye un `FastAPI` a partir de un
`KarajanRuntime` ya hecho, en vez de que cada modo de ejecución repita el
cableado de routers/lifespan/estáticos por su cuenta."""

from app.api.factory import create_app

__all__ = ["create_app"]
