#!/usr/bin/env bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/hiworld1231/mhub-linux/main"
OFFICIAL_PAGE="https://www.mchose.store/pages/mchose-hub"
DEFAULT_INSTALLER_URL="https://cdn.mchose.com.cn/MCHOSE_HUB_installer.zip"
INSTALLER_URL="${MHUB_INSTALLER_URL:-$DEFAULT_INSTALLER_URL}"

APP_ROOT="${MHUB_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/mhub-linux}"
PREFIX="${MHUB_PREFIX:-$APP_ROOT/prefix}"
RUNTIME="$APP_ROOT/runtime"
FONT_DIR="$APP_ROOT/fonts"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/mhub-linux"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

SKIP_PACKAGES=0
SKIP_HUB=0
REFRESH=0

for arg in "$@"; do
  case "$arg" in
    --skip-packages) SKIP_PACKAGES=1 ;;
    --skip-hub) SKIP_HUB=1 ;;
    --refresh) REFRESH=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: bash install.sh [options]

Options:
  --skip-packages  do not install system packages
  --skip-hub       do not download/reinstall MCHOSE M HUB
  --refresh        redownload runtime files, fonts and installer
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

say() {
  printf '\n==> %s\n' "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

install_packages() {
  local missing=()
  local cmd
  for cmd in wine wineserver node npm curl unzip; do
    have "$cmd" || missing+=("$cmd")
  done

  if ((${#missing[@]} == 0)); then
    return 0
  fi

  if [[ "$SKIP_PACKAGES" -eq 1 ]]; then
    printf 'Missing commands: %s\n' "${missing[*]}" >&2
    printf 'Install them manually or rerun without --skip-packages.\n' >&2
    exit 1
  fi

  local -a elevate=()
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    if have sudo; then
      elevate=(sudo)
    else
      printf 'mhub-linux: sudo is required to install missing system packages.\n' >&2
      exit 1
    fi
  fi

  say "Installing runtime packages"

  if have pacman; then
    "${elevate[@]}" pacman -S --needed --noconfirm wine nodejs npm curl unzip
  elif have apt-get; then
    "${elevate[@]}" apt-get update
    "${elevate[@]}" apt-get install -y wine64 nodejs npm curl unzip
  elif have dnf; then
    "${elevate[@]}" dnf install -y wine nodejs npm curl unzip
  else
    printf 'Unsupported package manager. Install these commands manually:\n' >&2
    printf '  wine wineserver node npm curl unzip\n' >&2
    exit 1
  fi
}

check_node() {
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [[ ! "$major" =~ ^[0-9]+$ ]] || ((major < 18)); then
    printf 'mhub-linux requires Node.js 18 or newer (found %s).\n' "$(node --version)" >&2
    exit 1
  fi
}

source_root=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  candidate_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  if [[ -f "$candidate_root/src/bridge.mjs" ]]; then
    source_root="$candidate_root"
  fi
fi

stage_file() {
  local relative="$1"
  local destination="$2"
  mkdir -p "$(dirname "$destination")"

  if [[ -n "$source_root" && -f "$source_root/$relative" ]]; then
    cp "$source_root/$relative" "$destination"
  else
    curl -fL --retry 3 "$REPO_RAW/$relative" -o "$destination"
  fi
}

download_file() {
  local url="$1"
  local destination="$2"
  local temporary="$destination.part"

  if [[ "$REFRESH" -eq 0 && -s "$destination" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$destination")"
  rm -f "$temporary"
  curl -fL --retry 3 --connect-timeout 15 "$url" -o "$temporary"
  mv "$temporary" "$destination"
}

download_fonts() {
  say "Downloading MCHOSE fonts"

  local icon_css_url="https://cdn.mchose.com.cn/customPage/iconfont/iconfont.css"
  local icon_base="https://cdn.mchose.com.cn/customPage/iconfont"
  local icon_ref="iconfont.woff2"
  local css
  local resolved=""

  if css="$(curl -fsSL --retry 3 "$icon_css_url")"; then
    resolved="$(printf '%s' "$css" | grep -oE 'iconfont\.woff2[^\")[:space:]]*' | head -n 1 || true)"
    if [[ -n "$resolved" ]]; then
      icon_ref="$resolved"
    fi
  fi

  download_file "$icon_base/$icon_ref" "$FONT_DIR/iconfont.woff2"
  download_file "https://cdn.mchose.com.cn/configCenter/pcAssets/fonts/misans/MiSans-Regular.woff2" "$FONT_DIR/MiSans-Regular.woff2"
  download_file "https://cdn.mchose.com.cn/configCenter/pcAssets/fonts/misans/MiSans-Semibold.woff2" "$FONT_DIR/MiSans-Semibold.woff2"
  download_file "https://cdn.mchose.com.cn/configCenter/pcAssets/fonts/misans/MiSans-Bold.woff2" "$FONT_DIR/MiSans-Bold.woff2"
}

find_installed_app() {
  local candidates=(
    "$PREFIX/drive_c/Program Files/MCHOSE HUB/MCHOSE HUB.exe"
    "$PREFIX/drive_c/Program Files (x86)/MCHOSE HUB/MCHOSE HUB.exe"
    "$PREFIX/drive_c/users/$USER/AppData/Local/Programs/MCHOSE HUB/MCHOSE HUB.exe"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  find "$PREFIX/drive_c" -maxdepth 7 -type f -iname 'MCHOSE HUB.exe' -print -quit 2>/dev/null
}

install_hub() {
  local existing
  existing="$(find_installed_app || true)"
  if [[ "$SKIP_HUB" -eq 1 ]]; then
    if [[ -z "$existing" ]]; then
      printf '%s\n' "--skip-hub was requested, but MCHOSE HUB.exe is not installed in $PREFIX" >&2
      exit 1
    fi
    return 0
  fi

  if [[ -n "$existing" && "$REFRESH" -eq 0 ]]; then
    say "MCHOSE M HUB is already installed"
    printf '%s\n' "$existing"
    return 0
  fi

  say "Downloading MCHOSE M HUB from the official CDN"
  printf 'Official page: %s\n' "$OFFICIAL_PAGE"
  printf 'Download URL:  %s\n' "$INSTALLER_URL"

  local zip_file="$CACHE_DIR/MCHOSE_HUB_installer.zip"
  download_file "$INSTALLER_URL" "$zip_file"

  local unpack_dir="$CACHE_DIR/installer"
  rm -rf "$unpack_dir"
  mkdir -p "$unpack_dir"
  unzip -q "$zip_file" -d "$unpack_dir"

  local installer
  installer="$(find "$unpack_dir" -type f \( -iname 'MCHOSE HUB installer.exe' -o -iname '*MCHOSE*HUB*installer*.exe' \) -print -quit)"
  if [[ -z "$installer" ]]; then
    printf 'Could not find the M HUB installer EXE inside %s\n' "$zip_file" >&2
    find "$unpack_dir" -maxdepth 2 -type f -print >&2
    exit 1
  fi

  say "Preparing Wine prefix"
  mkdir -p "$PREFIX"
  WINEARCH=win64 WINEPREFIX="$PREFIX" WINEDEBUG=-all wineboot -u >/dev/null 2>&1 || true

  say "Installing MCHOSE M HUB"
  WINEPREFIX="$PREFIX" WINEDEBUG=-all wine "$installer" /S
  WINEPREFIX="$PREFIX" wineserver -w 2>/dev/null || true

  local installed
  installed="$(find_installed_app || true)"
  if [[ -z "$installed" ]]; then
    printf 'The installer finished, but MCHOSE HUB.exe was not found in the Wine prefix.\n' >&2
    printf 'Run the installer manually in the same prefix for Wine diagnostics if needed.\n' >&2
    exit 1
  fi

  printf 'Installed: %s\n' "$installed"
}

install_packages
check_node

say "Installing mhub-linux runtime"
mkdir -p "$RUNTIME/src" "$FONT_DIR" "$CACHE_DIR" "$BIN_DIR" "$DESKTOP_DIR"
stage_file "src/bridge.mjs" "$RUNTIME/src/bridge.mjs"
stage_file "package.json" "$RUNTIME/package.json"
stage_file "scripts/mhub-linux" "$BIN_DIR/mhub-linux"
chmod +x "$BIN_DIR/mhub-linux"

say "Installing Node runtime dependency"
npm install --prefix "$RUNTIME" --omit=dev --ignore-scripts --no-audit --no-fund

download_fonts
install_hub

say "Installing desktop entry"
cat > "$DESKTOP_DIR/mhub-linux.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MCHOSE M HUB (Wine)
Comment=MCHOSE M HUB through the mhub-linux compatibility layer
Exec=$BIN_DIR/mhub-linux
Terminal=false
Categories=Settings;Utility;
StartupNotify=true
EOF
chmod 644 "$DESKTOP_DIR/mhub-linux.desktop"

if have update-desktop-database; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

say "Installation complete"
printf 'Run: %s\n' "$BIN_DIR/mhub-linux"
printf 'Check: %s --doctor\n' "$BIN_DIR/mhub-linux"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\nNote: %s is not currently in PATH.\n' "$BIN_DIR"
    printf 'Start M HUB with the full path above, or add ~/.local/bin to PATH.\n'
    ;;
esac

cat <<'EOF'

Audio note:
  The default audio compatibility shim opens cmedia_2025 device pages by using
  M HUB's built-in fake SDK. It does NOT implement C-Media APO/DSP effects.
  Use `mhub-linux --no-audio-shim` to disable the shim.
EOF
