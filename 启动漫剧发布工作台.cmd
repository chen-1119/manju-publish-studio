@echo off
cd /d "%~dp0"
node launch.js
if errorlevel 1 (
  echo 启动失败，请查看提示。
  pause
  exit /b 1
)
start "" "http://127.0.0.1:4187"
