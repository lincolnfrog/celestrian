@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  Celestrian - Windows packaging (docs/tasks.md B8)
REM
REM  Signs the Release build and produces an installer with Inno Setup.
REM  Run AFTER scripts\build.cmd (Release).
REM
REM      scripts\package_windows.cmd            sign + installer
REM      scripts\package_windows.cmd --no-sign  installer only
REM
REM  Required environment (never committed):
REM      CELESTRIAN_SIGN_PFX        path to the code-signing certificate
REM      CELESTRIAN_SIGN_PASSWORD   its password
REM  Optional:
REM      CELESTRIAN_SIGNTOOL        full path to signtool.exe (else PATH)
REM      CELESTRIAN_ISCC            full path to ISCC.exe (Inno Setup 6)
REM
REM  Output: dist\Celestrian-<version>-windows-setup.exe
REM ============================================================

cd /d "%~dp0.."

set "EXE=build\Celestrian_artefacts\Release\Celestrian.exe"
if not exist "%EXE%" set "EXE=build\Celestrian_artefacts\Celestrian.exe"
if not exist "%EXE%" (
    echo ERROR: no Release build at build\Celestrian_artefacts\Release\Celestrian.exe
    echo        run scripts\build.cmd first
    exit /b 1
)

for /f "tokens=3 delims=( " %%v in ('findstr /r "^project(Celestrian VERSION" CMakeLists.txt') do set "VERSION=%%v"
if not defined VERSION set "VERSION=0.0.0"
if not exist dist mkdir dist

if /i "%~1"=="--no-sign" goto :installer
if not defined CELESTRIAN_SIGN_PFX (
    echo ERROR: CELESTRIAN_SIGN_PFX is not set ^(or pass --no-sign^)
    exit /b 1
)
set "SIGNTOOL=%CELESTRIAN_SIGNTOOL%"
if not defined SIGNTOOL set "SIGNTOOL=signtool"
echo === Signing %EXE% ===
"%SIGNTOOL%" sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
    /f "%CELESTRIAN_SIGN_PFX%" /p "%CELESTRIAN_SIGN_PASSWORD%" "%EXE%"
if errorlevel 1 exit /b 1

:installer
set "ISCC=%CELESTRIAN_ISCC%"
if not defined ISCC set "ISCC=ISCC"
echo === Building installer (Inno Setup) ===
"%ISCC%" /DAppVersion=%VERSION% /DSourceExe="%EXE%" scripts\celestrian.iss
if errorlevel 1 exit /b 1

if /i not "%~1"=="--no-sign" (
    echo === Signing the installer ===
    "%SIGNTOOL%" sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
        /f "%CELESTRIAN_SIGN_PFX%" /p "%CELESTRIAN_SIGN_PASSWORD%" ^
        "dist\Celestrian-%VERSION%-windows-setup.exe"
    if errorlevel 1 exit /b 1
)
echo Installer: dist\Celestrian-%VERSION%-windows-setup.exe
endlocal
