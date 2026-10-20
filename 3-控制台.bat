@echo off
chcp 65001 >nul
title Douyin Comment Console
cd /d "%~dp0"

rem ============================================================
rem  Local console. Double-click opens a web page that works ONLY
rem  on this machine, used to configure:
rem      - which works get auto-replies
rem      - the bot persona (how it talks)
rem      - reply rules (length cap, which categories to answer)
rem  It can also dry-run a single comment so you can see the real
rem  result. It never sends anything.
rem
rem  Deliberate differences from the login script (step 2):
rem   1. This script does NOT strip DEEPSEEK_API_KEY. The console
rem      needs the key to preview a reply, and it reads it from the
rem      key file. Stripping the env var would silently downgrade
rem      users who supply the key via env into template mode - the
rem      page would then report "persona not applied", pointing at
rem      the wrong cause. The third-party tool dir (175 npm deps)
rem      is NOT invoked from here, so the risk surface differs.
rem   2. This script is long-running: window open = console running.
rem
rem  House rules kept: no dependency on system PATH; diagnostics go
rem  to logs\ui-console.log (paths and versions only, NEVER the
rem  key); no success wording on failure paths; visible pause.
rem ============================================================

rem ---- 1. Locate node from PATH (portable, no absolute machine paths) ----
set "NODE_DIR="
call :resolve_from_path
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
set "NODE_EXE=%NODE_DIR%\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\ui-console.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

echo ============================================================
echo   Douyin auto-reply - Console
echo ============================================================
echo.

"%NODE_EXE%" -v >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js not found. Looked at:
  echo     %NODE_DIR%\node.exe
  echo     and PATH.
  goto :fail
)
for /f "delims=" %%V in ('"%NODE_EXE%" -v 2^>nul') do set "NODE_VER=%%V"

if not exist "%~dp0scripts\ui-server.mjs" (
  echo [X] Missing file: scripts\ui-server.mjs
  goto :fail
)
if not exist "%~dp0ui\index.html" (
  echo [X] Missing file: ui\index.html
  goto :fail
)

(
  echo ------------------------------------------------------------
  echo [%DATE% %TIME%] console start
  echo node : %NODE_VER%
  echo dir  : %NODE_DIR%
) >> "%LOG_FILE%" 2>&1

echo Your browser will open in a moment.
echo Address: shown below (this copy uses a FIXED port, set in config\instance.json)
echo.
echo   - This page is reachable ONLY from this computer.
echo   - Keep THIS window open while using the console.
echo   - Closing this window stops the console. It does not touch
echo     your account and does not send anything.
echo.

"%NODE_EXE%" "%~dp0scripts\ui-server.mjs" %*
set "RC=%ERRORLEVEL%"

>> "%LOG_FILE%" echo [%DATE% %TIME%] console exit code = %RC%

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   Console closed normally.
) else (
  echo   Console exited with code %RC%.
  echo   Read the message above. Diagnostics: %LOG_FILE%
)
echo   Press any key to close.
echo ============================================================
pause
exit /b %RC%

rem ===================== subroutines =====================

:resolve_from_path
rem Search PATH for node; where.exe returns a path with a trailing backslash.
set "NODE_DIR="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_DIR set "NODE_DIR=%%~dpI"
if defined NODE_DIR set "NODE_DIR=%NODE_DIR:~0,-1%"
exit /b 0

:fail
echo.
echo ============================================================
echo   Cannot start the console. See the [X] line above.
echo   Press any key to close.
echo ============================================================
pause
exit /b 1
