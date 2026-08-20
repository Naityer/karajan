"""Infraestructura: persistencia, autenticación, eventos y transporte.

Es la capa que sí conoce SQLite, JWT o el sistema de ficheros. `app/core/`
define los puertos; esto los enchufa. (No colisiona con el módulo `platform` de
la biblioteca estándar: aquí es `app.platform`, y Python 3 importa en absoluto
por defecto.)
"""
