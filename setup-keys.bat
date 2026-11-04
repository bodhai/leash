@echo off
REM Double-click: saves your Claude and PayPal sandbox keys into .env from the clipboard, then tests them.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-keys.ps1"
pause
