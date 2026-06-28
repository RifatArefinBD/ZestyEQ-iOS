#!/bin/bash
# Zesty EQ iOS - Terminal Build Script
# Requires: macOS + Xcode 14+ + XcodeGen
#
# Usage:
#   ./build.sh              # Build for debug simulator
#   ./build.sh release      # Build for release (requires signing)
#   ./build.sh device       # Build for physical device (requires DEVELOPMENT_TEAM)
#   ./build.sh clean        # Clean build artifacts
#
# First time setup:
#   1. Install XcodeGen: brew install xcodegen
#   2. Run: ./build.sh

set -e

SCHEME="ZestyEQ"
CONFIG="${1:-Debug}"
WORKSPACE="ZestyEQ.xcodeproj"
DERIVED_DATA=".build"

if [ "$1" == "clean" ]; then
    echo "Cleaning..."
    rm -rf "$DERIVED_DATA"
    rm -rf "$WORKSPACE"
    echo "Done."
    exit 0
fi

echo "=== Zesty EQ iOS Builder ==="

if ! command -v xcodegen &> /dev/null; then
    echo "ERROR: XcodeGen not found. Install with: brew install xcodegen"
    exit 1
fi

if [ ! -f "project.yml" ]; then
    echo "ERROR: project.yml not found. Run this from the project root."
    exit 1
fi

echo "[1/3] Generating Xcode project..."
xcodegen generate --quiet

echo "[2/3] Resolving dependencies..."
xcodebuild -resolvePackageDependencies -project "$WORKSPACE" -scheme "$SCHEME" 2>&1 | tail -5

echo "[3/3] Building..."
if [ "$1" == "device" ] || [ "$1" == "release" ]; then
    xcodebuild -project "$WORKSPACE" \
        -scheme "$SCHEME" \
        -configuration "$CONFIG" \
        -derivedDataPath "$DERIVED_DATA" \
        -destination 'generic/platform=iOS' \
        clean build \
        2>&1 | xcpretty || xcodebuild -project "$WORKSPACE" \
        -scheme "$SCHEME" \
        -configuration "$CONFIG" \
        -derivedDataPath "$DERIVED_DATA" \
        -destination 'generic/platform=iOS' \
        clean build
else
    xcodebuild -project "$WORKSPACE" \
        -scheme "$SCHEME" \
        -configuration "$CONFIG" \
        -derivedDataPath "$DERIVED_DATA" \
        -destination 'platform=iOS Simulator,name=iPhone 14,OS=latest' \
        clean build \
        2>&1 | xcpretty || xcodebuild -project "$WORKSPACE" \
        -scheme "$SCHEME" \
        -configuration "$CONFIG" \
        -derivedDataPath "$DERIVED_DATA" \
        -destination 'platform=iOS Simulator,name=iPhone 14,OS=latest' \
        clean build
fi

echo ""
echo "=== Build complete ==="
echo "Artifacts: $DERIVED_DATA/Build/Products/$CONFIG-iphoneos/"
echo "App bundle: ZestyEQ.app"
