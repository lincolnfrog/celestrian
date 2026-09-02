#!/bin/bash
# Package Celestrian for macOS: sign, notarize, staple, and zip the app
# bundle (docs/tasks.md B8). Runs AFTER scripts/full_build.sh Release.
#
#   scripts/package_macos.sh                 sign + notarize + zip
#   scripts/package_macos.sh --sign-only     sign + zip (no notarization)
#
# Required environment (never committed — keep them in your shell):
#   CELESTRIAN_SIGN_IDENTITY   "Developer ID Application: <name> (<team>)"
#   CELESTRIAN_NOTARY_PROFILE  a keychain profile created with
#                              `xcrun notarytool store-credentials`
#                              (holds the Apple ID, team id, app password)
#
# Output: dist/Celestrian-<version>-macos.zip, notarized and stapled.
# The ASIO note in CMakeLists.txt does not apply here; the bundle links
# nothing beyond JUCE and the system frameworks.

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
APP="build/Celestrian_artefacts/Release/Celestrian.app"
[ -d "$APP" ] || APP="build/Celestrian_artefacts/Celestrian.app"
if [ ! -d "$APP" ]; then
    echo "ERROR: no Release bundle at build/Celestrian_artefacts/Release/Celestrian.app"
    echo "       run scripts/full_build.sh Release first"
    exit 1
fi
if [ -z "${CELESTRIAN_SIGN_IDENTITY:-}" ]; then
    echo "ERROR: CELESTRIAN_SIGN_IDENTITY is not set"
    exit 1
fi

VERSION="$(sed -n 's/^project(Celestrian VERSION \([0-9.]*\).*/\1/p' CMakeLists.txt)"
ENTITLEMENTS="scripts/celestrian.entitlements"
OUT_DIR="dist"
ZIP="$OUT_DIR/Celestrian-${VERSION}-macos.zip"
mkdir -p "$OUT_DIR"

echo "=== Signing $APP as $CELESTRIAN_SIGN_IDENTITY ==="
# Hardened runtime + the entitlements notarization requires for an app
# that loads third-party plugins (VST3/AU) and uses the microphone.
codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$CELESTRIAN_SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

if [ "$MODE" = "--sign-only" ]; then
    echo "Signed (not notarized): $ZIP"
    exit 0
fi
if [ -z "${CELESTRIAN_NOTARY_PROFILE:-}" ]; then
    echo "ERROR: CELESTRIAN_NOTARY_PROFILE is not set (or pass --sign-only)"
    exit 1
fi

echo "=== Notarizing ==="
xcrun notarytool submit "$ZIP" --keychain-profile "$CELESTRIAN_NOTARY_PROFILE" --wait
echo "=== Stapling ==="
xcrun stapler staple "$APP"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
spctl --assess --type execute --verbose=2 "$APP"
echo "Notarized and stapled: $ZIP"
