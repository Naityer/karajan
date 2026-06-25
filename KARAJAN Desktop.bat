@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" desktop_app.py
) else (
  python desktop_app.py
)

if errorlevel 1 (
  echo.
  echo KARAJAN Desktop could not start.
  echo Install dependencies with:
  echo   python -m pip install -r requirements.txt
  echo.
  pause
)
