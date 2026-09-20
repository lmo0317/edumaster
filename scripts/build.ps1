$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    dotnet test tests/EduMaster.Core.Tests -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    dotnet publish src/EduMaster.App -c Release -r win-x64 --self-contained true -p:PublishTrimmed=false -o artifacts/release
    if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
    if (Test-Path tools/cache/inno/ISCC.exe) {
        & tools/cache/inno/ISCC.exe scripts/installer.iss
        if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }
    }
    Write-Host 'Ready: artifacts/release/EduMaster.App.exe'
} finally { Pop-Location }
