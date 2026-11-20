import { Menu, Tray, nativeImage } from 'electron';
import { RUMBLE_LANGUAGES } from '../shared/defaults';
import type { AppSettings, AudioDeviceOption, HistoryEntry, MicProfile } from '../shared/types';

export interface TrayCallbacks {
  onOpenHub: () => void;
  onOpenShortcuts: () => void;
  onPasteLast: () => void;
  onCopyLast: () => void;
  onSelectMic: (deviceId: string) => void;
  onSelectMicProfile: (profile: MicProfile) => void;
  onSelectLanguage: (language: string) => void;
  onToggleFlowBar: () => void;
  onQuit: () => void;
}

export class AppTrayController {
  private tray: Tray;
  private idleIcon: Electron.NativeImage;
  private activeIcon: Electron.NativeImage;
  private isListening = false;
  private settings: AppSettings;
  private devices: AudioDeviceOption[] = [{ id: 'default', label: 'System Default Microphone' }];
  private latestHistory: HistoryEntry | null = null;
  private callbacks: TrayCallbacks;

  constructor(opts: {
    idleIconPath: string;
    activeIconPath: string;
    settings: AppSettings;
    latestHistory: HistoryEntry | null;
    callbacks: TrayCallbacks;
  }) {
    this.idleIcon = nativeImage.createFromPath(opts.idleIconPath);
    this.activeIcon = nativeImage.createFromPath(opts.activeIconPath);
    this.settings = opts.settings;
    this.latestHistory = opts.latestHistory;
    this.callbacks = opts.callbacks;

    this.tray = new Tray(this.idleIcon);
    this.tray.setToolTip('Wisper Flow Local — Ready');
    this.tray.on('click', () => {
      this.callbacks.onOpenHub();
    });
    this.tray.on('double-click', () => {
      this.callbacks.onOpenHub();
    });
    this.rebuildMenu();
  }

  update(patch: {
    settings?: AppSettings;
    devices?: AudioDeviceOption[];
    latestHistory?: HistoryEntry | null;
    isListening?: boolean;
  }): void {
    if (patch.settings) this.settings = patch.settings;
    if (patch.devices) {
      this.devices =
        patch.devices.length > 0
          ? patch.devices
          : [{ id: 'default', label: 'System Default Microphone' }];
    }
    if (patch.latestHistory !== undefined) this.latestHistory = patch.latestHistory;
    if (patch.isListening !== undefined && patch.isListening !== this.isListening) {
      this.isListening = patch.isListening;
      this.tray.setImage(this.isListening ? this.activeIcon : this.idleIcon);
      this.tray.setToolTip(
        this.isListening
          ? 'Wisper Flow Local — Listening...'
          : `Wisper Flow Local — ${this.settings.shortcuts.pushToTalk}`
      );
    }
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    const lastText = this.latestHistory?.pastedText || '';
    const preview25 =
      lastText.length > 25
        ? `${lastText.slice(0, 25).replace(/\s+/g, ' ')}…`
        : lastText.replace(/\s+/g, ' ');
    const fullTooltip =
      lastText.length > 270 ? `${lastText.slice(0, 270)}…` : lastText;

    const topLanguages = ['auto', 'English', 'Hindi', 'Spanish', 'French', 'German', 'Japanese', 'Chinese'];
    const langItems: Electron.MenuItemConstructorOptions[] = [];
    const seen = new Set<string>();

    for (const langKey of topLanguages) {
      const entry = RUMBLE_LANGUAGES.find((l) => l.code === langKey || l.name === langKey);
      if (!entry) continue;
      const value = entry.code === 'auto' ? 'auto' : entry.name;
      seen.add(value);
      langItems.push({
        label: entry.name,
        type: 'radio',
        checked: this.settings.language === value || this.settings.language === entry.code,
        click: () => this.callbacks.onSelectLanguage(value),
      });
    }

    const moreLangs = RUMBLE_LANGUAGES.filter((l) => {
      const val = l.code === 'auto' ? 'auto' : l.name;
      return !seen.has(val);
    }).map<Electron.MenuItemConstructorOptions>((l) => ({
      label: l.name,
      type: 'radio',
      checked: this.settings.language === l.name || this.settings.language === l.code,
      click: () => this.callbacks.onSelectLanguage(l.name),
    }));

    const micItems: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'System Default Microphone',
        type: 'radio',
        checked: this.settings.microphoneDeviceId === 'default',
        click: () => this.callbacks.onSelectMic('default'),
      },
      ...this.devices
        .filter((d) => d.id !== 'default')
        .map<Electron.MenuItemConstructorOptions>((d) => ({
          label: d.label || d.id,
          type: 'radio',
          checked: this.settings.microphoneDeviceId === d.id,
          click: () => this.callbacks.onSelectMic(d.id),
        })),
    ];

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Open App',
        click: () => this.callbacks.onOpenHub(),
      },
      { type: 'separator' },
      {
        label: 'Paste last transcript',
        accelerator: this.settings.shortcuts.pasteLast || undefined,
        enabled: Boolean(lastText),
        toolTip: fullTooltip || undefined,
        click: () => this.callbacks.onPasteLast(),
      },
      ...(lastText
        ? [
            {
              label: `  "${preview25}"`,
              enabled: false,
              toolTip: fullTooltip,
            } as Electron.MenuItemConstructorOptions,
          ]
        : []),
      {
        label: 'Copy last transcript',
        accelerator: this.settings.shortcuts.copyLast || undefined,
        enabled: Boolean(lastText),
        click: () => this.callbacks.onCopyLast(),
      },
      { type: 'separator' },
      {
        label: 'Shortcuts...',
        click: () => this.callbacks.onOpenShortcuts(),
      },
      {
        label: 'Microphone',
        submenu: micItems,
      },
      {
        label: 'Mic Environment',
        submenu: [
          {
            label: 'Quiet Room (Whisper)',
            type: 'radio',
            checked: this.settings.micProfile === 'quiet',
            click: () => this.callbacks.onSelectMicProfile('quiet'),
          },
          {
            label: 'Outside (Noisy)',
            type: 'radio',
            checked: this.settings.micProfile === 'noisy',
            click: () => this.callbacks.onSelectMicProfile('noisy'),
          },
        ],
      },
      {
        label: 'Language',
        submenu: [
          ...langItems,
          { type: 'separator' },
          { label: 'More Languages', submenu: moreLangs },
        ],
      },
      {
        label: this.settings.hideFlowBarWhenIdle ? 'Show Flow Bar' : 'Hide Flow Bar when idle',
        type: 'checkbox',
        checked: !this.settings.hideFlowBarWhenIdle,
        click: () => this.callbacks.onToggleFlowBar(),
      },
      { type: 'separator' },
      {
        label: 'Quit Wisper Flow Local',
        click: () => this.callbacks.onQuit(),
      },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray.destroy();
  }
}
