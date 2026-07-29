@echo off
pushd "%~dp0" || exit /b 1
setlocal
REM ==========================================================================
REM  Reclaim disk from Kiro IDE / kiro-cli caches that nothing else expires.
REM  Double-click to sweep with the default policy. Runs automatically on
REM  every Clowder start too, so this is only for an on-demand cleanup.
REM
REM  Any arguments are passed through to the script, e.g.:
REM    sweep-kiro.cmd -DryRun              show what would go, delete nothing
REM    sweep-kiro.cmd -CliSessionDays 3    keep only 3 days of CLI sessions
REM    sweep-kiro.cmd -AgentStateIdleDays 14   DESTRUCTIVE, see script header
REM ==========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sweep-kiro-artifacts.ps1" %*
set "sweep_exit_code=%ERRORLEVEL%"
echo.
echo [Sweep finished] Press any key to close...
pause >nul
endlocal & popd & exit /b %sweep_exit_code%
