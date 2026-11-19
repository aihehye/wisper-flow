import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  applyOmarchySetup,
  detectOmarchyEnvironment,
  generateOmarchyConfSnippet,
  generateOmarchyLuaBindings,
  generateOmarchyLuaWindowRule,
  generateOmarchySnippets,
  parseColorsToml,
  removeFencedBlock,
  removeOmarchySetup,
  upsertFencedBlock,
} = require('../src/main/platform/omarchy.ts') as typeof import('../src/main/platform/omarchy');

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wisper-flow-omarchy-'));
}

describe('parseColorsToml', () => {
  it('parses background, foreground, accent, mode, and color0..color15 while ignoring comments and quotes', () => {
    const sample = `
# Tokyo Night theme
[colors]
accent = "#7aa2f7" # primary accent
background = '#1a1b26'
foreground = "#c0caf5"
mode = "dark"
color0 = "#15161e"
color1 = "#f7768e"
color2 = "#9ece6a"
color3 = "#e0af68"
color4 = "#7aa2f7"
color5 = "#bb9af7"
color6 = "#7dcfff"
color7 = "#a9b1d6"
color8 = "#414868"
color9 = "#f7768e"
color10 = "#9ece6a"
color11 = "#e0af68"
color12 = "#7aa2f7"
color13 = "#bb9af7"
color14 = "#7dcfff"
color15 = "#c0caf5"
`;
    const palette = parseColorsToml(sample, '/tmp/colors.toml');
    assert.equal(palette.sourcePath, '/tmp/colors.toml');
    assert.equal(palette.background, '#1a1b26');
    assert.equal(palette.foreground, '#c0caf5');
    assert.equal(palette.accent, '#7aa2f7');
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.colors.color0, '#15161e');
    assert.equal(palette.colors.color8, '#414868');
    assert.equal(palette.colors.color15, '#c0caf5');
    assert.equal(palette.colors.mode, undefined);
  });

  it('handles light mode and bare values', () => {
    const sample = `
mode = light # trailing comment
background = #fafafa
foreground = #1e1e2e
accent = #1e66f5
`;
    const palette = parseColorsToml(sample, '/tmp/light.toml');
    assert.equal(palette.mode, 'light');
    assert.equal(palette.background, '#fafafa');
    assert.equal(palette.foreground, '#1e1e2e');
    assert.equal(palette.accent, '#1e66f5');
  });
});

