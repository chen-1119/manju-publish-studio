@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装百度转存组件.ps1"
if errorlevel 1 (
  echo 安装未完成，请查看上方提示。
  pause
  exit /b 1
)
pause
