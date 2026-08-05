@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help

call :find_node
if defined NODE_EXE goto :run_setup

echo Node.js 18 or newer is required.
where winget.exe >nul 2>nul
if errorlevel 1 goto :node_download

choice /C YN /N /M "Install the official Node.js LTS now? [Y/N] "
if errorlevel 2 goto :node_download

winget.exe install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :node_failed
call :find_node
if not defined NODE_EXE goto :node_failed
goto :run_setup

:node_download
echo Install Node.js LTS from https://nodejs.org/ then run this file again.
start "" "https://nodejs.org/"
goto :end

:node_failed
echo Node.js installation did not finish. Install it from https://nodejs.org/ and try again.
goto :end

:run_setup
echo A window will open. Select the folder you use as your Obsidian vault.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-on-windows.ps1"
if errorlevel 1 goto :setup_failed
echo.
echo Done.
echo 1. Restart Obsidian and open any Excalidraw drawing once.
echo 2. Restart Claude or Codex once.
echo 3. Claude Desktop only: enable the excalidraw connector.
goto :end

:setup_failed
echo.
echo Setup could not finish. Read the message above, then try again.
goto :end

:find_node
set "NODE_EXE="
for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE_EXE=%%~$PATH:N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE "%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 set "NODE_EXE="
exit /b 0

:help
echo Obsidian Excalidraw Universal MCP - easy Windows setup
echo.
echo Double-click this file and select your Obsidian vault.
echo It installs the required Obsidian plugins, scripts, and MCP settings.
echo If Node.js is missing, it asks before installing the official LTS release.
goto :eof

:end
echo.
pause
endlocal
