/** Paquetes revisables, sin ejecutar ni instalar herramientas. Los requisitos de cada SKILL.md siguen vigentes. */
export interface Especialista {
  id: string; nombre: string; ambito: string; skills: string[]; terminos: string[];
  modelos: { codex: string; 'claude-cli': string }; activo: boolean;
}
const definir = (id: string, nombre: string, ambito: string, skills: string, claves: string): Especialista => ({
  id, nombre, ambito, skills: skills.split(','), terminos: claves.split(','), modelos: { codex: 'default', 'claude-cli': 'sonnet' }, activo: true,
});

/** Dos o más skills con un flujo útil; las alternativas se consultan cuando correspondan, no se ejecutan todas. */
export const CATALOGO_ESPECIALISTAS: readonly Especialista[] = [
  definir('arquitectura', 'Arquitectura de software', 'Explorar estructura, relaciones y explicar decisiones del código.', 'repo-analyzer,graphify,code-tour', 'arquitectura de software,arquitectura del repositorio,codebase architecture'),
  definir('depuracion', 'Diagnóstico y depuración', 'Investigar causas, corregir y verificar errores.', 'gstack-investigate,error-handling,repo-analyzer', 'depurar,depuracion,debugging,diagnosticar un error'),
  definir('backend', 'Backend y APIs', 'Diseñar e implementar servicios y revisar su calidad y seguridad.', 'backend-builder,programming-best-practices,security-review', 'backend,endpoint,api rest,worker'),
  definir('qa', 'Pruebas y QA', 'Diseñar pruebas, comprobar integración y validar el resultado.', 'tdd-workflow,e2e-testing,webapp-testing,verification-loop', 'pruebas e2e,playwright,cobertura de pruebas,test driven'),
  definir('seguridad', 'Ciberseguridad', 'Auditar sistemas y código, investigar amenazas y priorizar hallazgos.', 'aegis-secops,cti-analyst,security-review', 'ciberseguridad,auditoria de seguridad,vulnerabilidades,malware,threat intelligence'),
  definir('frontend', 'Desarrollo frontend', 'Construir interfaces, diseñarlas, pulirlas y comprobarlas.', 'frontend-builder,frontend-design,impeccable,webapp-testing', 'frontend,interfaz react,componentes react,landing page'),
  definir('interaccion', 'Interacción y animaciones', 'Diseñar interacción física y revisar movimiento y accesibilidad.', 'apple-design,emil-design-eng,review-animations', 'animaciones,gestos de interfaz,microinteracciones,spring animation'),
  definir('marca', 'Identidad y diseño gráfico', 'Construir identidad, piezas gráficas y coherencia visual.', 'brandkit,canvas-design,theme-factory', 'identidad visual,brand kit,diseno grafico,branding'),
  definir('grafos', 'Grafos y redes', 'Extraer relaciones y analizar estructuras y algoritmos de grafos.', 'graphify,networkx', 'grafos,grafo,graph theory,centralidad,graphml'),
  definir('documentos', 'Documentos y conversión', 'Extraer y transformar documentos y producir artefactos verificables.', 'docx,pdf,liteparse,markitdown', 'documento word,convertir pdf,extraer pdf,ocr,docx'),
  definir('presentaciones', 'Presentaciones', 'Organizar narrativa, producir diapositivas y mantener su coherencia.', 'pptx,scientific-slides,theme-factory', 'presentacion,diapositivas,pptx,powerpoint'),
  definir('hojas-calculo', 'Hojas de cálculo', 'Explorar tablas, transformar datos y entregar hojas de cálculo.', 'xlsx,polars,exploratory-data-analysis', 'hoja de calculo,xlsx,excel,spreadsheet'),
  definir('rag', 'Recuperación documental y RAG', 'Ingerir documentos, recuperar contexto y relacionar conocimiento.', 'open-notebook,liteparse,iterative-retrieval,graphify', 'rag,recuperacion documental,base de conocimiento,open notebook'),
  definir('investigacion', 'Investigación bibliográfica', 'Buscar literatura, contrastar fuentes y mantener citas.', 'literature-review,paper-lookup,citation-management', 'revision bibliografica,revision sistematica,literature review,buscar articulos'),
  definir('estadistica', 'Estadística y diseño de estudios', 'Planificar potencia, analizar resultados y modelar incertidumbre.', 'statistical-analysis,statistical-power,statsmodels,pymc', 'estadistica,potencia estadistica,analisis bayesiano,contraste de hipotesis'),
  definir('datos', 'Procesamiento de datos', 'Transformar tablas y escalar procesamiento y almacenamiento.', 'polars,dask,vaex,zarr-python', 'etl,procesamiento de datos,datos mayores que memoria,tablas masivas'),
  definir('ml', 'Aprendizaje automático', 'Entrenar y evaluar modelos y explicar sus predicciones.', 'scikit-learn,shap,umap-learn', 'machine learning,aprendizaje automatico,scikit learn,explicar predicciones'),
  definir('deep-learning', 'Aprendizaje profundo', 'Preparar modelos neuronales, entrenamiento y aceleración.', 'transformers,pytorch-lightning,optimize-for-gpu', 'deep learning,aprendizaje profundo,transformers,pytorch'),
  definir('refuerzo', 'Aprendizaje por refuerzo', 'Elegir y evaluar algoritmos y entornos de refuerzo.', 'stable-baselines3,pufferlib', 'aprendizaje por refuerzo,reinforcement learning,stable baselines'),
  definir('series-temporales', 'Series temporales', 'Caracterizar secuencias y comparar modelos de pronóstico.', 'aeon,timesfm-forecasting,statsmodels', 'series temporales,pronostico temporal,time series,forecasting'),
  definir('geoespacial', 'Análisis geoespacial', 'Integrar datos geográficos y realizar análisis espacial.', 'geomaster,geopandas', 'geoespacial,geopandas,teledeteccion,cartografia'),
  definir('genomica', 'Genómica y secuencias', 'Procesar secuencias y alinear análisis reproducibles.', 'biopython,pysam,nextflow,phylogenetics', 'genomica,secuencias genomicas,nextflow,filogenia'),
  definir('unicelular', 'Análisis unicelular', 'Gestionar matrices celulares, integrar y analizar expresión.', 'scanpy,anndata,scvi-tools,scvelo', 'single cell,unicelular,scrna,scanpy'),
  definir('quimica', 'Quimioinformática', 'Representar moléculas, calcular propiedades y filtrar compuestos.', 'rdkit,datamol,medchem,molfeat', 'quimioinformatica,rdkit,smiles,cribado de compuestos'),
  definir('proteinas', 'Proteínas y modelado molecular', 'Estudiar secuencias, poses y dinámica; diferenciar lo que predice cada herramienta.', 'esm,diffdock,molecular-dynamics,glycoengineering', 'proteinas,docking,dinamica molecular,glicosilacion'),
  definir('imagen-biomedica', 'Imagen biomédica', 'Preparar imágenes, metadatos y análisis de patología.', 'pydicom,histolab,pathml,imaging-data-commons', 'imagen biomedica,dicom,histopatologia,patologia digital'),
  definir('biosenales', 'Bioseñales y neurofisiología', 'Procesar registros fisiológicos y electrofisiológicos y comprobar su calidad.', 'neurokit2,neuropixels-analysis', 'biosenales,neurofisiologia,neuropixels,electrocardiograma'),
  definir('cuantica', 'Computación cuántica', 'Elegir circuitos o simulación de sistemas según hardware y modelo físico.', 'qiskit,cirq,pennylane,qutip', 'computacion cuantica,quantum,qiskit,circuito cuantico'),
  definir('simulacion', 'Simulación y optimización matemática', 'Formular sistemas, simular escenarios y comparar soluciones.', 'simpy,sympy,pymoo,matlab', 'simulacion matematica,optimizacion multiobjetivo,simpy,algebra simbolica'),
  definir('escritura-cientifica', 'Escritura y revisión científica', 'Redactar, revisar metodología y preparar manuscritos y figuras.', 'scientific-writing,peer-review,venue-templates,scientific-visualization', 'manuscrito cientifico,escritura cientifica,peer review,articulo cientifico'),
  definir('evals', 'Evaluación de agentes y prompts', 'Diseñar evaluadores y regresiones de comportamiento.', 'promptfoo,eval-harness,ai-regression-testing', 'evaluar prompts,evaluacion de agentes,promptfoo,evals'),
  definir('skills', 'Mantenimiento de skills', 'Buscar capacidades existentes, diseñar instrucciones y revisar su calidad.', 'skill-creator,skill-stocktake,skill-scout', 'crear skill,crear una skill,auditar skills,mantenimiento de skills'),
  definir('laboratorio', 'Automatización de laboratorio', 'Diseñar protocolos y conectarlos a instrumentos y registros; ejecutar solo con autorización.', 'opentrons-integration,pylabrobot,protocolsio-integration,benchling-integration', 'automatizacion de laboratorio,opentrons,pylabrobot,benchling'),
  definir('devops', 'DevOps y despliegue', 'Preparar contenedores, entrega y observabilidad.', 'docker-patterns,deployment-patterns,observability-and-instrumentation', 'devops,docker,kubernetes,ci cd'),
  definir('bases-datos', 'Bases de datos', 'Diseñar esquemas, migrar y comprobar acceso y consultas.', 'postgres-patterns,database-migrations,api-design', 'postgres,migracion de base de datos,esquema sql'),
  definir('movil', 'Aplicaciones móviles', 'Construir UI móvil, integrar datos y preparar entregas.', 'building-native-ui,native-data-fetching,expo-deployment', 'aplicacion movil,expo,react native'),
  definir('marketing', 'Marketing y contenidos', 'Investigar mercado y convertir hallazgos en contenido adecuado al canal.', 'market-research,content-engine,crosspost', 'marketing,estrategia de contenido,investigacion de mercado'),
  definir('producto', 'Producto y especificaciones', 'Clarificar problemas, formular capacidades y preparar un plan verificable.', 'product-capability,plan-canvas,blueprint', 'definir producto,especificacion de producto,product discovery'),
  definir('visualizacion', 'Visualización de datos', 'Elegir representación, construir gráficos y verificar legibilidad.', 'design-a-chart,prepare-chart-data,ship-accessible-charts', 'visualizacion de datos,disenar grafico,graficos accesibles'),
  definir('mcp', 'Integraciones MCP', 'Diseñar servidores e interfaces y revisar sus contratos.', 'mcp-builder,mcp-server-patterns,api-design', 'servidor mcp,integracion mcp,mcp server'),
];
