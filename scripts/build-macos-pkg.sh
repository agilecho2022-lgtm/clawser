#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD_DIR="${1:-$ROOT_DIR/dist-installer/Clawser}"
PKG_PATH="${2:-$ROOT_DIR/dist-installer/clawser-macos.pkg}"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"

if [ ! -d "$PAYLOAD_DIR" ]; then
  pnpm -C "$ROOT_DIR" installer:payload
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawser-pkg.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

INSTALL_ROOT="$WORK_DIR/root"
SCRIPTS_DIR="$WORK_DIR/scripts"
TARGET_DIR="$INSTALL_ROOT/Applications/Clawser"
BIN_DIR="$INSTALL_ROOT/usr/local/bin"

mkdir -p "$TARGET_DIR" "$BIN_DIR" "$SCRIPTS_DIR" "$(dirname "$PKG_PATH")"
cp -R "$PAYLOAD_DIR/." "$TARGET_DIR/"
cat >"$BIN_DIR/clawser" <<'CLIBIN'
#!/bin/sh
set -eu

exec /usr/bin/env node "/Applications/Clawser/clawser.mjs" "$@"
CLIBIN
chmod +x "$BIN_DIR/clawser"
find "$INSTALL_ROOT" -name '._*' -delete
xattr -cr "$INSTALL_ROOT" 2>/dev/null || true

cat >"$SCRIPTS_DIR/postinstall" <<'POSTINSTALL'
#!/bin/sh
pkill -x clawser-tray >/dev/null 2>&1 || true
open -n "/Applications/Clawser/Clawser Tray.app" >/dev/null 2>&1 || true
open "/Applications/Clawser/chrome-extension-install.html" >/dev/null 2>&1 || true
exit 0
POSTINSTALL
chmod +x "$SCRIPTS_DIR/postinstall"

pkgbuild \
  --root "$INSTALL_ROOT" \
  --scripts "$SCRIPTS_DIR" \
  --identifier "fun.toymotion.clawser" \
  --version "$VERSION" \
  --install-location "/" \
  "$PKG_PATH"

echo "$PKG_PATH"
