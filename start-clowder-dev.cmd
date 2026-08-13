@echo off
pushd "%~dp0" || exit /b 1
setlocal
REM ==========================================================================
REM  Clowder DEV launcher: same chain as start-clowder.cmd (proxy + Redis +
REM  kiro update + orphan sweep), but:
REM    - web runs `next dev` (hot reload - UI changes appear immediately)
REM    - API runs NODE_ENV=development
REM    - debug file logging ON (pino -> packages\api\data\logs\api\api.log,
REM      keeps CLI stderr on disk for diagnostics)
REM  Use while actively changing UI/platform code. For long unattended runs
REM  (overnight agent marathons) prefer start-clowder.cmd - production web
REM  is leaner and more deterministic.
REM ==========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-clowder.ps1" -Dev -Debug
set "clowder_exit_code=%ERRORLEVEL%"
echo.
echo [Clowder exited] Press any key to close...
pause >nul
endlocal & popd & exit /b %clowder_exit_code%
