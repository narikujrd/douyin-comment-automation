@echo off
chcp 65001 >nul
title Environment Check (Step 0 of 2)
cd /d "%~dp0"

rem ============================================================
rem  Run this first when something looks wrong. It is READ-ONLY:
rem  no Douyin request, no visible browser window, no touching the session.
rem  It lights up every precondition one by one, so you can see exactly
rem  which step is blocking you instead of guessing at a blank window.
rem ============================================================

rem ---- Locate node from PATH. Install Node.js 20+ and put it on PATH. ----
set "NODE_DIR="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_DIR set "NODE_DIR=%%~dpI"
if defined NODE_DIR set "NODE_DIR=%NODE_DIR:~0,-1%"
set "NODE_EXE=%NODE_DIR%\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

rem ---- Security: never let third-party tools read the key from env ----
set "DEEPSEEK_API_KEY="

echo ============================================================
echo   Step 0 / 2 : Environment check (read-only)
echo   Checks node / deps / browser engine / network.
echo ============================================================
echo.

"%NODE_EXE%" scripts\check-browser.mjs
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   RESULT: OK  - environment ready. Next: run the login script (step 2).
) else (
  echo   RESULT: NOT OK - follow the [X] "how to fix" lines above.
  echo   If unsure, send me the text in this window.
)
echo   This window will stay open. Press any key to close.
echo ============================================================
pause
exit /b %RC%
