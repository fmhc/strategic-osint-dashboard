#!/usr/bin/env bash
# Vendor CesiumJS locally so the dashboard serves it itself (offline / DSGVO,
# no runtime CDN call). The vendored dir is gitignored; run this after a fresh
# clone (and it's invoked from the Dockerfile build).
set -euo pipefail

VERSION="${CESIUM_VERSION:-1.113}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/vendor/cesium"
URL="https://github.com/CesiumGS/cesium/releases/download/${VERSION}/Cesium-${VERSION}.zip"
TMP="$(mktemp -d)"

echo "[fetch-cesium] downloading Cesium ${VERSION} …"
curl -fsSL --max-time 180 -o "$TMP/cesium.zip" "$URL"

echo "[fetch-cesium] extracting Build/Cesium → $DEST"
unzip -q -o "$TMP/cesium.zip" "Build/Cesium/*" -d "$TMP/x"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$TMP/x/Build/Cesium" "$DEST"
rm -rf "$TMP"

echo "[fetch-cesium] done: $(du -sh "$DEST" | cut -f1) at $DEST"
