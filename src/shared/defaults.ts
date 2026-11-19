import type { AppSettings, PlatformKind, SoundSlot } from './types';

export const DICTATION_DEBOUNCE_MS = 500;
export const DOUBLE_TAP_WINDOW_MS = 450;
export const MAX_RECORDING_WARN_MS = 19 * 60 * 1000;
export const MAX_RECORDING_STOP_MS = 20 * 60 * 1000;
export const RECORDING_SAMPLE_RATE = 16000;
export const BASELINE_TYPING_WPM = 40;

export const TERMINAL_PROCESS_NAMES = new Set([
  'windowsterminal.exe',
  'wt.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'conhost.exe',
  'mintty.exe',
  'alacritty.exe',
  'alacritty',
  'wezterm-gui.exe',
  'wezterm-gui',
  'org.wezfurlong.wezterm',
  'kitty.exe',
  'kitty',
  'foot',
  'ghostty',
  'com.mitchellh.ghostty',
  'hyper.exe',
  'tabby.exe',
  'konsole',
  'gnome-terminal',
  'gnome-terminal-server',
  'xfce4-terminal',
  'xterm',
  'st',
  'tilix',
  'terminator',
  'rio',
]);

export const SOUND_SLOT_FILES: Record<SoundSlot, { primary: string; alternates: string[] }> = {
  start: { primary: 'dictation-start.wav', alternates: ['v12/dictation-start.wav'] },
  stop: { primary: 'dictation-stop.wav', alternates: ['v12/dictation-stop.wav'] },
  popoLock: { primary: 'popo-lock.wav', alternates: ['v12/popo-lock.wav'] },
  paste: { primary: 'paste.wav', alternates: ['v12/paste.wav'] },
  error: { primary: 'error.wav', alternates: ['notifv1/error.wav', 'notifv2/error.wav'] },
  alert: { primary: 'alert.wav', alternates: ['notifv1/alert.wav', 'notifv2/alert.wav'] },
  success: { primary: 'success.wav', alternates: ['notifv1/success.wav', 'notifv2/success.wav'] },
  achievement: { primary: 'achievement.wav', alternates: ['notifv1/success.wav'] },
};

// All 45 languages supported by Reson8/Rumble-2-Flash (plus auto)
export const RUMBLE_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'auto', name: 'Auto-Detect (45 languages)' },
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'zh', name: 'Chinese' },
  { code: 'yue', name: 'Cantonese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'fil', name: 'Filipino' },
  { code: 'bn', name: 'Bengali' },
  { code: 'fa', name: 'Persian' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'nb', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'cs', name: 'Czech' },
  { code: 'el', name: 'Greek' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'hr', name: 'Croatian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'bs', name: 'Bosnian' },
  { code: 'sq', name: 'Albanian' },
  { code: 'mk', name: 'Macedonian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'et', name: 'Estonian' },
  { code: 'is', name: 'Icelandic' },
  { code: 'eu', name: 'Basque' },
  { code: 'ca', name: 'Catalan' },
  { code: 'mt', name: 'Maltese' },
  { code: 'af', name: 'Afrikaans' },
  { code: 'ceb', name: 'Cebuano' },
];

export function createDefaultSettings(platform: PlatformKind = process.platform as PlatformKind): AppSettings {
  const isLinux = platform === 'linux';
  return {
    shortcuts: isLinux
      ? {
          pushToTalk: 'RightAlt',
          handsFree: 'Alt+Space',
          cancel: 'Esc',
          pasteLast: 'Alt+Shift+Z',
          copyLast: 'Alt+Shift+X',
        }
      : {
          pushToTalk: 'Ctrl+Win',
          handsFree: 'Ctrl+Win+Space',
          cancel: 'Esc',
          pasteLast: 'Alt+Shift+Z',
          copyLast: 'Alt+Shift+X',
        },
    language: 'English',
    microphoneDeviceId: 'default',
    gpuDeviceId: 'auto',
    rumble: {
      digits: true,
      filler: false, // <nofiller>
      verbatim: true, // <verbatim>
    },
    useDictionaryHints: true,
    launchAtLogin: true,
    hideFlowBarWhenIdle: false,
    dockPosition: 'bottom',
    enableSounds: true,
    customSoundDir: '',
    muteAudioWhileDictating: true,
    pauseMediaWhileDictating: false,
    restoreClipboardAfterPaste: true,
    terminalPasteMode: 'ctrl-shift-v',
    linuxPasteBackend: 'auto',
    theme: isLinux ? 'omarchy' : 'dark',
    cleanup: {
      stripExtraFillers: true,
      normalizeSpacing: true,
      spokenFormatting: false,
      allLowercaseGlobal: false,
      allLowercaseApps: [],
    },
    whisperModeBoost: false,
    asrEngine: 'llama-server',
    customCrispAsrPath: '',
  };
}
