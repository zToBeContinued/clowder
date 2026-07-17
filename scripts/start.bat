@echo off
pushd "%~dp0.." || exit /b 1
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
set "clowder_exit_code=%ERRORLEVEL%"
endlocal & popd & exit /b %clowder_exit_code%
