# Wisper Flow Local

100% local, zero-LLM voice-to-text dictation matching Wispr Flow's desktop UX, powered by **`Reson8/Rumble-2-Flash`** on your local GPU with native support for **Windows** and **Linux / Omarchy (Arch + Hyprland)**.

Made by **Hemanth**.

## Features

- **Local GPU Voice-to-Text (`Rumble-2-Flash` Q8_0 GGUF)** via Vulkan (`llama-server`), supporting 45 languages + auto-detect, native punctuation, casing, digit formatting (`<digits>`), filler removal (`<nofiller>`), verbatim toggle (`<verbatim>`), automatic long-recording pause splitting (`>28s`), and Dictionary context hints.
- **Exact Wispr Flow Bar HUD Pill**: non-focus-stealing, always-on-top, multi-monitor cursor-aware pill dockable to `bottom`, `left`, or `right`, with all visual states (`hidden`, `resting` 40x8px, `ready` 50x30px + hover tooltip & right-click quick menu, `active_ptt` 73x30px 10-bar live waveform, `active_popo` 102.5x30px Cancel/Stop hands-free bar, `processing` 98x30px, and `error` 91x30px + toast).
- **Global Hotkeys & Safety Guards**:
  - Windows defaults: Hold `Ctrl + Win` (or `Caps Lock` with LED suppression / `Mouse4` / `Mouse5`) for Push-to-Talk, `Ctrl + Win + Space` or double-tap PTT for Hands-Free, `Esc` to Cancel, `Alt + Shift + Z` to Paste Last, `Alt + Shift + X` to Copy Last.
  - Omarchy / Linux defaults: Hold `Right Alt` (`Alt_R`) for Push-to-Talk, tap `Alt + Space` for Hands-Free (avoiding Omarchy's reserved `Super + Space` / `Super + C/V/X` keys).
  - 500 ms accidental quick-tap debounce and silent `OtherShortcut` abort (so `Ctrl + Win + D` or virtual desktop switches never misfire).
- **Deterministic Post-Processing (Zero LLM)**:
  - Dictionary vocabulary hints & exact spoken replacements
  - Snippets (full-utterance match + inline trigger expansion)
  - Ordered Custom Regex Rules (`g`/`i`/`m`/`u`, capture groups, `\n`/`\t`) with a **Live Pipeline Tester**
  - Optional deterministic cleanup (extra filler words, whitespace/punctuation, spoken formatting like `"new line"`, per-app lowercase)
- **8 Notification Sound Cues + Custom Sound Folder**: ships with 8 synthesized WAV cues (`start`, `stop`, `popoLock`, `paste`, `error`, `alert`, `success`, `achievement`) plus a Settings folder picker supporting flat or nested `notifv1/` / `v12/` WAV packs.
- **Smart Auto-Paste & Audio Muting**: snapshots & restores your clipboard, excludes dictations from Windows `Win + V` Clipboard History, detects terminals for `Ctrl+Shift+V` / `Shift+Insert`, and mutes other active audio sessions (Spotify/YouTube/Chrome) while keeping our chimes audible.

---

## Windows Quick Start

1. Install dependencies and build:
   ```powershell
   npm install
   npm run generate:assets
   npm run build:win-helper
   npm run build
   ```
2. Download the Vulkan runtime and `Rumble-2-Flash-Q8_0` GGUF (~560 MB + 39 MB runtime):
   ```powershell
   npm run download:model
   ```
3. Run the RTX / Vulkan GPU smoke test:
   ```powershell
   npm run smoke:gpu
   ```
4. Launch the app:
   ```powershell
   npx electron .
   ```

---

## Linux & Omarchy (v3 `.conf` & v4 `.lua`) Quick Start

Omarchy uses Wayland + Hyprland + PipeWire. Wisper Flow Local integrates cleanly without root privileges or keyloggers:

- **Hold-to-Talk**: Hyprland `bind`/`bindr` invokes the tiny C socket trigger `wisper-flow-ctl` (`<2 ms`) talking to `$XDG_RUNTIME_DIR/wisper-flow.sock`.
- **Floating Pill**: Hyprland window rules enforce `float`, `pin`, `no_initial_focus`, `no_shadow`, `no_blur`, and bottom-center placement (without disabling clicks on Hands-Free buttons).
- **Auto-Paste**: Uses `wl-copy` + `hyprctl dispatch sendshortcut` (`CTRL SHIFT, v` in terminals like `foot`/`ghostty`/`alacritty`/`kitty`, `CTRL, v` in GUI apps), with `wtype` / `ydotool` / `xdotool` fallbacks.
- **Live Omarchy Theme Sync**: Watches `~/.config/omarchy/current/theme/colors.toml` (and `~/.local/state/omarchy/current/theme/colors.toml`) + installs a `theme-set` hook.

### One-Command Omarchy Install
```bash
chmod +x linux/install-omarchy.sh
./linux/install-omarchy.sh
```

Or configure Hyprland bindings & rules from the CLI at any time:
```bash
wisper-flow --setup-omarchy
```

Or build an Arch package from `linux/PKGBUILD`:
```bash
cd linux && makepkg -si
```

---

## Testing

```powershell
npm run typecheck
npm test
```
