import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type { AudioDeviceOption, DockPosition, HudPayload, SoundSlot } from '../shared/types';

export type HudActionType =
  | 'click-toggle'
  | 'cancel'
  | 'stop'
  | 'open-hub'
  | 'open-shortcuts'
  | 'paste-last'
  | 'set-dock'
  | 'toggle-hide'
  | 'set-mic'
  | 'set-language';

export interface HudActionPayload {
  type: HudActionType;
  value?: DockPosition | string | boolean;
}

export interface HudAudioSubmitPayload {
  sessionId: string;
  wavBuffer: Uint8Array;
  durationMs: number;
  speechDurationMs: number;
  peakLevel: number;
  deviceLabel?: string;
  error?: string;
}

export interface RecordCommandPayload {
  action: 'start' | 'stop' | 'cancel';
  sessionId: string;
  deviceId?: string;
  whisperMode?: boolean;
}

export interface HudPlaySoundPayload {
  slot: SoundSlot;
  dataUrl: string;
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => {
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export const wisperHudApi = {
  getState: (): Promise<HudPayload> => ipcRenderer.invoke(IPC.HUD_GET_STATE),
  sendAction: (action: HudActionPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.HUD_ACTION, action),
  submitAudio: (payload: HudAudioSubmitPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.HUD_AUDIO_SUBMIT, payload),
  mouseEnter: (): Promise<void> => ipcRenderer.invoke(IPC.HUD_MOUSE_ENTER),
  mouseLeave: (): Promise<void> => ipcRenderer.invoke(IPC.HUD_MOUSE_LEAVE),
  openContextMenu: (): Promise<void> => ipcRenderer.invoke(IPC.HUD_CONTEXT_MENU),
  setAudioDevices: (devices: AudioDeviceOption[]): Promise<void> =>
    ipcRenderer.invoke(IPC.AUDIO_DEVICES_SET, devices),

  onHudState: (cb: (payload: HudPayload) => void): (() => void) =>
    subscribe<HudPayload>(IPC.EVENT_HUD_STATE, cb),
  onRecordCmd: (cb: (cmd: RecordCommandPayload) => void): (() => void) =>
    subscribe<RecordCommandPayload>(IPC.EVENT_RECORD_CMD, cb),
  onPlaySound: (cb: (payload: HudPlaySoundPayload) => void): (() => void) =>
    subscribe<HudPlaySoundPayload>(IPC.EVENT_PLAY_SOUND, cb),
};

export type WisperHudApi = typeof wisperHudApi;

declare global {
  interface Window {
    wisperHud: WisperHudApi;
  }
}

contextBridge.exposeInMainWorld('wisperHud', wisperHudApi);
