@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "scripts\start-vision.ps1"
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "scripts\start-gemma-vision.ps1"
if exist "artifacts\installed\EduMaster.App.exe" (
    start "" "artifacts\installed\EduMaster.App.exe"
) else if exist "artifacts\release\EduMaster.App.exe" (
    start "" "artifacts\release\EduMaster.App.exe"
) else (
    dotnet run --project src\EduMaster.App
)

