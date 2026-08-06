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
# A locked-but-empty directory node is fine (Windows: sync tools and
# stale CWDs pin folders) — the build recreates into it. Files that
# survive the wipe are NOT fine: that's a running Celestrian holding
# its exe/ui open, and building would silently keep the stale copy.
rm -rf build/Celestrian_artefacts/ 2>/dev/null || true
if [ -d build/Celestrian_artefacts ] && \
   [ -n "$(find build/Celestrian_artefacts -type f -print -quit)" ]; then
    echo "ERROR: build/Celestrian_artefacts is locked — close Celestrian" \
         "(and anything else holding it) and re-run."
    exit 1
fi

if [ "$PLATFORM" = "windows" ]; then
    # MSVC toolchain: everything must run under the vcvars64 environment,
    # so configure+build are a single cmd.exe invocation.
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

    WEBVIEW2_DIR="C:/tools/webview2"
    if [ ! -d "/c/tools/webview2" ]; then
        echo "ERROR: WebView2 SDK not found at $WEBVIEW2_DIR" \
             "(see scripts/build.cmd for the download commands)."
        exit 1
    fi

    # The steps go through a temp .cmd file: passing quoted arguments
    # straight to `cmd /c` from bash mangles the quotes (MSYS escapes
    # them as \" on the native command line, which cmd cannot parse).
    TMP_CMD="$(mktemp -t celestrian_build_XXXXXX)".cmd
    {
        echo "@echo off"
        echo "call \"$VSINSTALL\\VC\\Auxiliary\\Build\\vcvars64.bat\" >nul || exit /b 1"
        if [ ! -f build/CMakeCache.txt ]; then
            echo "Configuring (Ninja, $BUILD_TYPE)..." >&2
            echo "cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=$BUILD_TYPE -DJUCE_WEBVIEW2_PACKAGE_LOCATION=$WEBVIEW2_DIR || exit /b 1"
        fi
        echo "cmake --build build --target Celestrian --parallel || exit /b 1"
    } > "$TMP_CMD"
    echo "Building..."
    MSYS_NO_PATHCONV=1 cmd /c "$(cygpath -w "$TMP_CMD")" || { rm -f "$TMP_CMD"; exit 1; }
    rm -f "$TMP_CMD"
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
