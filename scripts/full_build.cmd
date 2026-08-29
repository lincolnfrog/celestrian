@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  Celestrian - full build (Windows, native cmd.exe).
REM
REM  Wipes build\Celestrian_artefacts before building so the
REM  POST_BUILD ui\ copy always reruns. UI-only edits never reach
REM  the app otherwise: that copy is attached to the link step, and
REM  editing JS/CSS doesn't relink, so an incremental build leaves
REM  the stale ui\ sitting beside the exe.
REM
REM      scripts\full_build.cmd          Release (default)
REM      scripts\full_build.cmd Debug    Debug build
REM      scripts\full_build.cmd clean    delete the build folder
REM
REM  This is the native twin of scripts\full_build.sh, which does
REM  the same job on macOS and on Windows under Git Bash - use this
REM  one when you don't want to go through bash. Toolchain setup
REM  (MSVC, WebView2 SDK) lives in scripts\build.cmd, which this
REM  script calls to do the actual configure + build. One behaviour
REM  differs from the .sh: the build type argument is reapplied on
REM  every run here, not only on a fresh configure.
REM ============================================================

cd /d "%~dp0.."

REM --- Handle "clean" (same wipe as build.cmd: the whole build tree) ---
if /I "%~1"=="clean" (
    call "%~dp0build.cmd" clean
    exit /b !errorlevel!
)

set "BUILD_TYPE=%~1"
if "%BUILD_TYPE%"=="" set "BUILD_TYPE=Release"

echo === Celestrian Full Build ^(Windows, %BUILD_TYPE%^) ===
echo Cleaning build artifacts...

REM A locked-but-empty directory node is fine - sync tools and stale
REM CWDs pin folders, and the build just recreates into it. Files that
REM survive the wipe are NOT fine: that's a running Celestrian holding
REM its exe/ui open, and building on would silently keep the stale copy.
if exist build\Celestrian_artefacts rmdir /s /q build\Celestrian_artefacts >nul 2>&1
set "LOCKED="
for /f "delims=" %%f in ('dir /s /b /a-d build\Celestrian_artefacts 2^>nul') do set "LOCKED=%%f"
if defined LOCKED (
    echo ERROR: build\Celestrian_artefacts is locked - close Celestrian
    echo        ^(and anything else holding it^) and re-run.
    exit /b 1
)

REM build.cmd locates MSVC, loads vcvars, configures and builds, then
REM prints the path to the exe.
call "%~dp0build.cmd" %BUILD_TYPE%
exit /b !errorlevel!
