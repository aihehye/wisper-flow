import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  OmarchyEnvironment,
  OmarchyPalette,
  PlatformKind,
  ShortcutsConfig,
} from '../../shared/types';

const execFileAsync = promisify(execFile);

const HASH_START = '# >>> wisper-flow-start';
const HASH_END = '# <<< wisper-flow-end';
const LUA_START = '-- >>> wisper-flow-start';
const LUA_END = '-- <<< wisper-flow-end';

const RELOAD_THEME_CMD = 'wisper-flow-ctl reload-theme >/dev/null 2>&1 || true';

const DEFAULT_LINUX_SHORTCUTS: ShortcutsConfig = {
  pushToTalk: 'RightAlt',
  handsFree: 'Alt+Space',
  cancel: 'Esc',
  pasteLast: 'Alt+Shift+Z',
  copyLast: 'Alt+Shift+X',
};

function stripTomlValue(rawValue: string): string {
  const trimmed = rawValue.trimStart();
  if (!trimmed) return '';

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let endIdx = -1;
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (trimmed[i] === quote) {
        endIdx = i;
        break;
      }
    }
    if (endIdx !== -1) {
      return trimmed.slice(1, endIdx).trim();
    }
    return trimmed.slice(1).trim();
  }

  const commentIdx = trimmed.startsWith('#')
    ? trimmed.search(/\s+#/)
    : trimmed.indexOf('#');
  const bare = commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed;
  return bare.trim();
}

export function parseColorsToml(tomlText: string, sourcePath: string): OmarchyPalette {
  const palette: OmarchyPalette = {
    colors: {},
    sourcePath,
  };

  const lines = tomlText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) {
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const val = stripTomlValue(line.slice(eqIdx + 1));
    if (!key || !val) continue;

    if (key === 'mode') {
      const lowered = val.toLowerCase();
      if (lowered === 'dark' || lowered === 'light') {
        palette.mode = lowered;
      }
      continue;
    }

    if (key === 'background') {
      palette.background = val;
    } else if (key === 'foreground') {
      palette.foreground = val;
    } else if (key === 'accent') {
      palette.accent = val;
    }

    palette.colors[key] = val;
  }

  return palette;
}

interface ParsedHyprShortcut {
  mods: string[];
  key: string;
}

function mapSingleKeyToHypr(token: string): string {
  const lower = token.trim().toLowerCase();
  switch (lower) {
    case 'rightalt':
    case 'ralt':
    case 'alt_r':
      return 'Alt_R';
    case 'leftalt':
    case 'lalt':
    case 'alt_l':
      return 'Alt_L';
    case 'rightctrl':
    case 'rctrl':
    case 'control_r':
      return 'Control_R';
    case 'leftctrl':
    case 'lctrl':
    case 'control_l':
      return 'Control_L';
    case 'rightshift':
    case 'rshift':
    case 'shift_r':
      return 'Shift_R';
    case 'leftshift':
    case 'lshift':
    case 'shift_l':
      return 'Shift_L';
    case 'capslock':
    case 'caps':
    case 'caps_lock':
      return 'Caps_Lock';
    case 'space':
      return 'SPACE';
    case 'esc':
    case 'escape':
      return 'Escape';
    case 'tab':
      return 'Tab';
    case 'insert':
      return 'Insert';
    case 'pause':
      return 'Pause';
    case 'scrolllock':
      return 'Scroll_Lock';
    default:
      if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(lower)) {
        return lower.toUpperCase();
      }
      if (lower.length === 1) {
        return lower.toUpperCase();
      }
      return token.trim();
  }
}

function parseShortcutForHypr(raw: string, fallback: string): ParsedHyprShortcut {
  const source = (raw || fallback).trim() || fallback;
  const parts = source
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 1) {
    return { mods: [], key: mapSingleKeyToHypr(parts[0]) };
  }

  const mods: string[] = [];
  let key = '';
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    const lower = token.toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast) {
      if (lower === 'ctrl' || lower === 'control' || lower === 'lctrl' || lower === 'rctrl') {
        mods.push('CTRL');
      } else if (lower === 'alt' || lower === 'lalt' || lower === 'ralt') {
        mods.push('ALT');
      } else if (lower === 'shift' || lower === 'lshift' || lower === 'rshift') {
        mods.push('SHIFT');
      } else if (lower === 'win' || lower === 'super' || lower === 'meta') {
        mods.push('SUPER');
      } else {
        mods.push(token.toUpperCase());
      }
    } else {
      key = mapSingleKeyToHypr(token);
    }
  }

  return { mods, key: key || 'SPACE' };
}

