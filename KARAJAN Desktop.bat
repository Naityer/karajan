@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist ".env" (
  echo.
  echo Creating local configuration: .env
  > ".env" echo # KARAJAN local environment
  >> ".env" echo # Leave KARAJAN_TOKEN empty to keep local mutation auth disabled.
  >> ".env" echo KARAJAN_TOKEN=
  >> ".env" echo KARAJAN_LOG_LEVEL=INFO
  >> ".env" echo # Optional provider keys:
  >> ".env" echo # OPENAI_API_KEY=
  >> ".env" echo # ANTHROPIC_API_KEY=
  >> ".env" echo # GOOGLE_API_KEY=
  >> ".env" echo # GROQ_API_KEY=
  >> ".env" echo # MISTRAL_API_KEY=
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if not "%%~A"=="" if not defined %%A set "%%~A=%%~B"
)

set "PYTHON_BOOT="
set "PYTHON_EXE=%CD%\.venv\Scripts\python.exe"

python -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYTHON_BOOT=python"

if not defined PYTHON_BOOT (
  py -3.12 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYTHON_BOOT=py -3.12"
)

if not defined PYTHON_BOOT (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYTHON_BOOT=py -3"
)

if not defined PYTHON_BOOT if not exist "%PYTHON_EXE%" (
  echo.
  echo KARAJAN Desktop could not find Python.
  echo Install Python 3.11+ and run this launcher again.
  echo.
  pause
  exit /b 1
)

if not exist "%PYTHON_EXE%" (
  echo.
  echo Creating local Python environment: .venv
  %PYTHON_BOOT% -m venv .venv
  if errorlevel 1 (
    echo.
    echo Could not create the virtual environment.
    echo Try installing Python 3.11+ with the "Add python.exe to PATH" option.
    echo.
    pause
    exit /b 1
  )
)

"%PYTHON_EXE%" -m pip --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo Preparing pip in .venv...
  "%PYTHON_EXE%" -m ensurepip --upgrade
  if errorlevel 1 goto dependency_error
)

"%PYTHON_EXE%" -c "import fastapi, uvicorn, pydantic, httpx, webview" >nul 2>nul
if errorlevel 1 (
  echo.
  echo Installing KARAJAN dependencies in .venv...
  "%PYTHON_EXE%" -m pip install --upgrade pip
  if errorlevel 1 goto dependency_error
  "%PYTHON_EXE%" -m pip install -r requirements.txt
  if errorlevel 1 goto dependency_error
)

"%PYTHON_EXE%" -c "import fastapi, uvicorn, pydantic, httpx, webview" >nul 2>nul
if errorlevel 1 goto dependency_error

echo.
echo Starting KARAJAN Desktop with:
echo   "%PYTHON_EXE%"
echo.
"%PYTHON_EXE%" desktop_app.py
if errorlevel 1 goto launch_error

exit /b 0

:dependency_error
echo.
echo KARAJAN Desktop could not install or load its dependencies.
echo Check your internet connection and try again.
echo You can also run manually:
echo   "%PYTHON_EXE%" -m pip install -r requirements.txt
echo.
pause
exit /b 1

:launch_error
echo.
echo KARAJAN Desktop could not start.
echo Try running:
echo   "%PYTHON_EXE%" desktop_app.py
echo.
pause
exit /b 1
