# KARAJAN model setup presets

## Real low-cost/open-source agent pool

Use these providers when you want broader real-model coverage without making
OpenAI/Anthropic the default path:

- `groq`: fast hosted open models; set `GROQ_API_KEY`.
- `google`: Gemini models; set `GOOGLE_API_KEY` or `GEMINI_API_KEY`.
- `deepseek`: low-cost reasoning/coding models; set `DEEPSEEK_API_KEY`.
- `zai`: GLM agentic/coding models; set `ZAI_API_KEY`.
- `moonshot`: Kimi models; set `MOONSHOT_API_KEY`.
- `together`: hosted open-source models; set `TOGETHER_API_KEY`.
- `openrouter`: many free/community models behind one API; set `OPENROUTER_API_KEY`.
- `huggingface`: Inference Providers router; set `HF_TOKEN`.
- `ollama`: fully local/free if installed and models are pulled.
- GitHub Copilot: not exposed as a generic KARAJAN provider unless a usable CLI
  such as `gh copilot` is installed and available in PATH. Use it manually as an
  external console by posting decisions to `/tasks/{task_id}/decisions`.

Recommended pro config once keys are set:

```json
{
  "profile": "pro",
  "backend": "api",
  "prefer_free": true,
  "provider_preferences": {
    "cheap_model": "google",
    "cheap_or_medium_model": "groq",
    "medium_model": "zai",
    "strong_model": "together",
    "strong_model_with_human_review": "deepseek"
  },
  "orchestration": {
    "parallel": false,
    "max_parallel": 3,
    "subtask_timeout_s": 120,
    "max_retries": 1,
    "enable_runtime_fallback": true,
    "require_human_review_gate": true,
    "max_cost_per_task_usd": 0.02,
    "max_daily_cost_usd": 0.10
  }
}
```

Keep `enable_runtime_fallback` on. If the selected provider fails, KARAJAN will
try ready free providers and then the deterministic simulated backend.

## Local operational audit

Last local check:

- Ready now: `codex` CLI. It is the only detected executable provider in PATH.
- Not ready locally: `ollama`, `gh copilot`, `claude`.
- Not ready by API key: `openai`, `google/gemini`, `groq`, `deepseek`, `zai/glm`, `moonshot/kimi`, `together`, `openrouter`, `huggingface`, `mistral`.
- Claude is intentionally ignored for fallback planning when unavailable.

Recommended open/free activation order:

1. Install Ollama and run `ollama serve`.
2. Pull a usable local pool:
   - `ollama pull llama3.2:3b`
   - `ollama pull llama3.1:8b`
   - `ollama pull qwen2.5:14b`
   - `ollama pull deepseek-r1:32b` or `ollama pull qwen2.5:32b` for stronger local routing.
3. Add `GROQ_API_KEY` for fast hosted open models.
4. Add `ZAI_API_KEY` for GLM.
5. Add `DEEPSEEK_API_KEY` for DeepSeek reasoning/coding.
6. Add `MOONSHOT_API_KEY` for Kimi.
7. Add `OPENROUTER_API_KEY`, `TOGETHER_API_KEY` or `HF_TOKEN` for broader open-model fallback.