function formatLuaCombo(parsed: ParsedHyprShortcut): string {
  if (parsed.mods.length === 0) return parsed.key;
  return `${parsed.mods.join(' + ')} + ${parsed.key}`;
}

function formatHlBindKey(parsed: ParsedHyprShortcut): string {
  if (parsed.mods.length === 0) return parsed.key;
  return `${parsed.mods.join(' ')}, ${parsed.key}`;
}

function formatConfBindPrefix(parsed: ParsedHyprShortcut): string {
  return `${parsed.mods.join(' ')}, ${parsed.key}`;
}

export function generateOmarchyLuaBindings(shortcuts?: Partial<ShortcutsConfig>): string {
  const merged = { ...DEFAULT_LINUX_SHORTCUTS, ...shortcuts };
  const ptt = parseShortcutForHypr(merged.pushToTalk, DEFAULT_LINUX_SHORTCUTS.pushToTalk);
  const handsFree = parseShortcutForHypr(merged.handsFree, DEFAULT_LINUX_SHORTCUTS.handsFree);
  const pasteLast = parseShortcutForHypr(merged.pasteLast, DEFAULT_LINUX_SHORTCUTS.pasteLast);
  const copyLast = parseShortcutForHypr(merged.copyLast, DEFAULT_LINUX_SHORTCUTS.copyLast);

  const pttKey = formatHlBindKey(ptt);

  return [
    `-- Push-to-talk (hold ${pttKey} to dictate, release to paste)`,
    `hl.bind("${pttKey}", hl.dsp.exec_cmd("wisper-flow-ctl ptt-start"))`,
    `hl.bind("${pttKey}", hl.dsp.exec_cmd("wisper-flow-ctl ptt-stop"), { release = true })`,
    '',
    '-- Hands-free toggle & clipboard shortcuts',
    `o.bind("${formatLuaCombo(handsFree)}", "Toggle dictation", "wisper-flow-ctl toggle")`,
    `o.bind("${formatLuaCombo(pasteLast)}", "Paste last dictation", "wisper-flow-ctl paste-last")`,
    `o.bind("${formatLuaCombo(copyLast)}", "Copy last dictation", "wisper-flow-ctl copy-last")`,
  ].join('\n');
}

export function generateOmarchyLuaWindowRule(): string {
  return [
    '-- Wisper Flow floating HUD pill (stays clickable, never steals focus)',
    'o.window({ class = "wisper-flow", title = "Wisper Flow HUD" }, { float = true, pin = true, no_initial_focus = true, no_shadow = true, no_blur = true, border_size = 0, move = { "(monitor_w-window_w)/2", "monitor_h-window_h-48" } })',
  ].join('\n');
}

export function generateOmarchyConfBindings(shortcuts?: Partial<ShortcutsConfig>): string {
  const merged = { ...DEFAULT_LINUX_SHORTCUTS, ...shortcuts };
  const ptt = parseShortcutForHypr(merged.pushToTalk, DEFAULT_LINUX_SHORTCUTS.pushToTalk);
  const handsFree = parseShortcutForHypr(merged.handsFree, DEFAULT_LINUX_SHORTCUTS.handsFree);
  const pasteLast = parseShortcutForHypr(merged.pasteLast, DEFAULT_LINUX_SHORTCUTS.pasteLast);
  const copyLast = parseShortcutForHypr(merged.copyLast, DEFAULT_LINUX_SHORTCUTS.copyLast);

  const pttPrefix = formatConfBindPrefix(ptt);

  return [
    '# Push-to-talk & hands-free dictation',
    `bind = ${pttPrefix}, exec, wisper-flow-ctl ptt-start`,
    `bindr = ${pttPrefix}, exec, wisper-flow-ctl ptt-stop`,
    `bindd = ${formatConfBindPrefix(handsFree)}, Toggle dictation, exec, wisper-flow-ctl toggle`,
    `bindd = ${formatConfBindPrefix(pasteLast)}, Paste last dictation, exec, wisper-flow-ctl paste-last`,
    `bindd = ${formatConfBindPrefix(copyLast)}, Copy last dictation, exec, wisper-flow-ctl copy-last`,
  ].join('\n');
}

