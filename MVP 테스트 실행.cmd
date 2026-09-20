@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 문제와 풀이 MVP 개발용 테스트를 실행합니다.
dotnet build "scripts\material-mvp-smoke\MaterialMvpSmoke.csproj" -c Release --no-restore
if errorlevel 1 goto finish
if "%~1"=="" (
  dotnet "scripts\material-mvp-smoke\bin\Release\net10.0-windows10.0.19041.0\MaterialMvpSmoke.dll" --saved
) else (
  dotnet "scripts\material-mvp-smoke\bin\Release\net10.0-windows10.0.19041.0\MaterialMvpSmoke.dll" %*
)
:finish
echo.
echo 일반 프로그램은 프로그램 실행.cmd 또는 웹에서 이용하세요.
pause
