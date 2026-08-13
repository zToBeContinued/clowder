@echo off
REM Windows shim for the extensionless Node CLI next to this file.
REM Without this, cmd hands the extensionless "clowder" file to ShellExecute
REM and Windows pops the "How do you want to open this file?" picker on the
REM desktop whenever an agent runs the $CLI fallback (2026-08-13 incident).
node "%~dp0clowder" %*
exit /b %ERRORLEVEL%
