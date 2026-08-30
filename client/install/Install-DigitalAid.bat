@echo off
setlocal
REM Double-click this to install Digital Aid. It elevates itself (UAC prompt), then runs the
REM PowerShell installer sitting next to it. Nothing to type.

REM Already elevated? "net session" only succeeds with admin rights.
net session >nul 2>&1
if %errorlevel%==0 goto :elevated

echo Requesting administrator rights (approve the UAC prompt)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:elevated
REM %~dp0 is this .bat's own folder (with trailing backslash) regardless of the working directory,
REM so it works when Windows launches the elevated copy from C:\Windows\System32.
REM
REM No -ExePath: the .ps1 looks for DigitalAid.exe beside itself first and falls back to ..\dist\.
REM Passing the repo path from here used to force one layout, which the flat Install Kit is not.
echo Installing from "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-DigitalAid.ps1"

echo.
echo Done. Review the messages above, then close this window.
pause
