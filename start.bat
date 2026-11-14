@echo off
title Trade
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js
pause
