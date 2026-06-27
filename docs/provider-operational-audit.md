# KARAJAN provider operational audit

## Resultado local

Proveedor operativo ahora mismo:

- `codex`: disponible y listo en PATH.

Proveedores no operativos todavía:

- `ollama`: falta instalar `ollama` y descargar modelos.
- `copilot`: falta `gh`/GitHub Copilot CLI disponible en PATH.
- `openai`: falta `OPENAI_API_KEY`.
- `google`: falta `GOOGLE_API_KEY` o `GEMINI_API_KEY`.
- `groq`: falta `GROQ_API_KEY`.
- `deepseek`: falta `DEEPSEEK_API_KEY`.
- `zai`: falta `ZAI_API_KEY`.
- `moonshot`: falta `MOONSHOT_API_KEY`.
- `together`: falta `TOGETHER_API_KEY`.
- `openrouter`: falta `OPENROUTER_API_KEY`.
- `huggingface`: falta `HF_TOKEN`.
- `mistral`: falta `MISTRAL_API_KEY`.

Claude queda fuera del diagnóstico operativo porque el diseño ya contempla que pueda no estar disponible.

## Jerarquía preparada

- `Claude (Agent)`: agente principal conceptual para N4-N5.
- `ChatGPT (Backup)`: backup general si OpenAI está configurado.
- `DeepSeek (Backup fuerte)`: backup para razonamiento/código fuerte.
- `GLM (Backup reasoning)`: backup de planificación y reasoning.
- `Kimi (Backup largo contexto)`: backup para agregación y contexto largo.
- `Ollama (Worker N1)`: worker local para tareas simples.
- `Groq (Worker N2)`: worker rápido para tareas moderadas.
- `Gemini (Worker N3)`: worker intermedio.
- `Copilot (Worker dev)`: worker local/CLI de desarrollo si GitHub CLI y Copilot están activos.

## Orden recomendado para dejar alternativas reales

1. Instalar Ollama y ejecutar `ollama serve`.
2. Descargar modelos locales:
   - `ollama pull llama3.2:3b`
   - `ollama pull llama3.1:8b`
   - `ollama pull qwen2.5:14b`
   - `ollama pull deepseek-r1:32b`
   - `ollama pull qwen2.5:32b`
3. Añadir `GROQ_API_KEY` para modelos open rápidos.
4. Añadir `ZAI_API_KEY` para GLM.
5. Añadir `DEEPSEEK_API_KEY` para DeepSeek.
6. Añadir `MOONSHOT_API_KEY` para Kimi.
7. Añadir `OPENROUTER_API_KEY`, `TOGETHER_API_KEY` o `HF_TOKEN` si quieres más fallback open-source.

## Configuración activa

La configuración actual prioriza:

- N1: `ollama`
- N2: `groq`
- N3: `google`
- N4: `deepseek`
- N5: `moonshot`

Si un proveedor no está listo, KARAJAN debe usar fallback runtime y, si todo falla, volver al backend simulado.
