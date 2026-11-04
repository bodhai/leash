@echo off
REM Double-click to start Leash. Installs dependencies on first run.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install || (pause & exit /b 1)
)
if not exist .env copy .env.example .env >nul
call npm start
pause
