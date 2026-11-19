import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { DockPosition } from '../../shared/types';

export interface HudWindowController {
  window: BrowserWindow;
  reposition: (dockPosition: DockPosition) => void;
  setInteractive: (interactive: boolean) => void;
  setVisible: (visible: boolean, dockPosition: DockPosition) => void;
}

export function computeHudBounds(
  workArea: Electron.Rectangle,
  dockPosition: DockPosition
): Electron.Rectangle {
  if (dockPosition === 'left') {
    const width = 140;
    const height = 220;
    return {
      x: workArea.x + 6,
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }
  if (dockPosition === 'right') {
    const width = 140;
    const height = 220;
    return {
      x: workArea.x + workArea.width - width - 6,
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }
  const width = 360;
  const height = 108;
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 2),
    width,
    height,
  };
}

export function createHudWindow(opts: {
  preloadPath: string;
  rendererUrl?: string;
  rendererHtmlPath: string;
  dockPosition: DockPosition;
  initiallyHidden: boolean;
}): HudWindowController {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const initialBounds = computeHudBounds(display.workArea, opts.dockPosition);

  const isWin = process.platform === 'win32';
  const win = new BrowserWindow({
    title: 'Wisper Flow HUD',
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    ...(isWin ? { type: 'toolbar' as const } : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
    },
  });

  if (isWin) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  if (opts.rendererUrl) {
    void win.loadURL(`${opts.rendererUrl}/hud.html`);
  } else {
    void win.loadFile(opts.rendererHtmlPath);
  }

  win.once('ready-to-show', () => {
    if (!opts.initiallyHidden && !win.isDestroyed()) {
      reposition(opts.dockPosition);
      win.showInactive();
    }
  });

  function reposition(dockPosition: DockPosition): void {
    if (win.isDestroyed()) return;
    if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
      // Wayland compositors ignore setPosition; Hyprland rules own placement.
      return;
    }
    try {
      const pt = screen.getCursorScreenPoint();
      const targetDisplay = screen.getDisplayNearestPoint(pt);
      const next = computeHudBounds(targetDisplay.workArea, dockPosition);
      win.setBounds(next, false);
    } catch {
      // Ignore screen queries during shutdown
    }
  }

  function setInteractive(interactive: boolean): void {
    if (win.isDestroyed() || process.platform === 'linux') return;
    if (interactive) {
      win.setIgnoreMouseEvents(false);
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  function setVisible(visible: boolean, dockPosition: DockPosition): void {
    if (win.isDestroyed()) return;
    if (visible) {
      reposition(dockPosition);
      if (!win.isVisible()) {
        win.showInactive();
      }
      if (isWin) {
        win.setAlwaysOnTop(true, 'screen-saver');
      }
    } else if (win.isVisible()) {
      win.hide();
    }
  }

  return {
    window: win,
    reposition,
    setInteractive,
    setVisible,
  };
}
