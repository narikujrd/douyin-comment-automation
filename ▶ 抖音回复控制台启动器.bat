@echo off
chcp 65001 >nul
title Douyin Comment Console - Launcher
cd /d "%~dp0"

rem ============================================================
rem  Double-click entry point. The Chinese banner is NOT in this
rem  file on purpose: a .bat containing multi-byte characters gets
rem  mis-parsed by cmd (it decodes the file with the active code
rem  page, and once an I/O buffer boundary lands inside a multi-byte
rem  character the line is split into two bogus commands ->
rem  "xxx is not recognized"). The failure depends on file/path
rem  length, so it comes and goes.
rem
rem  Rule for this project: .bat files stay pure ASCII. Chinese text
rem  lives in assets\launcher-banner.txt and is dumped with `type`
rem  under code page 65001.
rem
rem  Startup behaviour is delegated to the console script (3-*.bat),
rem  resolved by pattern so no multi-byte literal is needed here.
rem ============================================================

if exist "%~dp0assets\launcher-banner.txt" (
  type "%~dp0assets\launcher-banner.txt"
) else (
  echo.
  echo   ================================================================
  echo.
  echo        D O U Y I N   C O M M E N T   C O N S O L E
  echo.
  echo               L A U N C H E R
  echo.
  echo   ================================================================
  echo.
  echo     Keep this window open. Closing it stops the console.
  echo.
  echo   ================================================================
  echo.
)

set "CONSOLE_BAT="
for %%F in ("%~dp03-*.bat") do if not defined CONSOLE_BAT set "CONSOLE_BAT=%%~fF"
if not defined CONSOLE_BAT goto :nofile

call "%CONSOLE_BAT%" %*
exit /b %ERRORLEVEL%

:nofile
echo   [X] Cannot find the console script (3-*.bat).
echo       Keep this launcher in the same folder as the other .bat files.
echo.
pause
exit /b 1
