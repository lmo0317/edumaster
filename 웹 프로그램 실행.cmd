@echo off
cd /d "%~dp0"
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\start-web.ps1" -Watch
