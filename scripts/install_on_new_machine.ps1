# Karajan - Setup completo en máquina nueva
# Ejecutar desde el directorio raíz del proyecto:
#   powershell -ExecutionPolicy Bypass -File scripts\install_on_new_machine.ps1

param(
    [string]$AnthropicKey = "",
    [string]$OpenAIKey = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

Write-Host "`n=== KARAJAN SETUP ===" -ForegroundColor Cyan
Write-Host "Directorio: $Root`n"

# 1. Python venv
Write-Host "[1/6] Creando entorno virtual Python..." -ForegroundColor Yellow
python -m venv "$Root\.venv"
& "$Root\.venv\Scripts\pip" install -q -r "$Root\requirements.txt"
& "$Root\.venv\Scripts\pip" install -q "mcp[cli]" anthropic openai
Write-Host "      OK" -ForegroundColor Green

# 2. Ollama
Write-Host "[2/6] Verificando Ollama..." -ForegroundColor Yellow
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "      Instalando Ollama via winget..." -ForegroundColor Gray
    winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}
Write-Host "      OK: $(ollama --version)" -ForegroundColor Green

# 3. Modelos locales
Write-Host "[3/6] Descargando modelos locales (~17 GB total)..." -ForegroundColor Yellow
$models = @("qwen2.5:7b", "deepseek-r1:8b", "mistral-nemo:12b")
$installed = (ollama list) -join " "
foreach ($model in $models) {
    $name = $model.Split(":")[0]
    if ($installed -like "*$name*") {
        Write-Host "      $model ya instalado" -ForegroundColor Gray
    } else {
        Write-Host "      Descargando $model..." -ForegroundColor Gray
        ollama pull $model
        Write-Host "      $model OK" -ForegroundColor Green
    }
}

# 4. Codex CLI en PATH
Write-Host "[4/6] Verificando Codex CLI..." -ForegroundColor Yellow
$codexPath = Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Recurse -Filter "codex.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($codexPath) {
    $codexDir = $codexPath.DirectoryName
    $userPath = [System.Environment]::GetEnvironmentVariable("PATH","User")
    if ($userPath -notlike "*$codexDir*") {
        [System.Environment]::SetEnvironmentVariable("PATH","$userPath;$codexDir","User")
        Write-Host "      Codex añadido al PATH: $codexDir" -ForegroundColor Green
    } else {
        Write-Host "      Codex ya en PATH" -ForegroundColor Gray
    }
} else {
    Write-Host "      Codex CLI no encontrado (instala desde https://platform.openai.com)" -ForegroundColor DarkYellow
}

# 5. Configurar .env
Write-Host "[5/6] Configurando .env..." -ForegroundColor Yellow
$envPath = "$Root\.env"
$envContent = Get-Content $envPath -Raw
if ($AnthropicKey -and $envContent -notlike "*ANTHROPIC_API_KEY=$AnthropicKey*") {
    $envContent = $envContent -replace "#\s*ANTHROPIC_API_KEY=.*", "ANTHROPIC_API_KEY=$AnthropicKey"
    Set-Content $envPath $envContent
    Write-Host "      ANTHROPIC_API_KEY configurada" -ForegroundColor Green
}
if ($OpenAIKey -and $envContent -notlike "*OPENAI_API_KEY=$OpenAIKey*") {
    $envContent = $envContent -replace "#\s*OPENAI_API_KEY=.*", "OPENAI_API_KEY=$OpenAIKey"
    Set-Content $envPath $envContent
    Write-Host "      OPENAI_API_KEY configurada" -ForegroundColor Green
}
Write-Host "      .env OK" -ForegroundColor Green

# 6. MCP server en Claude Code
Write-Host "[6/6] Registrando MCP server en Claude Code..." -ForegroundColor Yellow
$claudeSettings = "$env:USERPROFILE\.claude\settings.json"
$pythonExe = "$Root\.venv\Scripts\python.exe" -replace "\\", "\\\\"
$mcpScript = "$Root\karajan_mcp.py" -replace "\\", "\\\\"

if (Test-Path $claudeSettings) {
    $settings = Get-Content $claudeSettings -Raw | ConvertFrom-Json
} else {
    New-Item -ItemType Directory -Force (Split-Path $claudeSettings) | Out-Null
    $settings = [PSCustomObject]@{}
}

if (-not $settings.PSObject.Properties["mcpServers"]) {
    $settings | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([PSCustomObject]@{})
}
$mcpEntry = [PSCustomObject]@{
    command = "$Root\.venv\Scripts\python.exe"
    args = @("$Root\karajan_mcp.py")
    env = [PSCustomObject]@{ KARAJAN_URL = "http://127.0.0.1:8000" }
}
$settings.mcpServers | Add-Member -NotePropertyName "karajan" -NotePropertyValue $mcpEntry -Force
$settings | ConvertTo-Json -Depth 10 | Set-Content $claudeSettings
Write-Host "      MCP registrado en $claudeSettings" -ForegroundColor Green

# Restaurar config de produccion
Write-Host "`n[Extra] Restaurando config de produccion..." -ForegroundColor Yellow
Copy-Item "$Root\data\production_baseline\active_config.json" "$Root\data\active_config.json" -Force
Copy-Item "$Root\data\production_baseline\routing_layout.json" "$Root\data\routing_layout.json" -Force
Write-Host "      Configs restauradas" -ForegroundColor Green

Write-Host "`n=== SETUP COMPLETO ===" -ForegroundColor Cyan
Write-Host @"

Jerarquia activa:
  N1/N2  Qwen 2.5 7B       (local, gratis)
  N3     DeepSeek R1 8B    (local, gratis)
  N3/N4  Mistral Nemo 12B  (local, gratis)
  N4     Codex CLI         (suscripcion OpenAI)
  N5     Claude Code CLI   (suscripcion Anthropic)

Para iniciar Karajan:
  .venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8000

Reinicia Claude Code para cargar el MCP server 'karajan'.
"@ -ForegroundColor White
