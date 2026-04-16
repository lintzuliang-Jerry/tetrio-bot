@echo off
REM Local build script for Windows cmd / PowerShell
REM Usage:  build.cmd           (production build)
REM         build.cmd --watch   (dev watch mode)

setlocal
set "SCRIPT_DIR=%~dp0"
set "NODE_DIR=%SCRIPT_DIR%tools\node"

if not exist "%NODE_DIR%\node.exe" (
  echo Error: Node.js not found at %NODE_DIR%\node.exe
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"

if "%~1"=="--watch" (
  "%NODE_DIR%\node.exe" "%NODE_DIR%\node_modules\npm\bin\npm-cli.js" run dev
) else (
  "%NODE_DIR%\node.exe" "%NODE_DIR%\node_modules\npm\bin\npm-cli.js" run build
)
endlocal
