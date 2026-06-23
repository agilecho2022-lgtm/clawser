#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${CLAWSER_REPO_URL:-https://github.com/agilecho2022-lgtm/clawser.git}"
BRANCH="${CLAWSER_BRANCH:-main}"
INSTALL_DIR="${CLAWSER_INSTALL_DIR:-/opt/clawser}"

log() {
  printf '[clawser-install] %s\n' "$*"
}

die() {
  printf '[clawser-install] ERROR: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

run_as_root_or_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "need root privileges for $*"
  fi
}

prepare_install_dir() {
  local parent
  parent="$(dirname "$INSTALL_DIR")"
  run_as_root_or_sudo mkdir -p "$parent"

  if [ ! -e "$INSTALL_DIR" ]; then
    log "cloning $REPO_URL#$BRANCH to $INSTALL_DIR"
    run_as_root_or_sudo git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    return
  fi

  if [ ! -d "$INSTALL_DIR/.git" ]; then
    die "$INSTALL_DIR exists but is not a git checkout"
  fi

  log "updating existing checkout in $INSTALL_DIR"
  run_as_root_or_sudo git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  run_as_root_or_sudo git -C "$INSTALL_DIR" checkout "$BRANCH"
  run_as_root_or_sudo git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
}

main() {
  need_cmd git
  need_cmd node
  need_cmd pnpm

  prepare_install_dir

  log "installing dependencies"
  run_as_root_or_sudo pnpm -C "$INSTALL_DIR" install --frozen-lockfile

  log "building"
  run_as_root_or_sudo pnpm -C "$INSTALL_DIR" build

  log "linking clawser globally"
  run_as_root_or_sudo pnpm -C "$INSTALL_DIR" link --global

  log "verifying installation"
  if ! command -v clawser >/dev/null 2>&1; then
    die "clawser is not on PATH after pnpm link --global; run pnpm setup, reopen shell, then rerun this script"
  fi
  clawser --help >/dev/null

  log "done"
  log "install dir: $INSTALL_DIR"
  log "binary: $(command -v clawser)"
}

main "$@"
