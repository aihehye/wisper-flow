export const IPC = {
  // Hub -> Main
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_CAPTURE_SHORTCUT_START: 'settings:capture-shortcut-start',
  SETTINGS_CAPTURE_SHORTCUT_STOP: 'settings:capture-shortcut-stop',

  DICTIONARY_LIST: 'dictionary:list',
  DICTIONARY_UPSERT: 'dictionary:upsert',
  DICTIONARY_DELETE: 'dictionary:delete',
  DICTIONARY_SUGGESTIONS_LIST: 'dictionary:suggestions-list',
  DICTIONARY_SUGGESTIONS_ACCEPT: 'dictionary:suggestions-accept',
  DICTIONARY_SUGGESTIONS_DISMISS: 'dictionary:suggestions-dismiss',

  SNIPPETS_LIST: 'snippets:list',
  SNIPPETS_UPSERT: 'snippets:upsert',
  SNIPPETS_DELETE: 'snippets:delete',

  REGEX_LIST: 'regex:list',
  REGEX_UPSERT: 'regex:upsert',
  REGEX_DELETE: 'regex:delete',
  REGEX_REORDER: 'regex:reorder',
  PIPELINE_TEST: 'pipeline:test',

  HISTORY_LIST: 'history:list',
  HISTORY_DELETE: 'history:delete',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_PASTE_ENTRY: 'history:paste-entry',
  HISTORY_COPY_ENTRY: 'history:copy-entry',
  STATS_GET: 'stats:get',
  TOKEN_STATS_GET: 'stats:tokens-get',

  MODEL_STATUS: 'model:status',
  MODEL_DOWNLOAD: 'model:download',
  MODEL_RESTART: 'model:restart',
  MODEL_TEST_SMOKE: 'model:test-smoke',

  SOUNDS_LIST_STATUS: 'sounds:list-status',
  SOUNDS_BROWSE_DIR: 'sounds:browse-dir',
  SOUNDS_PLAY_PREVIEW: 'sounds:play-preview',

  OMARCHY_STATUS: 'omarchy:status',
  OMARCHY_APPLY: 'omarchy:apply',
  OMARCHY_REMOVE: 'omarchy:remove',
  OMARCHY_REFRESH: 'omarchy:refresh',

  AUDIO_DEVICES_SET: 'audio:devices-set',
  AUDIO_DEVICES_GET: 'audio:devices-get',

  // HUD <-> Main
  HUD_GET_STATE: 'hud:get-state',
  HUD_ACTION: 'hud:action', // click-toggle, cancel, stop, open-hub, open-shortcuts, paste-last, set-dock, toggle-hide, set-mic, set-language
  HUD_AUDIO_SUBMIT: 'hud:audio-submit', // Float32Array/ArrayBuffer PCM + durationMs + error
  HUD_MOUSE_ENTER: 'hud:mouse-enter',
  HUD_MOUSE_LEAVE: 'hud:mouse-leave',
  HUD_CONTEXT_MENU: 'hud:context-menu',

  // Main -> Renderers (push events)
  EVENT_HUD_STATE: 'event:hud-state',
  EVENT_RECORD_CMD: 'event:record-cmd', // { action: 'start' | 'stop' | 'cancel', sessionId, deviceId, whisperMode }
  EVENT_PLAY_SOUND: 'event:play-sound', // { slot, dataUrl }
  EVENT_SHORTCUT_CAPTURED: 'event:shortcut-captured',
  EVENT_MODEL_STATUS: 'event:model-status',
  EVENT_SETTINGS_CHANGED: 'event:settings-changed',
  EVENT_HISTORY_ADDED: 'event:history-added',
  EVENT_OMARCHY_PALETTE: 'event:omarchy-palette',
  EVENT_NAVIGATE: 'event:navigate',
  DICTIONARY_SUGGESTIONS_UPDATED: 'wisper:dictionary-suggestions-updated',
} as const;
