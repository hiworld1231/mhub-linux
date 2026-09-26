#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${MHUB_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/mhub-linux}"
PREFIX="${MHUB_PREFIX:-$APP_ROOT/prefix}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/mhub-linux"
BIN_PATH="$HOME/.local/bin/mhub-linux"
DESKTOP_PATH="${XDG_DATA_HOME:-$HOME/.local/share}/applications/mhub-linux.desktop"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/mhub-linux"
YES=0

if [[ "${1:-}" == "--yes" ]]; then
  YES=1
elif [[ -n "${1:-}" ]]; then
  printf 'Usage: bash uninstall.sh [--yes]\n' >&2
  exit 2
fi

printf 'This will remove:\n'
printf '  %s\n' "$APP_ROOT" "$STATE_DIR" "$CACHE_DIR" "$BIN_PATH" "$DESKTOP_PATH"

if [[ "$YES" -eq 0 ]]; then
  read -r -p 'Continue? [y/N] ' answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) exit 0 ;;
  esac
fi

if [[ -f "$STATE_DIR/bridge.pid" ]]; then
  pid="$(cat "$STATE_DIR/bridge.pid" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
fi

if command -v wineserver >/dev/null 2>&1 && [[ -d "$PREFIX" ]]; then
  WINEPREFIX="$PREFIX" wineserver -k 2>/dev/null || true
fi

rm -rf "$APP_ROOT" "$STATE_DIR" "$CACHE_DIR"
rm -f "$BIN_PATH" "$DESKTOP_PATH"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$(dirname "$DESKTOP_PATH")" >/dev/null 2>&1 || true
fi

printf 'mhub-linux removed. System packages installed by install.sh were left untouched.\n'
