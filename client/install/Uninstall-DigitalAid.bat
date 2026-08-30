@echo off
setlocal
REM Double-click this to uninstall Digital Aid. It elevates itself (UAC prompt), then runs the
REM PowerShell uninstaller next to it. Keeps state + logs by default (edit the line below to -Purge
REM if you want those deleted too).

REM Already elevated? "net session" only succeeds with admin rights.
net session >nul 2>&1
if %errorlevel%==0 goto :elevated

echo Requesting administrator rights (approve the UAC prompt)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:elevated
REM %~dp0 is this .bat's own folder (with trailing backslash), correct even when the elevated copy
REM starts from C:\Windows\System32. Add -Purge to the line below to also delete state + logs.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-DigitalAid.ps1"

echo.
echo Done. Review the messages above, then close this window.
pause
