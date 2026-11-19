#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== Wisper Flow Local — Omarchy / Arch Installer ==="

if command -v pacman >/dev/null 2>&1; then
  echo "[1/6] Checking system packages..."
  MISSING=()
  for pkg in wl-clipboard pipewire vulkan-icd-loader; do
    if ! pacman -Qi "$pkg" >/dev/null 2>&1; then
      MISSING+=("$pkg")
    fi
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "Installing missing packages: ${MISSING[*]}"
    sudo pacman -S --needed --noconfirm "${MISSING[@]}"
  fi
fi

echo "[2/6] Building fast Unix socket trigger (wisper-flow-ctl)..."
if command -v gcc >/dev/null 2>&1; then
  gcc -O2 -Wall -Wextra -o linux/wisper-flow-ctl linux/wisper-flow-ctl.c
  sudo install -Dm755 linux/wisper-flow-ctl /usr/local/bin/wisper-flow-ctl
else
  echo "gcc not found — installing shell/socat fallback wisper-flow-ctl"
  sudo install -Dm755 linux/wisper-flow-ctl.sh /usr/local/bin/wisper-flow-ctl
fi

echo "[3/6] Installing Node dependencies & building Electron app..."
npm install
npm run generate:assets
npm run build

echo "[4/6] Downloading Linux Vulkan runtime + Rumble-2-Flash Q8_0 GGUF..."
node scripts/download-model.mjs

echo "[5/6] Installing launcher, desktop entry, and systemd user service..."
APP_DIR="/opt/wisper-flow"
sudo mkdir -p "$APP_DIR"
sudo rsync -a --delete --exclude '.git' "$PROJECT_DIR/" "$APP_DIR/"
sudo ln -sf /usr/local/bin/wisper-flow-ctl /usr/bin/wisper-flow-ctl
sudo install -Dm755 linux/wisper-flow.sh /usr/local/bin/wisper-flow
sudo install -Dm644 linux/wisper-flow.desktop /usr/share/applications/wisper-flow.desktop
sudo sed -i 's|/usr/bin/wisper-flow|/usr/local/bin/wisper-flow|g' /usr/share/applications/wisper-flow.desktop
sudo install -Dm644 assets/icons/app.png /usr/share/icons/hicolor/256x256/apps/wisper-flow.png
mkdir -p "${HOME}/.config/systemd/user"
sed 's|/usr/bin/wisper-flow|/usr/local/bin/wisper-flow|g' linux/wisper-flow.service > "${HOME}/.config/systemd/user/wisper-flow.service"
systemctl --user daemon-reload || true

echo "[6/6] Configuring Omarchy / Hyprland bindings, HUD rules, and theme hook..."
/usr/local/bin/wisper-flow --setup-omarchy || true
systemctl --user enable --now wisper-flow.service || true

echo ""
echo "Done! Wisper Flow Local is installed and configured for Omarchy."
echo "Hold Right Alt for Push-to-Talk, or tap Alt+Space for Hands-Free."
