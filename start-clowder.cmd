@echo off
pushd "%~dp0" || exit /b 1
setlocal
REM ==========================================================================
REM  Clowder ONE-CLICK launcher: proxy + trust-all + Redis + start.
REM  Double-click this. First run downloads a portable Redis (needs GitHub;
REM  keep your proxy on 7890 running). No other manual steps.
REM ==========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-clowder.ps1"
set "clowder_exit_code=%ERRORLEVEL%"
echo.
echo [Clowder exited] Press any key to close...
pause >nul
endlocal & popd & exit /b %clowder_exit_code%
