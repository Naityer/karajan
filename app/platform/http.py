"""Clientes HTTP con contexto TLS compartido.

Cada `httpx.Client()` construye su propio `SSLContext`, y cargar el almacén de
certificados del sistema cuesta ~250 ms. Karajan crea cinco clientes al montar
una instalación (analizador de GitHub, feed de Inspiration y los tres
indexadores anidados), así que arrancar —o construir un runtime en un test—
pagaba más de un segundo entero solo en leer los mismos certificados cinco
veces.

El contexto TLS es inmutable y seguro de compartir entre clientes: se construye
una vez por proceso y se reutiliza. Misma verificación de certificados que
antes; lo único que desaparece es el trabajo repetido.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import httpx


@lru_cache(maxsize=1)
def default_ssl_context() -> Any:
    """Contexto TLS por defecto de httpx, construido una sola vez."""
    return httpx.create_ssl_context()


def build_client(**kwargs: Any) -> httpx.Client:
    """`httpx.Client` normal, con el contexto TLS compartido del proceso."""
    kwargs.setdefault("verify", default_ssl_context())
    return httpx.Client(**kwargs)
