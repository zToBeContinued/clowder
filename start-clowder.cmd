@echo off
REM ==========================================================================
REM  Clowder ONE-CLICK launcher: proxy + trust-all + Redis + start.
REM  Double-click this. First run downloads a portable Redis (needs GitHub;
REM  keep your proxy on 7890 running). No other manual steps.
REM ==========================================================================
powershell -ExecutionPolicy Bypass -File "%~dp0start-clowder.ps1"
echo.
echo [Clowder exited] Press any key to close...
pause >nul
