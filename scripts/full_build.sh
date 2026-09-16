#!/bin/bash
# Full build script for Celestrian — macOS and Windows (Git Bash).
#
# Wipes build/Celestrian_artefacts before building so the POST_BUILD
# ui/ copy always reruns — UI-only edits never reach the app otherwise
# (the copy is tied to the link step, and JS/CSS changes don't relink).
#
#   scripts/full_build.sh            build (Release on first configure)
#   scripts/full_build.sh Debug      build type for a FRESH configure
#   scripts/full_build.sh clean      delete the build folder entirely
#
# An existing build/ keeps whatever generator and build type it was
# configured with — the type argument only applies when configuring
# from scratch (run clean first to switch).
#
# Windows notes: run from Git Bash. MSVC + Ninja are required (WebView2
# needs the MSVC toolchain; see scripts/build.cmd for the one-time
# Build Tools install). The WebView2 SDK must be at C:/tools/webview2.
# Nothing here shells out to cmd.exe — see the comment on the Windows
# branch for why that matters.

set -e

cd "$(dirname "$0")/.."

ARG="${1:-}"
if [ "$ARG" = "clean" ]; then
    echo "Removing build folder..."
    rm -rf build
    echo "Done."
    exit 0
fi
BUILD_TYPE="${ARG:-Release}"

case "$(uname -s)" in
    Darwin) PLATFORM=mac ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
    *) echo "ERROR: unsupported platform: $(uname -s)"; exit 1 ;;
esac

echo "=== Celestrian Full Build ($PLATFORM) ==="
echo "Cleaning build artifacts..."
# Only the per-config output folders go (the exe and its ui/ copy).
# JuceLibraryCode has to survive: CMake writes Info.txt in there at
# CONFIGURE time and nothing regenerates it during a build, so wiping
# it makes juceaide die with a bare "Unhandled exception".
#
# A locked-but-empty directory node is fine (Windows: sync tools and
# stale CWDs pin folders) — the build recreates into it. Files that
# survive the wipe are NOT fine: that's a running Celestrian holding
# its exe/ui open, and building would silently keep the stale copy.
if [ -d build/Celestrian_artefacts ]; then
    find build/Celestrian_artefacts -mindepth 1 -maxdepth 1 \
         ! -name JuceLibraryCode -exec rm -rf {} + 2>/dev/null || true
fi
if [ -d build/Celestrian_artefacts ] && \
   [ -n "$(find build/Celestrian_artefacts -name JuceLibraryCode -prune \
           -o -type f -print -quit)" ]; then
    echo "ERROR: build/Celestrian_artefacts is locked — close Celestrian" \
         "(and anything else holding it) and re-run."
    exit 1
fi

