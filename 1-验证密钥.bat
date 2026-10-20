@echo off
chcp 65001 >nul
title DeepSeek Key Check (Step 1 of 2)
cd /d "%~dp0"

rem ---- Locate node from PATH. Install Node.js 20+ and put it on PATH. ----
set "NODE_DIR="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_DIR set "NODE_DIR=%%~dpI"
if defined NODE_DIR set "NODE_DIR=%NODE_DIR:~0,-1%"
set "NODE_EXE=%NODE_DIR%\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo ============================================================
echo   Step 1 / 2 : Check DeepSeek API key
echo   (If no key is found, Notepad will open for you to fill it in)
echo ============================================================
echo.

"%NODE_EXE%" scripts\check-api.mjs
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   RESULT: OK  - key works, you can go on to step 2.
) else (
  echo   RESULT: NOT OK - read the message above.
)
echo   This window will stay open. Press any key to close.
echo ============================================================
pause >nul