export function generateOmarchyConfWindowRule(): string {
  return [
    '# Wisper Flow HUD window rule (Hyprland 0.53+ block syntax)',
    'windowrule {',
    '  name = wisper-flow-hud',
    '  match:class = ^(wisper-flow)$',
    '  match:title = ^(Wisper Flow HUD)$',
    '  float = on',
    '  pin = on',
    '  no_initial_focus = on',
    '  no_shadow = on',
    '  no_blur = on',
    '  border_size = 0',
    '  move = (monitor_w-window_w)/2 monitor_h-window_h-48',
    '}',
  ].join('\n');
}

export function generateOmarchyConfSnippet(shortcuts?: Partial<ShortcutsConfig>): string {
  return `${generateOmarchyConfBindings(shortcuts)}\n\n${generateOmarchyConfWindowRule()}`;
}

export function generateOmarchySnippets(shortcuts?: Partial<ShortcutsConfig>): {
  luaBindings: string;
  luaWindowRule: string;
  luaSnippet: string;
  confSnippet: string;
} {
  const luaBindings = generateOmarchyLuaBindings(shortcuts);
  const luaWindowRule = generateOmarchyLuaWindowRule();
  const luaSnippet = `${luaBindings}\n\n${luaWindowRule}`;
  const confSnippet = generateOmarchyConfSnippet(shortcuts);
  return { luaBindings, luaWindowRule, luaSnippet, confSnippet };
}

function detectFenceStyle(existingContent: string, snippet: string, explicit?: 'hash' | 'lua'): 'hash' | 'lua' {
  if (explicit) return explicit;
  if (existingContent.includes(LUA_START)) return 'lua';
  if (existingContent.includes(HASH_START)) return 'hash';
  if (/^\s*--/m.test(snippet) || /\b(hl\.bind|o\.bind|o\.window)\b/.test(snippet)) {
    return 'lua';
  }
  return 'hash';
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function upsertFencedBlock(
  existingContent: string,
  snippet: string,
  style?: 'hash' | 'lua'
): string {
  const resolvedStyle = detectFenceStyle(existingContent, snippet, style);
  const startMarker = resolvedStyle === 'lua' ? LUA_START : HASH_START;
  const endMarker = resolvedStyle === 'lua' ? LUA_END : HASH_END;
  const block = `${startMarker}\n${snippet.trim()}\n${endMarker}`;

  const pattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
    'm'
  );

  if (pattern.test(existingContent)) {
    const replaced = existingContent.replace(pattern, () => block);
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
  }

  const trimmedExisting = existingContent.replace(/\s+$/, '');
  if (!trimmedExisting) {
    return `${block}\n`;
  }
  return `${trimmedExisting}\n\n${block}\n`;
}

