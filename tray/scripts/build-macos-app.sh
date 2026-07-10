#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKOUT_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
APP_DIR="${1:-/tmp/Clawser Tray.app}"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

(
  cd "$ROOT_DIR"
  if [ "${CLAWSER_TRAY_EMBED_DEV_ROOT:-1}" = "1" ]; then
    go build \
      -ldflags "-X 'clawser-tray/internal/clawser.devCheckoutRoot=$CHECKOUT_ROOT'" \
      -o "$MACOS_DIR/clawser-tray" \
      .
  else
    go build \
      -o "$MACOS_DIR/clawser-tray" \
      .
  fi
)

cp "$CHECKOUT_ROOT/installer/chrome-extension-install.html" "$RESOURCES_DIR/chrome-extension-install.html"
rm -rf "$RESOURCES_DIR/chrome-extension"
cp -R "$CHECKOUT_ROOT/chrome-extension" "$RESOURCES_DIR/chrome-extension"
find "$RESOURCES_DIR" -name '._*' -delete
xattr -cr "$RESOURCES_DIR" 2>/dev/null || true

cat >"$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>clawser-tray</string>
  <key>CFBundleIdentifier</key>
  <string>dev.clawser.tray.local</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Clawser Tray</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo "$APP_DIR"