describe('snippet generators', () => {
  it('generates Omarchy v4 Lua bindings with Alt_R and o.bind', () => {
    const lua = generateOmarchyLuaBindings();
    assert.match(lua, /hl\.bind\("Alt_R", hl\.dsp\.exec_cmd\("wisper-flow-ctl ptt-start"\)\)/);
    assert.match(
      lua,
      /hl\.bind\("Alt_R", hl\.dsp\.exec_cmd\("wisper-flow-ctl ptt-stop"\), \{ release = true \}\)/
    );
    assert.match(lua, /o\.bind\("ALT \+ SPACE", "Toggle dictation", "wisper-flow-ctl toggle"\)/);
  });

  it('generates Omarchy v4 Lua window rule with no_initial_focus and without no_focus', () => {
    const rule = generateOmarchyLuaWindowRule();
    assert.match(rule, /o\.window\(/);
    assert.match(rule, /class = "wisper-flow"/);
    assert.match(rule, /title = "Wisper Flow HUD"/);
    assert.match(rule, /float = true/);
    assert.match(rule, /pin = true/);
    assert.match(rule, /no_initial_focus = true/);
    assert.equal(/\bno_focus\b/.test(rule), false);
  });

  it('generates modern Hyprland v0.53+/Omarchy v3 conf snippet without deprecated windowrulev2', () => {
    const conf = generateOmarchyConfSnippet();
    assert.match(conf, /bind = , Alt_R, exec, wisper-flow-ctl ptt-start/);
    assert.match(conf, /bindr = , Alt_R, exec, wisper-flow-ctl ptt-stop/);
    assert.match(conf, /bindd = ALT, SPACE, Toggle dictation, exec, wisper-flow-ctl toggle/);
    assert.match(conf, /windowrule \{/);
    assert.match(conf, /name = wisper-flow-hud/);
    assert.match(conf, /no_initial_focus = on/);
    assert.equal(conf.toLowerCase().includes('windowrulev2'), false);
  });

  it('generateOmarchySnippets returns matching lua and conf snippets', () => {
    const snippets = generateOmarchySnippets();
    assert.ok(snippets.luaSnippet.includes('hl.bind'));
    assert.ok(snippets.luaSnippet.includes('o.window'));
    assert.ok(snippets.confSnippet.includes('windowrule {'));
  });
});

describe('fenced block helpers', () => {
  it('upserts idempotently and removes hash-fenced blocks preserving user lines', () => {
    const original = '# User bindings\nbind = SUPER, Q, killactive\n';
    const snippet = 'bind = , Alt_R, exec, wisper-flow-ctl ptt-start';

    const once = upsertFencedBlock(original, snippet);
    assert.ok(once.includes('# >>> wisper-flow-start'));
    assert.ok(once.includes('# <<< wisper-flow-end'));
    assert.ok(once.includes('bind = SUPER, Q, killactive'));

    const twice = upsertFencedBlock(once, snippet);
    assert.equal(twice, once);

    const updated = upsertFencedBlock(twice, 'bind = , F9, exec, wisper-flow-ctl ptt-start');
    assert.ok(updated.includes('bind = , F9, exec, wisper-flow-ctl ptt-start'));
    assert.equal(updated.includes('Alt_R'), false);

    const removed = removeFencedBlock(updated);
    assert.equal(removed, original);
  });

  it('uses Lua comment fences for Lua snippets and removes them cleanly', () => {
    const original = '-- User lua config\no.bind("SUPER + Q", "Close", "close")\n';
    const luaSnippet = generateOmarchyLuaWindowRule();

    const once = upsertFencedBlock(original, luaSnippet);
    assert.ok(once.includes('-- >>> wisper-flow-start'));
    assert.ok(once.includes('-- <<< wisper-flow-end'));

    const twice = upsertFencedBlock(once, luaSnippet);
    assert.equal(twice, once);

    const removed = removeFencedBlock(twice);
    assert.equal(removed, original);
  });
});

describe('applyOmarchySetup, detectOmarchyEnvironment, removeOmarchySetup', () => {
  it('handles Omarchy v4-lua setup and removal cleanly', async () => {
    const tempHome = makeTempHome();
    try {
      const hyprDir = path.join(tempHome, '.config', 'hypr');
      const themeDir = path.join(tempHome, '.config', 'omarchy', 'current', 'theme');
      const hooksDir = path.join(tempHome, '.config', 'omarchy', 'hooks');
      fs.mkdirSync(hyprDir, { recursive: true });
      fs.mkdirSync(themeDir, { recursive: true });
      fs.mkdirSync(hooksDir, { recursive: true });

      const userBindings = '-- Existing bindings\no.bind("SUPER + RETURN", "Terminal", "alacritty")\n';
      const userHyprland = '-- Existing hyprland.lua\no.setting("gaps_in", 4)\n';
      const userHook = '#!/usr/bin/env bash\necho "existing theme hook"\n';

      fs.writeFileSync(path.join(hyprDir, 'bindings.lua'), userBindings, 'utf8');
      fs.writeFileSync(path.join(hyprDir, 'hyprland.lua'), userHyprland, 'utf8');
      fs.writeFileSync(path.join(hooksDir, 'theme-set'), userHook, 'utf8');
      fs.writeFileSync(
        path.join(themeDir, 'colors.toml'),
        'background = "#11111b"\nforeground = "#cdd6f4"\naccent = "#89b4fa"\nmode = "dark"\n',
        'utf8'
      );

      const before = await detectOmarchyEnvironment(tempHome);
      assert.equal(before.omarchyVersion, 'v4-lua');
      assert.equal(before.isOmarchy, true);
      assert.equal(before.bindingsInstalled, false);
      assert.equal(before.windowRulesInstalled, false);
      assert.equal(before.themeHookInstalled, false);
      assert.equal(before.palette?.accent, '#89b4fa');

      const applied = await applyOmarchySetup(tempHome);
      assert.equal(applied.omarchyVersion, 'v4-lua');
      assert.equal(applied.bindingsInstalled, true);
      assert.equal(applied.windowRulesInstalled, true);
      assert.equal(applied.themeHookInstalled, true);

      const bindingsContent = fs.readFileSync(path.join(hyprDir, 'bindings.lua'), 'utf8');
      const hyprContent = fs.readFileSync(path.join(hyprDir, 'hyprland.lua'), 'utf8');
      const hookContent = fs.readFileSync(path.join(hooksDir, 'theme-set'), 'utf8');

      assert.ok(bindingsContent.includes('o.bind("SUPER + RETURN"'));
      assert.ok(bindingsContent.includes('-- >>> wisper-flow-start'));
      assert.ok(bindingsContent.includes('hl.bind("Alt_R"'));
      assert.ok(hyprContent.includes('o.setting("gaps_in", 4)'));
      assert.ok(hyprContent.includes('no_initial_focus = true'));
      assert.ok(hookContent.includes('echo "existing theme hook"'));
      assert.ok(hookContent.includes('wisper-flow-ctl reload-theme'));

      const removed = await removeOmarchySetup(tempHome);
      assert.equal(removed.bindingsInstalled, false);
      assert.equal(removed.windowRulesInstalled, false);
      assert.equal(removed.themeHookInstalled, false);

      assert.equal(fs.readFileSync(path.join(hyprDir, 'bindings.lua'), 'utf8'), userBindings);
      assert.equal(fs.readFileSync(path.join(hyprDir, 'hyprland.lua'), 'utf8'), userHyprland);
      assert.equal(fs.readFileSync(path.join(hooksDir, 'theme-set'), 'utf8'), userHook);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('handles Omarchy v3-conf setup and removal cleanly', async () => {
    const tempHome = makeTempHome();
    try {
      const hyprDir = path.join(tempHome, '.config', 'hypr');
      const stateThemeDir = path.join(tempHome, '.local', 'state', 'omarchy', 'current', 'theme');
      fs.mkdirSync(hyprDir, { recursive: true });
      fs.mkdirSync(stateThemeDir, { recursive: true });

      const userBindings = '# user v3 bindings\nbind = SUPER, Q, killactive\n';
      const userLooknfeel = '# user looknfeel\ngeneral {\n  gaps_in = 5\n}\n';
      fs.writeFileSync(path.join(hyprDir, 'hyprland.conf'), '# main conf\n', 'utf8');
      fs.writeFileSync(path.join(hyprDir, 'bindings.conf'), userBindings, 'utf8');
      fs.writeFileSync(path.join(hyprDir, 'looknfeel.conf'), userLooknfeel, 'utf8');
      fs.writeFileSync(
        path.join(stateThemeDir, 'colors.toml'),
        'background = "#eff1f5"\nforeground = "#4c4f69"\naccent = "#1e66f5"\nmode = "light"\n',
        'utf8'
      );

      const before = await detectOmarchyEnvironment(tempHome);
      assert.equal(before.omarchyVersion, 'v3-conf');
      assert.equal(before.isOmarchy, true);
      assert.equal(before.palette?.mode, 'light');

      const applied = await applyOmarchySetup(tempHome);
      assert.equal(applied.bindingsInstalled, true);
      assert.equal(applied.windowRulesInstalled, true);
      assert.equal(applied.themeHookInstalled, true);

      const bindingsContent = fs.readFileSync(path.join(hyprDir, 'bindings.conf'), 'utf8');
      const looknfeelContent = fs.readFileSync(path.join(hyprDir, 'looknfeel.conf'), 'utf8');
      assert.ok(bindingsContent.includes('bind = SUPER, Q, killactive'));
      assert.ok(bindingsContent.includes('wisper-flow-ctl ptt-start'));
      assert.ok(looknfeelContent.includes('gaps_in = 5'));
      assert.ok(looknfeelContent.includes('name = wisper-flow-hud'));
      assert.equal(looknfeelContent.includes('windowrulev2'), false);

      const removed = await removeOmarchySetup(tempHome);
      assert.equal(removed.bindingsInstalled, false);
      assert.equal(removed.windowRulesInstalled, false);
      assert.equal(removed.themeHookInstalled, false);

      assert.equal(fs.readFileSync(path.join(hyprDir, 'bindings.conf'), 'utf8'), userBindings);
      assert.equal(fs.readFileSync(path.join(hyprDir, 'looknfeel.conf'), 'utf8'), userLooknfeel);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
