# Análisis de biblioteca para especialistas

Cribado de metadatos de todas las entradas activas de tipo skill, contrastado con carpetas locales y almacén. No es una auditoría de todos los cuerpos ni una prueba de desempeño de los modelos.

Entradas: **971**. Paquetes: **40**. Con cobertura local completa: **33**.

## Criterio

Cada paquete delimita un flujo y reúne al menos dos skills distintas. Unas cubren pasos complementarios y otras ofrecen alternativas según formato, hardware o tipo de tarea. No deben ejecutarse todas indiscriminadamente. Los términos se usan para selección determinista; un empate conserva el flujo original. La presencia en Biblioteca no sustituye la disponibilidad de instrucciones locales.

Se descarta la taxonomía heredada como criterio suficiente: contiene asignaciones excesivamente amplias a pruebas/seguridad, incluso para recursos científicos. No se crean skills ni se obtienen recursos de red para completar paquetes.

## Cribado completo

| Estado | Entradas |
| --- | ---: |
| referencia_por_verificar | 259 |
| fuera_paquete_inicial | 588 |
| paquete_propuesto | 119 |
| excluida_fixture | 4 |
| excluida_plantilla | 1 |

Cada una de las entradas, sus fuentes, estado, motivo y pertenencias están en `especialistas-inventario.json`. «Fuera del paquete inicial» no desactiva ni elimina la skill: permanece disponible para sugerencias sueltas. Las referencias sin instrucciones verificadas tampoco se cuentan como cobertura. Se evita convertir traducciones o referencias duplicadas en especialidades adicionales.

## Paquetes y motivo

