import { BrowserWindow } from 'electron';

export interface HubWindowOptions {
  preloadPath: string;
  rendererUrl?: string;
  rendererHtmlPath: string;
  iconPath: string;
  startHidden: boolean;
  isQuitting: () => boolean;
}

export function createHubWindow(opts: HubWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Wisper Flow Local',
    width: 1080,
    height: 740,
    minWidth: 840,
    minHeight: 580,
    show: false,
    backgroundColor: '#0a0a0a',
    icon: opts.iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (opts.rendererUrl) {
    void win.loadURL(`${opts.rendererUrl}/index.html`);
  } else {
    void win.loadFile(opts.rendererHtmlPath);
  }

  win.once('ready-to-show', () => {
    if (!opts.startHidden && !win.isDestroyed()) {
      win.show();
    }
  });

  if (!opts.startHidden) {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        win.show();
      }
    }, 1500);
  }

  win.on('close', (event) => {
    if (!opts.isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

export function showAndFocusHub(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.setSkipTaskbar(false);
  win.show();
  win.moveTop();
  win.setAlwaysOnTop(true);
  win.focus();
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(false);
    }
  }, 150);
}