if [ "$PLATFORM" = "windows" ]; then
    # MSVC needs its toolchain environment (PATH/INCLUDE/LIB). We build
    # that up here in bash rather than shelling out to vcvars64.bat via
    # cmd.exe, because launching cmd.exe from bash can open a SEPARATE
    # console window: every line of build output goes there instead of
    # here, and the window closes the instant the build fails, so you
    # get an exit code and nothing to read. Everything below runs in
    # this shell — cmake's output lands in this terminal. Do not
    # reintroduce `cmd /c` here.
    VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
    if [ ! -f "$VSWHERE" ]; then
        echo "ERROR: vswhere.exe not found — install the VS Build Tools" \
             "(see scripts/build.cmd for the winget one-liner)."
        exit 1
    fi
    VSINSTALL=$("$VSWHERE" -latest -products '*' \
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
        -property installationPath | tr -d '\r')
    if [ -z "$VSINSTALL" ]; then
        echo "ERROR: no MSVC C++ toolchain found by vswhere."
        exit 1
    fi
    VS=$(cygpath -u "$VSINSTALL")

    # Compiler version: the same file vcvars64.bat reads.
    VCVER=$(tr -d '\r\n ' < "$VS/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt")
    VCDIR="$VS/VC/Tools/MSVC/$VCVER"
    if [ ! -x "$VCDIR/bin/Hostx64/x64/cl.exe" ]; then
        echo "ERROR: cl.exe not found under $VCDIR — the VC tools install looks broken."
        exit 1
    fi

    # Windows SDK: newest version directory that actually has headers.
    KITS=""
    for d in "/c/Program Files (x86)/Windows Kits/10" "/c/Program Files/Windows Kits/10"; do
        if [ -d "$d/Include" ]; then KITS="$d"; break; fi
    done
    SDKVER=""
    if [ -n "$KITS" ]; then
        for v in $(ls -1 "$KITS/Include" | sort -V -r); do
            if [ -f "$KITS/Include/$v/um/windows.h" ]; then SDKVER="$v"; break; fi
        done
    fi
    if [ -z "$SDKVER" ]; then
        echo "ERROR: no Windows SDK with um/windows.h found under" \
             "${KITS:-C:/Program Files (x86)/Windows Kits/10}/Include."
        exit 1
    fi

    # INCLUDE/LIB have to be native Windows paths; PATH stays POSIX
    # (MSYS converts it when it hands off to a native exe). Optional
    # directories are skipped when absent.
    _win() { cygpath -w "$1"; }
    _add_inc() { if [ -d "$1" ]; then INCLUDE="${INCLUDE:+$INCLUDE;}$(_win "$1")"; fi; }
    _add_lib() { if [ -d "$1" ]; then LIB="${LIB:+$LIB;}$(_win "$1")"; fi; }

    INCLUDE=""; LIB=""
    _add_inc "$VCDIR/include"
    _add_inc "$VCDIR/atlmfc/include"
    _add_inc "$KITS/Include/$SDKVER/ucrt"
    _add_inc "$KITS/Include/$SDKVER/shared"
    _add_inc "$KITS/Include/$SDKVER/um"
    _add_inc "$KITS/Include/$SDKVER/winrt"
    _add_inc "$KITS/Include/$SDKVER/cppwinrt"
    _add_lib "$VCDIR/lib/x64"
    _add_lib "$VCDIR/atlmfc/lib/x64"
    _add_lib "$KITS/Lib/$SDKVER/ucrt/x64"
    _add_lib "$KITS/Lib/$SDKVER/um/x64"
    export INCLUDE LIB

    # cl/link, then rc/mt from the SDK, then the Ninja bundled with the
    # Build Tools. VS's own cmake goes at the END so a system CMake still
    # wins — JUCE's dependency fetch needs one that can do HTTPS.
    VSCMAKE="$VS/Common7/IDE/CommonExtensions/Microsoft/CMake"
    export PATH="$VCDIR/bin/Hostx64/x64:$KITS/bin/$SDKVER/x64:$VSCMAKE/Ninja:$PATH:$VSCMAKE/CMake/bin"

    if ! command -v ninja >/dev/null 2>&1; then
        echo "ERROR: ninja not found (looked in $VSCMAKE/Ninja and on PATH)."
        echo "       Add the 'C++ CMake tools for Windows' component to the Build Tools."
        exit 1
    fi

    WEBVIEW2_DIR="C:/tools/webview2"
    if [ ! -d "/c/tools/webview2" ]; then
        echo "ERROR: WebView2 SDK not found at $WEBVIEW2_DIR" \
             "(see scripts/build.cmd for the download commands)."
        exit 1
    fi

    echo "MSVC $VCVER, Windows SDK $SDKVER"
    if [ ! -f build/CMakeCache.txt ]; then
        echo "Configuring (Ninja, $BUILD_TYPE)..."
        cmake -B build -G Ninja -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
            -DJUCE_WEBVIEW2_PACKAGE_LOCATION="$WEBVIEW2_DIR"
    fi
    echo "Building..."
    cmake --build build --target Celestrian --parallel
else
    if [ ! -f build/CMakeCache.txt ]; then
        echo "Configuring ($BUILD_TYPE)..."
        cmake -B build -DCMAKE_BUILD_TYPE="$BUILD_TYPE"
    fi
    echo "Building..."
    cmake --build build --target Celestrian -j8
fi

echo "=== Build Complete ==="
# The artefact lands under a per-config subfolder; find it rather than
# hardcoding the build type this tree happens to be configured with.
if [ "$PLATFORM" = "windows" ]; then
    find build/Celestrian_artefacts -name 'Celestrian.exe' | head -1 | sed 's/^/Run it:  /'
else
    find build/Celestrian_artefacts -name 'Celestrian.app' -maxdepth 2 | head -1 | sed 's/^/App bundle: /'
fi