| Id | Flujo y motivo | Skills | Cobertura local |
| --- | --- | --- | --- |
| arquitectura | Explorar estructura, relaciones y explicar decisiones del código. | repo-analyzer, graphify, code-tour | Completa |
| depuracion | Investigar causas, corregir y verificar errores. | gstack-investigate, error-handling, repo-analyzer | Completa |
| backend | Diseñar e implementar servicios y revisar su calidad y seguridad. | backend-builder, programming-best-practices, security-review | Completa |
| qa | Diseñar pruebas, comprobar integración y validar el resultado. | tdd-workflow, e2e-testing, webapp-testing, verification-loop | Completa |
| seguridad | Auditar sistemas y código, investigar amenazas y priorizar hallazgos. | aegis-secops, cti-analyst, security-review | Completa |
| frontend | Construir interfaces, diseñarlas, pulirlas y comprobarlas. | frontend-builder, frontend-design, impeccable, webapp-testing | Completa |
| interaccion | Diseñar interacción física y revisar movimiento y accesibilidad. | apple-design, emil-design-eng, review-animations | Completa |
| marca | Construir identidad, piezas gráficas y coherencia visual. | brandkit, canvas-design, theme-factory | Completa |
| grafos | Extraer relaciones y analizar estructuras y algoritmos de grafos. | graphify, networkx | Completa |
| documentos | Extraer y transformar documentos y producir artefactos verificables. | docx, pdf, liteparse, markitdown | Completa |
| presentaciones | Organizar narrativa, producir diapositivas y mantener su coherencia. | pptx, scientific-slides, theme-factory | Completa |
| hojas-calculo | Explorar tablas, transformar datos y entregar hojas de cálculo. | xlsx, polars, exploratory-data-analysis | Completa |
| rag | Ingerir documentos, recuperar contexto y relacionar conocimiento. | open-notebook, liteparse, iterative-retrieval, graphify | Completa |
| investigacion | Buscar literatura, contrastar fuentes y mantener citas. | literature-review, paper-lookup, citation-management | Completa |
| estadistica | Planificar potencia, analizar resultados y modelar incertidumbre. | statistical-analysis, statistical-power, statsmodels, pymc | Completa |
| datos | Transformar tablas y escalar procesamiento y almacenamiento. | polars, dask, vaex, zarr-python | Completa |
| ml | Entrenar y evaluar modelos y explicar sus predicciones. | scikit-learn, shap, umap-learn | Completa |
| deep-learning | Preparar modelos neuronales, entrenamiento y aceleración. | transformers, pytorch-lightning, optimize-for-gpu | Completa |
| refuerzo | Elegir y evaluar algoritmos y entornos de refuerzo. | stable-baselines3, pufferlib | Completa |
| series-temporales | Caracterizar secuencias y comparar modelos de pronóstico. | aeon, timesfm-forecasting, statsmodels | Completa |
| geoespacial | Integrar datos geográficos y realizar análisis espacial. | geomaster, geopandas | Completa |
| genomica | Procesar secuencias y alinear análisis reproducibles. | biopython, pysam, nextflow, phylogenetics | Completa |
| unicelular | Gestionar matrices celulares, integrar y analizar expresión. | scanpy, anndata, scvi-tools, scvelo | Completa |
| quimica | Representar moléculas, calcular propiedades y filtrar compuestos. | rdkit, datamol, medchem, molfeat | Completa |
| proteinas | Estudiar secuencias, poses y dinámica; diferenciar lo que predice cada herramienta. | esm, diffdock, molecular-dynamics, glycoengineering | Completa |
| imagen-biomedica | Preparar imágenes, metadatos y análisis de patología. | pydicom, histolab, pathml, imaging-data-commons | Completa |
| biosenales | Procesar registros fisiológicos y electrofisiológicos y comprobar su calidad. | neurokit2, neuropixels-analysis | Completa |
| cuantica | Elegir circuitos o simulación de sistemas según hardware y modelo físico. | qiskit, cirq, pennylane, qutip | Completa |
| simulacion | Formular sistemas, simular escenarios y comparar soluciones. | simpy, sympy, pymoo, matlab | Completa |
| escritura-cientifica | Redactar, revisar metodología y preparar manuscritos y figuras. | scientific-writing, peer-review, venue-templates, scientific-visualization | Completa |
| evals | Diseñar evaluadores y regresiones de comportamiento. | promptfoo, eval-harness, ai-regression-testing | Completa |
| skills | Buscar capacidades existentes, diseñar instrucciones y revisar su calidad. | skill-creator, skill-stocktake, skill-scout | Completa |
| laboratorio | Diseñar protocolos y conectarlos a instrumentos y registros; ejecutar solo con autorización. | opentrons-integration, pylabrobot, protocolsio-integration, benchling-integration | Completa |
| devops | Preparar contenedores, entrega y observabilidad. | docker-patterns, deployment-patterns, observability-and-instrumentation | Faltan: docker-patterns, deployment-patterns, observability-and-instrumentation |
| bases-datos | Diseñar esquemas, migrar y comprobar acceso y consultas. | postgres-patterns, database-migrations, api-design | Faltan: postgres-patterns, database-migrations, api-design |
| movil | Construir UI móvil, integrar datos y preparar entregas. | building-native-ui, native-data-fetching, expo-deployment | Faltan: building-native-ui, native-data-fetching, expo-deployment |
| marketing | Investigar mercado y convertir hallazgos en contenido adecuado al canal. | market-research, content-engine, crosspost | Faltan: market-research, content-engine, crosspost |
| producto | Clarificar problemas, formular capacidades y preparar un plan verificable. | product-capability, plan-canvas, blueprint | Faltan: product-capability, plan-canvas, blueprint |
| visualizacion | Elegir representación, construir gráficos y verificar legibilidad. | design-a-chart, prepare-chart-data, ship-accessible-charts | Faltan: design-a-chart, prepare-chart-data, ship-accessible-charts |
| mcp | Diseñar servidores e interfaces y revisar sus contratos. | mcp-builder, mcp-server-patterns, api-design | Faltan: mcp-server-patterns, api-design |

## Modelos y disponibilidad

Valores iniciales: Claude CLI → `sonnet`; Codex → `default` (modelo de la cuenta). Ambos son configurables por especialista; se conserva el proveedor que resuelven las políticas y la elección manual. Son valores compatibles con los ejecutores existentes, no conclusiones de un benchmark. No se afirma una mejora cuantificada de desempeño sin datos revisados de producción.

## Reproducción y límites

Ejecutar `python scripts/analizar_especialistas.py --db <resources.db> --casa <usuario>`. La lectura inmutable usa la instantánea persistida, sin WAL. No modifica la base, instalaciones ni configuraciones. La salida evita rutas personales. El catálogo de ejecución es acotado y no relee esta instantánea por tarea.

Los paquetes científicos, de laboratorio, nube o plugins pueden necesitar bibliotecas, binarios, credenciales, hardware o servicios. La preparación de SKILL.md no acredita esos requisitos ni autoriza acciones externas. Se consultan las instrucciones y se comprueban los requisitos al realizar la tarea específica.
