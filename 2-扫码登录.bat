@echo off
chcp 65001 >nul
title Douyin Login (Step 2 of 2)
cd /d "%~dp0"

rem ============================================================
rem  Why this file is so long (revised 2026-10-15)
rem  The original version was a single line:  npm run auth
rem  Double-clicking it printed:
rem      npm is not recognized as an internal or external command
rem  Root cause: npm was not on PATH. The key-check script had already
rem  switched to an absolute node path; this one was missed. It also
rem  printed "Finished" even on failure, which looked like success.
rem
rem  This version does four things:
rem    1. locate node/npm by absolute path, no PATH dependency
rem    2. preflight four things (node / tool dir / deps / browser engine)
rem       and log diagnostics to logs\scan-login.log so that an
rem       instantly closing window can still be investigated
rem    3. auto-download the browser engine when it is missing
rem    4. report the real exit code, and use a VISIBLE pause
rem
rem  Note: every "read exit code then branch" step uses call :subroutine.
rem  NEVER read %ERRORLEVEL% inside a parenthesised block: cmd expands the
rem  whole block up front, so you get a stale value and the failure check
rem  silently does nothing (hit and fixed in this round).
rem ============================================================

rem ---- 1. Locate node from PATH (portable, no absolute machine paths) ----
set "NODE_DIR="
call :resolve_from_path
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"

set "NODE_EXE=%NODE_DIR%\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "NPM_CMD=%NODE_DIR%\npm.cmd"
if not exist "%NPM_CMD%" set "NPM_CMD="

rem ---- 2. Security: strip the key. tool\ is an external clone with 175 ----
rem         npm deps; any poisoned one could read process.env directly. ----
set "DEEPSEEK_API_KEY="

set "TOOL_DIR=%~dp0tool"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\scan-login.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

echo ============================================================
echo   Step 2 / 2 : Douyin login (scan QR code)
echo ============================================================
echo.

rem ---- 3. Preflight: node ----
"%NODE_EXE%" -v >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js not found. Looked at:
  echo     %NODE_DIR%\node.exe
  echo     and PATH.
  goto :fail
)
for /f "delims=" %%V in ('"%NODE_EXE%" -v 2^>nul') do set "NODE_VER=%%V"

rem ---- 4. Preflight: tool directory ----
if not exist "%TOOL_DIR%\package.json" (
  echo [X] Tool folder is missing or incomplete:
  echo     %TOOL_DIR%
  goto :fail
)

rem ---- 5. Preflight: dependencies (install if missing) ----
if not exist "%TOOL_DIR%\node_modules" call :ensure_deps
if errorlevel 1 goto :fail

cd /d "%TOOL_DIR%"

rem ---- 6. Preflight: browser engine (download if missing) ----
"%NODE_EXE%" -e "const{chromium}=require('playwright');process.exit(require('fs').existsSync(chromium.executablePath())?0:1)" >nul 2>&1
if errorlevel 1 call :ensure_engine
if errorlevel 1 goto :fail

rem ---- Write diagnostics (paths and versions only, NEVER the key) ----
(
  echo ------------------------------------------------------------
  echo [%DATE% %TIME%] step 2 start
  echo node      : %NODE_VER%
  echo node dir  : %NODE_DIR%
  echo npm       : %NPM_CMD%
  echo tool dir  : %TOOL_DIR%
) >> "%LOG_FILE%" 2>&1

echo A browser window will open in a moment.
echo Scan the QR code with your Douyin app.
echo.
echo Tip: if the window shows the comment-management page and you are
echo      already logged in, no QR code is needed - just press Enter.
echo.
echo ------------------------------------------------------------
echo   When you are done in the browser, come back to THIS window
echo   and press Enter to close the browser and finish.
echo ------------------------------------------------------------
echo.

if defined NPM_CMD (
  call "%NPM_CMD%" run auth
) else (
  "%NODE_EXE%" src\auth-douyin.mjs
)
set "RC=%ERRORLEVEL%"

>> "%LOG_FILE%" echo [%DATE% %TIME%] step 2 exit code = %RC%

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   RESULT: OK  - login flow finished.
  echo   Session saved to: %TOOL_DIR%\.playwright\douyin-profile
) else (
  echo   RESULT: NOT OK - exit code %RC%.
  echo   Read the message above. Diagnostics: %LOG_FILE%
)
echo   This window will stay open. Press any key to close.
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

:ensure_deps
echo [i] Dependencies are not installed yet. Installing...
echo     This needs internet and takes a few minutes.
pushd "%TOOL_DIR%"
if defined NPM_CMD ( call "%NPM_CMD%" install ) else ( call npm install )
set "PREP_RC=%ERRORLEVEL%"
popd
if not "%PREP_RC%"=="0" (
  echo [X] "npm install" failed with exit code %PREP_RC%.
  exit /b 1
)
exit /b 0

:ensure_engine
echo [i] Browser engine ^(Chromium^) is not installed yet.
echo     Downloading about 173 MB with multiple threads.
echo     This usually takes 15-30 minutes depending on your network.
echo.
rem Use the project own multithreaded downloader, NOT npx playwright install:
rem the official CDN gives ~67 KB/s single-thread; 173 MB takes 40-60 min.
"%NODE_EXE%" "%~dp0scripts\fetch-chromium.mjs"
if errorlevel 1 (
  echo.
  echo [X] Chromium download failed. Check your network, then run again.
  exit /b 1
)
echo.
echo [OK] Browser engine installed.
echo.
exit /b 0

:fail
echo.
echo ============================================================
echo   Cannot start the login flow (see the [X] line above).
echo   This window will stay open. Press any key to close.
echo ============================================================
pause
exit /b 1
