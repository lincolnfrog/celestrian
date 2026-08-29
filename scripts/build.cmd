@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  Celestrian - Windows build script (MSVC + Ninja/VS)
REM
REM  This app's UI is a JUCE WebView2 component, which requires
REM  the MSVC toolchain + Windows SDK. MinGW/GCC will NOT build it
REM  (no WebView2 / incomplete Windows SDK headers).
REM
REM  One-time prerequisite - install the Build Tools (no full IDE):
REM      winget install --id Microsoft.VisualStudio.2022.BuildTools -e ^
REM        --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
REM
REM  Then run from a normal cmd.exe (no Developer Prompt needed):
REM      scripts\build.cmd            (Release, default)
REM      scripts\build.cmd Debug      (Debug build)
REM      scripts\build.cmd clean      (delete the build folder)
REM
REM  First run downloads JUCE + the WebView2 SDK and compiles
REM  everything, so it can take a while. Later runs are incremental.
REM ============================================================

REM --- Use the system CMake to drive the build (it can do HTTPS
REM     downloads, which the JUCE fetch needs). ---
set "CMAKE=C:\Program Files\CMake\bin\cmake.exe"
if not exist "%CMAKE%" set "CMAKE=cmake"

REM Move to the repo root (this script lives in <repo>\scripts).
cd /d "%~dp0.."

REM --- Handle "clean" ---
if /I "%~1"=="clean" (
    echo Removing build folder...
    if exist build rmdir /s /q build
    echo Done.
    goto :eof
)

REM --- Locate MSVC via vswhere ---
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSINSTALL="
if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
)

if not defined VSINSTALL (
    echo ERROR: MSVC C++ toolchain not found.
    echo.
    echo This app needs the Visual Studio Build Tools ^(command-line only,
    echo no full IDE^). Install them once with:
    echo.
    echo   winget install --id Microsoft.VisualStudio.2022.BuildTools -e ^
    echo     --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    echo.
    echo Then re-run this script.
    exit /b 1
)

echo Found MSVC at: %VSINSTALL%

REM Load the MSVC command-line environment (compiler, Windows SDK, etc.)
call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
    echo ERROR: failed to initialize the MSVC environment.
    exit /b 1
)

REM --- Build type from first arg; default Release ---
set "BUILD_TYPE=%~1"
if "%BUILD_TYPE%"=="" set "BUILD_TYPE=Release"

echo === Celestrian build ^(%BUILD_TYPE%, MSVC^) ===
echo CMake: %CMAKE%
echo.

REM --- Where the Microsoft.Web.WebView2 NuGet package was extracted.
REM     JUCE needs this for the WebView2-based UI; it does not download
REM     it automatically. This folder must CONTAIN a subfolder named
REM     *Microsoft.Web.WebView2*. ---
set "WEBVIEW2_DIR=C:/tools/webview2"

if not exist "%WEBVIEW2_DIR%" (
    echo ERROR: WebView2 SDK not found at "%WEBVIEW2_DIR%".
    echo Download and extract the NuGet package with:
    echo   curl -L -o webview2.zip https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.1901.177
    echo then unzip it into %WEBVIEW2_DIR%\Microsoft.Web.WebView2.1.0.1901.177
    exit /b 1
)

REM --- Configure (Ninja single-config; cl is now on PATH via vcvars) ---
echo [1/2] Configuring...
"%CMAKE%" -B build -G Ninja -DCMAKE_BUILD_TYPE=%BUILD_TYPE% ^
    -DJUCE_WEBVIEW2_PACKAGE_LOCATION="%WEBVIEW2_DIR%"
if errorlevel 1 goto :failed

REM --- Build the app target ---
echo.
echo [2/2] Building Celestrian...
"%CMAKE%" --build build --target Celestrian --parallel
if errorlevel 1 goto :failed

echo.
echo === Build complete ===
REM The artefact lands under a per-config subfolder, so find it rather
REM than hardcoding a path that only holds for one build type.
set "EXE="
for /f "delims=" %%f in ('dir /s /b build\Celestrian_artefacts\Celestrian.exe 2^>nul') do (
    if not defined EXE set "EXE=%%f"
)
if defined EXE (
    echo Run it:  !EXE!
) else (
    echo WARNING: build reported success but no Celestrian.exe was found
    echo under build\Celestrian_artefacts.
)
goto :eof

:failed
echo.
echo *** BUILD FAILED - see the errors above. ***
echo If it mentions a stale cache or wrong generator, run:
echo     scripts\build.cmd clean
echo then build again.
exit /b 1
