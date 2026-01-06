#!/bin/bash
# Full clean build script for Celestrian
# Ensures all artifacts (including UI files) are rebuilt

set -e

echo "=== Celestrian Full Build ==="
echo "Cleaning build artifacts..."
rm -rf build/Celestrian_artefacts/

echo "Building..."
cmake --build build --target Celestrian -j8

echo "=== Build Complete ==="
echo "App bundle: build/Celestrian_artefacts/Debug/Celestrian.app"
