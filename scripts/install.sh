#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${CLAWSER_REPO_URL:-https://github.com/agilecho2022-lgtm/clawser.git}"
BRANCH="${CLAWSER_BRANCH:-main}"
INSTALL_DIR="${CLAWSER_INSTALL_DIR:-$HOME/.clawser-src}"
BIN_DIR="${CLAWSER_BIN_DIR:-$HOME/.local/bin}"
LINK_GLOBAL="${CLAWSER_LINK_GLOBAL:-0}"

log() {
  printf '\033[1;36m%s\033[0m %s\n' 'clawser' "$*"
}

warn() {
  printf '\033[1;33m%s\033[0m %s\n' 'clawser' "$*" >&2
}

die() {
  printf '\033[1;31m%s\033[0m %s\n' 'clawser' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

node_version_ok() {
  node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);
' >/dev/null 2>&1
}

ensure_prerequisites() {
  need_cmd git
  need_cmd node

  if ! node_version_ok; then
    die "Node.js 22.12+ is required; current version is $(node -v)"
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      log "pnpm not found; enabling pnpm with corepack"
      corepack enable pnpm >/dev/null
    fi
  fi

  need_cmd pnpm
}

checkout_source() {
  if [ ! -e "$INSTALL_DIR" ]; then
    log "cloning $REPO_URL#$BRANCH"
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    return
  fi

  if [ ! -d "$INSTALL_DIR/.git" ]; then
    die "$INSTALL_DIR exists but is not a git checkout"
  fi

  log "updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
}

install_clawser() {
  log "installing dependencies"
  pnpm -C "$INSTALL_DIR" install --frozen-lockfile

  log "building"
  pnpm -C "$INSTALL_DIR" build

  if [ "$LINK_GLOBAL" = "1" ]; then
    log "linking with pnpm link --global"
    pnpm -C "$INSTALL_DIR" link --global
    return
  fi

  log "linking clawser into $BIN_DIR"
  mkdir -p "$BIN_DIR"
  ln -sfn "$INSTALL_DIR/clawser.mjs" "$BIN_DIR/clawser"
  chmod +x "$INSTALL_DIR/clawser.mjs"
}

print_next_steps() {
  local clawser_bin="$BIN_DIR/clawser"

  if [ "$LINK_GLOBAL" = "1" ]; then
    clawser_bin="$(command -v clawser || true)"
  fi

  log "installed successfully"
  log "source: $INSTALL_DIR"

  if command -v clawser >/dev/null 2>&1; then
    log "binary: $(command -v clawser)"
    return
  fi

  log "binary: $clawser_bin"
  warn "$BIN_DIR is not on PATH for this shell"
  warn "add this line to your shell profile, then reopen the terminal:"
  printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
}

main() {
  ensure_prerequisites
  checkout_source
  install_clawser
  "$INSTALL_DIR/clawser.mjs" --help >/dev/null
  print_next_steps
}

main "$@"
