"""Los módulos de Karajan, uno por vista real del producto.

`human_control`, `monitoring`, `decision`, `agents`, `inspiration` y
`configuration` (nota "Plan de mejora", §1). Cada uno aporta su router de API,
sus servicios y su manifiesto; ninguno importa a otro: se comunican por eventos
de dominio.
"""
