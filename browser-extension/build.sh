#!/bin/bash

# Build script for PP Jira Bridge extension
# Creates builds for Chrome and Firefox

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔨 Building PP Jira Bridge extensions..."

# Chrome build (Manifest V3)
echo "📦 Building Chrome version..."
rm -rf build-chrome
mkdir -p build-chrome
cp manifest.json browser-polyfill.min.js background.js content.js popup.html popup.js README.md build-chrome/
cp -r icons build-chrome/
cd build-chrome
zip -r ../pp-jira-bridge-chrome.zip . -x "*.git*" -x "build-chrome/*" -x "build-firefox/*"
cd ..
echo "✅ Chrome build: pp-jira-bridge-chrome.zip"

# Firefox build (Manifest V2)
echo "📦 Building Firefox version..."
rm -rf build-firefox
mkdir -p build-firefox
cp manifest-firefox.json browser-polyfill.min.js background.js content.js popup.html popup.js README.md build-firefox/
cp -r icons build-firefox/
cd build-firefox
zip -r ../pp-jira-bridge-firefox.zip . -x "*.git*" -x "build-chrome/*" -x "build-firefox/*"
cd ..
echo "✅ Firefox build: pp-jira-bridge-firefox.zip"

# Создаём общий ZIP с инструкциями
echo "📦 Building universal package with instructions..."
rm -rf build-universal
mkdir -p build-universal
cp manifest.json manifest-firefox.json browser-polyfill.min.js background.js content.js popup.html popup.js README.md build-universal/
cp -r icons build-universal/
cp chrome-instruction.html firefox-instruction.html edge-instruction.html build-universal/
cp -r windows build-universal/ 2>/dev/null || true
cd build-universal
zip -r ../pp-jira-bridge-all.zip . -x "*.git*" -x "build-*/*"
cd ..
echo "✅ Universal build: pp-jira-bridge-all.zip"

echo ""
echo "🎉 Builds complete!"
echo ""
echo "📋 Next steps:"
echo "   Chrome:  Load unpacked from build-chrome/ or upload pp-jira-bridge-chrome.zip to Chrome Web Store"
echo "   Firefox: Upload pp-jira-bridge-firefox.zip to Firefox Add-ons Developer Hub"
echo "   All:     pp-jira-bridge-all.zip содержит все файлы + инструкции"