export function removeFencedBlock(existingContent: string): string {
  let updated = existingContent;
  for (const [startMarker, endMarker] of [
    [LUA_START, LUA_END],
    [HASH_START, HASH_END],
  ] as const) {
    const pattern = new RegExp(
      `\\r?\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\r?\\n?`,
      'g'
    );
    updated = updated.replace(pattern, '\n');
  }

  updated = updated.replace(/\n{3,}/g, '\n\n').trim();
  return updated ? `${updated}\n` : '';
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hasFencedBlock(filePath: string): boolean {
  const content = readTextSafe(filePath);
  if (!content) return false;
  return (
    (content.includes(LUA_START) && content.includes(LUA_END)) ||
    (content.includes(HASH_START) && content.includes(HASH_END))
  );
}

function hasWindowRuleInFence(filePath: string): boolean {
  const content = readTextSafe(filePath);
  if (!content) return false;
  if (!hasFencedBlock(filePath)) return false;
  return content.includes('Wisper Flow HUD') || content.includes('wisper-flow-hud');
}

export function resolveOmarchyThemeTomlPath(homeDir?: string): string | null {
  const home = homeDir || os.homedir();
  const candidates = [
    path.join(home, '.config', 'omarchy', 'current', 'theme', 'colors.toml'),
    path.join(home, '.local', 'state', 'omarchy', 'current', 'theme', 'colors.toml'),
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function readOmarchyPalette(homeDir?: string): OmarchyPalette | null {
  const tomlPath = resolveOmarchyThemeTomlPath(homeDir);
  if (!tomlPath) return null;
  const text = readTextSafe(tomlPath);
  if (!text) return null;
  return parseColorsToml(text, tomlPath);
}

async function hasTool(name: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  try {
    await execFileAsync('which', [name], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

export async function detectOmarchyEnvironment(homeDir?: string): Promise<OmarchyEnvironment> {
  const home = homeDir || os.homedir();
  const platform = process.platform as PlatformKind;
  const isLinux = platform === 'linux';
  const isWayland =
    Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
  const isHyprland = Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);

  const hyprDir = path.join(home, '.config', 'hypr');
  const omarchyConfigDir = path.join(home, '.config', 'omarchy');
  const omarchyStateDir = path.join(home, '.local', 'state', 'omarchy');
  const omarchyShareDir = path.join(home, '.local', 'share', 'omarchy');

  const hyprlandLua = path.join(hyprDir, 'hyprland.lua');
  const bindingsLua = path.join(hyprDir, 'bindings.lua');
  const autostartLua = path.join(hyprDir, 'autostart.lua');

  const hyprlandConf = path.join(hyprDir, 'hyprland.conf');
  const bindingsConf = path.join(hyprDir, 'bindings.conf');
  const looknfeelConf = path.join(hyprDir, 'looknfeel.conf');
  const autostartConf = path.join(hyprDir, 'autostart.conf');

  const omarchyDirExists =
    fileExists(omarchyConfigDir) || fileExists(omarchyStateDir) || fileExists(omarchyShareDir);

  let omarchyVersion: OmarchyEnvironment['omarchyVersion'] = 'none';
  if (fileExists(hyprlandLua) || fileExists(bindingsLua)) {
    omarchyVersion = 'v4-lua';
  } else if (
    fileExists(bindingsConf) ||
    fileExists(looknfeelConf) ||
    (omarchyDirExists && fileExists(hyprlandConf))
  ) {
    omarchyVersion = 'v3-conf';
  } else if (fileExists(hyprlandConf)) {
    omarchyVersion = 'hyprland-conf';
  }

  let bindingsFile = hyprlandConf;
  let windowRulesFile = hyprlandConf;
  let autostartFile = hyprlandConf;

  if (omarchyVersion === 'v4-lua') {
    bindingsFile = bindingsLua;
    windowRulesFile = hyprlandLua;
    autostartFile = autostartLua;
  } else if (omarchyVersion === 'v3-conf') {
    bindingsFile = bindingsConf;
    windowRulesFile = fileExists(looknfeelConf) ? looknfeelConf : hyprlandConf;
    autostartFile = autostartConf;
  }

  const themeHookPath = path.join(omarchyConfigDir, 'hooks', 'theme-set');
  const themeHookContent = readTextSafe(themeHookPath);
  const themeHookInstalled = themeHookContent.includes('wisper-flow-ctl reload-theme');

  const bindingsInstalled = hasFencedBlock(bindingsFile);
  const windowRulesInstalled = hasWindowRuleInFence(windowRulesFile);
  const palette = readOmarchyPalette(home);

  const [hyprctl, wlCopy, wtype, ydotool, xdotool, xclip, pactl, pwRecord] = await Promise.all([
    hasTool('hyprctl'),
    hasTool('wl-copy'),
    hasTool('wtype'),
    hasTool('ydotool'),
    hasTool('xdotool'),
    hasTool('xclip'),
    hasTool('pactl'),
    hasTool('pw-record'),
  ]);

  const snippets = generateOmarchySnippets();

  return {
    platform,
    isLinux,
    isWayland,
    isHyprland,
    isOmarchy: omarchyVersion === 'v4-lua' || omarchyVersion === 'v3-conf' || omarchyDirExists,
    omarchyVersion,
    hyprDir,
    bindingsFile,
    windowRulesFile,
    autostartFile,
    themeHookInstalled,
    bindingsInstalled,
    windowRulesInstalled,
    palette,
    availableTools: {
      hyprctl,
      wlCopy,
      wtype,
      ydotool,
      xdotool,
      xclip,
      pactl,
      pwRecord,
    },
    generatedLuaSnippet: snippets.luaSnippet,
    generatedConfSnippet: snippets.confSnippet,
  };
}

function upsertFileBlock(filePath: string, snippet: string, style: 'hash' | 'lua'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = readTextSafe(filePath);
  const next = upsertFencedBlock(existing, snippet, style);
  fs.writeFileSync(filePath, next, 'utf8');
}

function removeFileBlock(filePath: string): void {
  if (!fileExists(filePath)) return;
  const existing = readTextSafe(filePath);
  if (!existing) return;
  const next = removeFencedBlock(existing);
  if (next !== existing) {
    fs.writeFileSync(filePath, next, 'utf8');
  }
}

async function tryReloadHyprland(): Promise<void> {
  if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    return;
  }
  try {
    await execFileAsync('hyprctl', ['reload'], { timeout: 3000 });
  } catch {
    // Ignore reload errors if Hyprland socket is unavailable
  }
}

export async function applyOmarchySetup(
  homeDir?: string,
  shortcuts?: Partial<ShortcutsConfig>
): Promise<OmarchyEnvironment> {
  const home = homeDir || os.homedir();
  const env = await detectOmarchyEnvironment(home);

  if (env.omarchyVersion === 'v4-lua') {
    upsertFileBlock(env.bindingsFile, generateOmarchyLuaBindings(shortcuts), 'lua');
    upsertFileBlock(env.windowRulesFile, generateOmarchyLuaWindowRule(), 'lua');
  } else if (env.omarchyVersion === 'v3-conf' && env.bindingsFile !== env.windowRulesFile) {
    upsertFileBlock(env.bindingsFile, generateOmarchyConfBindings(shortcuts), 'hash');
    upsertFileBlock(env.windowRulesFile, generateOmarchyConfWindowRule(), 'hash');
  } else {
    upsertFileBlock(env.bindingsFile, generateOmarchyConfSnippet(shortcuts), 'hash');
  }

  const hooksDir = path.join(home, '.config', 'omarchy', 'hooks');
  const hookPath = path.join(hooksDir, 'theme-set');
  fs.mkdirSync(hooksDir, { recursive: true });

  const existingHook = readTextSafe(hookPath);
  if (!existingHook) {
    fs.writeFileSync(hookPath, `#!/usr/bin/env bash\n${RELOAD_THEME_CMD}\n`, 'utf8');
  } else if (!existingHook.includes('wisper-flow-ctl reload-theme')) {
    const trimmed = existingHook.replace(/\s+$/, '');
    fs.writeFileSync(hookPath, `${trimmed}\n${RELOAD_THEME_CMD}\n`, 'utf8');
  }

  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // Ignore chmod failures on non-POSIX filesystems
  }

  await tryReloadHyprland();
  return detectOmarchyEnvironment(home);
}

export async function removeOmarchySetup(homeDir?: string): Promise<OmarchyEnvironment> {
  const home = homeDir || os.homedir();
  const env = await detectOmarchyEnvironment(home);

  const candidateFiles = new Set([
    env.bindingsFile,
    env.windowRulesFile,
    path.join(env.hyprDir, 'hyprland.lua'),
    path.join(env.hyprDir, 'bindings.lua'),
    path.join(env.hyprDir, 'hyprland.conf'),
    path.join(env.hyprDir, 'bindings.conf'),
    path.join(env.hyprDir, 'looknfeel.conf'),
  ]);

  for (const file of candidateFiles) {
    removeFileBlock(file);
  }

  const hookPath = path.join(home, '.config', 'omarchy', 'hooks', 'theme-set');
  if (fileExists(hookPath)) {
    const existingHook = readTextSafe(hookPath);
    if (existingHook.includes('wisper-flow-ctl reload-theme')) {
      const cleanedLines = existingHook
        .split(/\r?\n/)
        .filter((line) => !line.includes('wisper-flow-ctl reload-theme'));
      const joined = cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      fs.writeFileSync(hookPath, joined ? `${joined}\n` : '', 'utf8');
    }
  }

  await tryReloadHyprland();
  return detectOmarchyEnvironment(home);
}

export function watchOmarchyTheme(
  onChange: (palette: OmarchyPalette | null) => void,
  homeDir?: string
): () => void {
  if (process.platform !== 'linux') {
    return () => {};
  }

  const home = homeDir || os.homedir();
  const watchTargets = [
    path.join(home, '.config', 'omarchy', 'current', 'theme'),
    path.join(home, '.config', 'omarchy', 'current'),
    path.join(home, '.local', 'state', 'omarchy', 'current', 'theme'),
    path.join(home, '.local', 'state', 'omarchy', 'current'),
  ];

  const watchers: fs.FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSerialized = JSON.stringify(readOmarchyPalette(home));

  const scheduleNotify = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const nextPalette = readOmarchyPalette(home);
      const serialized = JSON.stringify(nextPalette);
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        onChange(nextPalette);
      }
    }, 100);
  };

  for (const target of watchTargets) {
    if (!fileExists(target)) continue;
    try {
      const watcher = fs.watch(target, () => scheduleNotify());
      watcher.on('error', () => {
        // Ignore watch errors if theme directory is swapped
      });
      watchers.push(watcher);
    } catch {
      // Ignore unavailable watch targets
    }
  }

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors
      }
    }
  };
}
