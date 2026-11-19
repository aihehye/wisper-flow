using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WisperFlowHelper
{
    internal static class Program
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
        private static readonly object StdoutLock = new object();

        private static HelperWindow _uiWindow;
        private static IntPtr _kbHook = IntPtr.Zero;
        private static IntPtr _mouseHook = IntPtr.Zero;
        private static NativeMethods.LowLevelHookProc _kbProc;
        private static NativeMethods.LowLevelHookProc _mouseProc;

        private static readonly HashSet<int> PressedVks = new HashSet<int>();
        private static readonly HashSet<int> SwallowedTriggerVks = new HashSet<int>();
        private static readonly object ShortcutLock = new object();

        private static ParsedShortcut _ptt = ParsedShortcut.Parse("Ctrl+Win");
        private static ParsedShortcut _handsFree = ParsedShortcut.Parse("Ctrl+Win+Space");
        private static ParsedShortcut _cancel = ParsedShortcut.Parse("Esc");
        private static ParsedShortcut _pasteLast = ParsedShortcut.Parse("Alt+Shift+Z");
        private static ParsedShortcut _copyLast = ParsedShortcut.Parse("Alt+Shift+X");

        private static bool _pttActive = false;
        private static bool _pttSwallowedToHandsFree = false;
        private static bool _captureMode = false;
        private static readonly HashSet<int> CaptureSeenVks = new HashSet<int>();

        private static readonly WasapiMuter AudioMuter = new WasapiMuter();
        private static bool _wePausedMedia = false;
        private static ClipboardSnapshot _savedClipboard = null;
        private static uint _pendingRestoreSeq = 0;
        private static System.Windows.Forms.Timer _restoreTimer = null;

        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            AppDomain.CurrentDomain.ProcessExit += (s, e) => SafeCleanup();

            // Recover any sessions left muted if a prior instance was force-killed
            try { AudioMuter.RecoverFromCrashFile(); } catch { }

            _uiWindow = new HelperWindow();
            var handle = _uiWindow.Handle; // force handle creation

            InstallHooks();

            var stdinThread = new Thread(ReadStdinLoop) { IsBackground = true };
            stdinThread.Start();

            Emit(new Dictionary<string, object>
            {
                { "event", "ready" },
                { "pid", Process.GetCurrentProcess().Id },
                { "kbHook", _kbHook != IntPtr.Zero },
                { "mouseHook", _mouseHook != IntPtr.Zero }
            });

            Application.Run();
            SafeCleanup();
        }

        private static void SafeCleanup()
        {
            try { AudioMuter.UnmuteAll(); } catch { }
            try
            {
                if (_kbHook != IntPtr.Zero) { NativeMethods.UnhookWindowsHookEx(_kbHook); _kbHook = IntPtr.Zero; }
                if (_mouseHook != IntPtr.Zero) { NativeMethods.UnhookWindowsHookEx(_mouseHook); _mouseHook = IntPtr.Zero; }
            }
            catch { }
        }

        private static void Emit(object payload)
        {
            string line = Json.Serialize(payload);
            lock (StdoutLock)
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }

        private static void ReadStdinLoop()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        var cmd = Json.Deserialize<Dictionary<string, object>>(line);
                        if (cmd != null) HandleCommand(cmd);
                    }
                    catch (Exception ex)
                    {
                        Emit(new Dictionary<string, object> { { "event", "error" }, { "message", ex.Message } });
                    }
                }
            }
            catch { }
            // Stdin EOF -> clean exit and unmute
            SafeCleanup();
            try
            {
                if (_uiWindow != null && _uiWindow.Handle != IntPtr.Zero)
                {
                    _uiWindow.BeginInvoke((Action)(() => Application.ExitThread()));
                }
            }
            catch { Environment.Exit(0); }
        }

        private static void HandleCommand(Dictionary<string, object> cmd)
        {
            string name = cmd.ContainsKey("cmd") ? Convert.ToString(cmd["cmd"]) : "";
            object id = cmd.ContainsKey("id") ? cmd["id"] : null;

            switch (name)
            {
                case "ping":
                    Reply(id, new Dictionary<string, object> { { "ok", true }, { "pid", Process.GetCurrentProcess().Id } });
                    break;

                case "set-shortcuts":
                    lock (ShortcutLock)
                    {
                        if (cmd.ContainsKey("pushToTalk")) _ptt = ParsedShortcut.Parse(Convert.ToString(cmd["pushToTalk"]));
                        if (cmd.ContainsKey("handsFree")) _handsFree = ParsedShortcut.Parse(Convert.ToString(cmd["handsFree"]));
                        if (cmd.ContainsKey("cancel")) _cancel = ParsedShortcut.Parse(Convert.ToString(cmd["cancel"]));
                        if (cmd.ContainsKey("pasteLast")) _pasteLast = ParsedShortcut.Parse(Convert.ToString(cmd["pasteLast"]));
                        if (cmd.ContainsKey("copyLast")) _copyLast = ParsedShortcut.Parse(Convert.ToString(cmd["copyLast"]));
                        _pttActive = false;
                        _pttSwallowedToHandsFree = false;
                    }
                    Reply(id, new Dictionary<string, object> { { "ok", true } });
                    break;

                case "start-capture":
                    lock (ShortcutLock)
                    {
                        CaptureSeenVks.Clear();
                        _captureMode = true;
                    }
                    Reply(id, new Dictionary<string, object> { { "ok", true } });
                    break;

                case "stop-capture":
                    lock (ShortcutLock)
                    {
                        _captureMode = false;
                        CaptureSeenVks.Clear();
                    }
                    Reply(id, new Dictionary<string, object> { { "ok", true } });
                    break;

                case "get-foreground":
                    _uiWindow.BeginInvoke((Action)(() =>
                    {
                        var info = GetForegroundInfo();
                        Reply(id, info);
                    }));
                    break;

                case "paste-text":
                    string text = cmd.ContainsKey("text") ? Convert.ToString(cmd["text"]) : "";
                    bool restore = !cmd.ContainsKey("restoreClipboard") || Convert.ToBoolean(cmd["restoreClipboard"]);
                    bool isTerminal = cmd.ContainsKey("isTerminal") && Convert.ToBoolean(cmd["isTerminal"]);
                    string terminalMode = cmd.ContainsKey("terminalMode") ? Convert.ToString(cmd["terminalMode"]) : "ctrl-shift-v";
                    int restoreDelayMs = cmd.ContainsKey("restoreDelayMs") ? Convert.ToInt32(cmd["restoreDelayMs"]) : 220;

                    _uiWindow.BeginInvoke((Action)(() =>
                    {
                        try
                        {
                            DoPasteText(text, restore, isTerminal, terminalMode, restoreDelayMs);
                            Reply(id, new Dictionary<string, object> { { "ok", true } });
                        }
                        catch (Exception ex)
                        {
                            Reply(id, new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
                        }
                    }));
                    break;

                case "copy-text":
                    string copyText = cmd.ContainsKey("text") ? Convert.ToString(cmd["text"]) : "";
                    _uiWindow.BeginInvoke((Action)(() =>
                    {
                        try
                        {
                            SetClipboardTextWithExclusions(copyText);
                            Reply(id, new Dictionary<string, object> { { "ok", true } });
                        }
                        catch (Exception ex)
                        {
                            Reply(id, new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
                        }
                    }));
                    break;

                case "mute-others":
                    var exclude = new HashSet<int>();
                    exclude.Add(Process.GetCurrentProcess().Id);
                    if (cmd.ContainsKey("excludePids"))
                    {
                        var pidList = cmd["excludePids"] as System.Collections.IEnumerable;
                        if (pidList != null)
                        {
                            foreach (var p in pidList)
                            {
                                try { exclude.Add(Convert.ToInt32(p)); } catch { }
                            }
                        }
                    }
                    int count = AudioMuter.MuteOthers(exclude);
                    Reply(id, new Dictionary<string, object> { { "ok", true }, { "mutedCount", count } });
                    break;

                case "unmute-others":
                    int unmuted = AudioMuter.UnmuteAll();
                    Reply(id, new Dictionary<string, object> { { "ok", true }, { "unmutedCount", unmuted } });
                    break;

                case "pause-media":
                    var pauseExclude = new HashSet<int>();
                    pauseExclude.Add(Process.GetCurrentProcess().Id);
                    if (cmd.ContainsKey("excludePids"))
                    {
                        var pList = cmd["excludePids"] as System.Collections.IEnumerable;
                        if (pList != null)
                        {
                            foreach (var p in pList) { try { pauseExclude.Add(Convert.ToInt32(p)); } catch { } }
                        }
                    }
                    bool didPause = false;
                    if (!_wePausedMedia && AudioMuter.HasActiveOtherSession(pauseExclude))
                    {
                        SendKeyChord(new ushort[0], NativeMethods.VK_MEDIA_PLAY_PAUSE);
                        _wePausedMedia = true;
                        didPause = true;
                    }
                    Reply(id, new Dictionary<string, object> { { "ok", true }, { "paused", didPause } });
                    break;

                case "resume-media":
                    bool didResume = false;
                    if (_wePausedMedia)
                    {
                        _wePausedMedia = false;
                        SendKeyChord(new ushort[0], NativeMethods.VK_MEDIA_PLAY_PAUSE);
                        didResume = true;
                    }
                    Reply(id, new Dictionary<string, object> { { "ok", true }, { "resumed", didResume } });
                    break;

                case "focus-window":
                    long hwndVal = cmd.ContainsKey("hwnd") ? Convert.ToInt64(cmd["hwnd"]) : 0;
                    _uiWindow.BeginInvoke((Action)(() =>
                    {
                        bool focused = false;
                        if (hwndVal != 0)
                        {
                            IntPtr target = new IntPtr(hwndVal);
                            IntPtr fg = NativeMethods.GetForegroundWindow();
                            uint dummy;
                            uint fgTid = fg != IntPtr.Zero ? NativeMethods.GetWindowThreadProcessId(fg, out dummy) : 0;
                            uint curTid = NativeMethods.GetCurrentThreadId();
                            if (fgTid != 0 && fgTid != curTid) NativeMethods.AttachThreadInput(curTid, fgTid, true);
                            NativeMethods.ShowWindow(target, 9 /* SW_RESTORE */);
                            NativeMethods.BringWindowToTop(target);
                            focused = NativeMethods.SetForegroundWindow(target);
                            if (fgTid != 0 && fgTid != curTid) NativeMethods.AttachThreadInput(curTid, fgTid, false);
                        }
                        Reply(id, new Dictionary<string, object> { { "ok", focused } });
                    }));
                    break;

                case "quit":
                    SafeCleanup();
                    Reply(id, new Dictionary<string, object> { { "ok", true } });
                    _uiWindow.BeginInvoke((Action)(() => Application.ExitThread()));
                    break;

                default:
                    Reply(id, new Dictionary<string, object> { { "ok", false }, { "error", "Unknown command: " + name } });
                    break;
            }
        }

        private static void Reply(object id, Dictionary<string, object> payload)
        {
            payload["event"] = "reply";
            if (id != null) payload["id"] = id;
            Emit(payload);
        }

        // ---- Hooks ----
        private static void InstallHooks()
        {
            _kbProc = KeyboardHookCallback;
            _mouseProc = MouseHookCallback;
            using (var curProcess = Process.GetCurrentProcess())
            using (var curModule = curProcess.MainModule)
            {
                IntPtr modHandle = NativeMethods.GetModuleHandle(curModule.ModuleName);
                _kbHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_KEYBOARD_LL, _kbProc, modHandle, 0);
                _mouseHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_MOUSE_LL, _mouseProc, modHandle, 0);
            }
        }

        private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var hook = Marshal.PtrToStructure<NativeMethods.KBDLLHOOKSTRUCT>(lParam);
                bool isInjected = (hook.flags & NativeMethods.LLKHF_INJECTED) != 0;
                if (!isInjected)
                {
                    int msg = wParam.ToInt32();
                    bool isDown = msg == NativeMethods.WM_KEYDOWN || msg == NativeMethods.WM_SYSKEYDOWN;
                    bool isUp = msg == NativeMethods.WM_KEYUP || msg == NativeMethods.WM_SYSKEYUP;
                    int vk = (int)hook.vkCode;

                    bool swallow = false;

                    lock (ShortcutLock)
                    {
                        if (isDown)
                        {
                            bool newlyPressed = PressedVks.Add(vk);

                            if (_captureMode)
                            {
                                CaptureSeenVks.Add(vk);
                                if (!IsModifierVk(vk))
                                {
                                    string label = FormatShortcutFromVks(PressedVks);
                                    Emit(new Dictionary<string, object> { { "event", "captured" }, { "shortcut", label } });
                                    _captureMode = false;
                                    CaptureSeenVks.Clear();
                                }
                            }
                            else
                            {
                                // Suppress CapsLock toggle when bound as PTT standalone
                                if (_ptt.IsStandaloneCapsLock && vk == NativeMethods.VK_CAPITAL && PressedVks.Count == 1)
                                {
                                    swallow = true;
                                }
                                if (SwallowedTriggerVks.Contains(vk))
                                {
                                    swallow = true;
                                }

                                if (newlyPressed)
                                {
                                    if (_cancel != null && _cancel.MatchesExact(PressedVks))
                                    {
                                        Emit(new Dictionary<string, object> { { "event", "cancel-pressed" } });
                                    }
                                    if (_pasteLast != null && _pasteLast.MatchesExact(PressedVks))
                                    {
                                        if (!IsModifierVk(vk)) { swallow = true; SwallowedTriggerVks.Add(vk); }
                                        Emit(new Dictionary<string, object> { { "event", "paste-last-pressed" } });
                                    }
                                    if (_copyLast != null && _copyLast.MatchesExact(PressedVks))
                                    {
                                        if (!IsModifierVk(vk)) { swallow = true; SwallowedTriggerVks.Add(vk); }
                                        Emit(new Dictionary<string, object> { { "event", "copy-last-pressed" } });
                                    }

                                    // Check handsFree before OtherShortcut so Ctrl+Win+Space transitions cleanly
                                    if (_handsFree != null && _handsFree.MatchesExact(PressedVks))
                                    {
                                        if (!IsModifierVk(vk)) { swallow = true; SwallowedTriggerVks.Add(vk); }
                                        if (_pttActive) _pttSwallowedToHandsFree = true;
                                        _pttActive = false;
                                        Emit(new Dictionary<string, object> { { "event", "hands-free-pressed" } });
                                    }
                                    else if (_ptt != null && _ptt.MatchesActive(PressedVks) && !_pttActive && !_pttSwallowedToHandsFree)
                                    {
                                        _pttActive = true;
                                        Emit(new Dictionary<string, object> { { "event", "ptt-down" } });
                                    }
                                    else if (_pttActive && !IsPartOfShortcut(vk, _ptt) && !IsModifierVk(vk))
                                    {
                                        // User pressed another key while holding PTT (e.g. Ctrl+Win+D or arrows)
                                        _pttActive = false;
                                        Emit(new Dictionary<string, object> { { "event", "ptt-other-key" }, { "vk", vk } });
                                    }
                                }
                            }
                        }
                        else if (isUp)
                        {
                            if (_captureMode && CaptureSeenVks.Count > 0 && CaptureSeenVks.All(IsModifierVk) && PressedVks.Count == CaptureSeenVks.Count)
                            {
                                // Modifier-only shortcut finished on first release (e.g. Ctrl+Win)
                                string label = FormatShortcutFromVks(CaptureSeenVks);
                                if (!string.IsNullOrEmpty(label))
                                {
                                    Emit(new Dictionary<string, object> { { "event", "captured" }, { "shortcut", label } });
                                    _captureMode = false;
                                    CaptureSeenVks.Clear();
                                }
                            }

                            if (_ptt.IsStandaloneCapsLock && vk == NativeMethods.VK_CAPITAL)
                            {
                                swallow = true;
                            }
                            if (SwallowedTriggerVks.Remove(vk))
                            {
                                swallow = true;
                            }

                            PressedVks.Remove(vk);

                            if (_pttActive && (_ptt == null || !_ptt.MatchesActive(PressedVks)))
                            {
                                _pttActive = false;
                                Emit(new Dictionary<string, object> { { "event", "ptt-up" } });
                            }

                            if (PressedVks.Count == 0)
                            {
                                _pttSwallowedToHandsFree = false;
                            }
                        }
                    }

                    if (swallow)
                    {
                        return (IntPtr)1;
                    }
                }
            }
            return NativeMethods.CallNextHookEx(_kbHook, nCode, wParam, lParam);
        }

        private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                int vk = 0;
                bool isDown = false;
                bool isUp = false;

                if (msg == NativeMethods.WM_MBUTTONDOWN || msg == NativeMethods.WM_MBUTTONUP)
                {
                    vk = NativeMethods.VK_MBUTTON;
                    isDown = msg == NativeMethods.WM_MBUTTONDOWN;
                    isUp = msg == NativeMethods.WM_MBUTTONUP;
                }
                else if (msg == NativeMethods.WM_XBUTTONDOWN || msg == NativeMethods.WM_XBUTTONUP)
                {
                    var hook = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
                    int xBtn = (int)((hook.mouseData >> 16) & 0xFFFF);
                    vk = xBtn == 1 ? NativeMethods.VK_XBUTTON1 : NativeMethods.VK_XBUTTON2;
                    isDown = msg == NativeMethods.WM_XBUTTONDOWN;
                    isUp = msg == NativeMethods.WM_XBUTTONUP;
                }

                if (vk != 0)
                {
                    lock (ShortcutLock)
                    {
                        if (isDown)
                        {
                            PressedVks.Add(vk);
                            if (_captureMode)
                            {
                                string label = FormatShortcutFromVks(PressedVks);
                                Emit(new Dictionary<string, object> { { "event", "captured" }, { "shortcut", label } });
                                _captureMode = false;
                                CaptureSeenVks.Clear();
                            }
                            else
                            {
                                if (_handsFree != null && _handsFree.MatchesExact(PressedVks))
                                {
                                    Emit(new Dictionary<string, object> { { "event", "hands-free-pressed" } });
                                }
                                else if (_ptt != null && _ptt.MatchesActive(PressedVks) && !_pttActive)
                                {
                                    _pttActive = true;
                                    Emit(new Dictionary<string, object> { { "event", "ptt-down" } });
                                }
                            }
                        }
                        else if (isUp)
                        {
                            PressedVks.Remove(vk);
                            if (_pttActive && (_ptt == null || !_ptt.MatchesActive(PressedVks)))
                            {
                                _pttActive = false;
                                Emit(new Dictionary<string, object> { { "event", "ptt-up" } });
                            }
                        }
                    }
                }
            }
            return NativeMethods.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
        }

        private static bool IsModifierVk(int vk)
        {
            return vk == NativeMethods.VK_LCONTROL || vk == NativeMethods.VK_RCONTROL || vk == NativeMethods.VK_CONTROL
                || vk == NativeMethods.VK_LWIN || vk == NativeMethods.VK_RWIN
                || vk == NativeMethods.VK_LMENU || vk == NativeMethods.VK_RMENU || vk == NativeMethods.VK_MENU
                || vk == NativeMethods.VK_LSHIFT || vk == NativeMethods.VK_RSHIFT || vk == NativeMethods.VK_SHIFT;
        }

        private static bool IsPartOfShortcut(int vk, ParsedShortcut s)
        {
            if (s == null) return false;
            return s.ContainsVk(vk);
        }

        private static string FormatShortcutFromVks(IEnumerable<int> vks)
        {
            var list = vks.ToList();
            var parts = new List<string>();
            if (list.Any(v => v == NativeMethods.VK_LCONTROL || v == NativeMethods.VK_RCONTROL || v == NativeMethods.VK_CONTROL)) parts.Add("Ctrl");
            if (list.Any(v => v == NativeMethods.VK_LWIN || v == NativeMethods.VK_RWIN)) parts.Add("Win");
            if (list.Any(v => v == NativeMethods.VK_LMENU || v == NativeMethods.VK_RMENU || v == NativeMethods.VK_MENU)) parts.Add("Alt");
            if (list.Any(v => v == NativeMethods.VK_LSHIFT || v == NativeMethods.VK_RSHIFT || v == NativeMethods.VK_SHIFT)) parts.Add("Shift");

            foreach (var v in list)
            {
                if (IsModifierVk(v)) continue;
                parts.Add(VkToName(v));
            }
            return string.Join("+", parts);
        }

        private static string VkToName(int vk)
        {
            switch (vk)
            {
                case NativeMethods.VK_SPACE: return "Space";
                case NativeMethods.VK_ESCAPE: return "Esc";
                case NativeMethods.VK_CAPITAL: return "CapsLock";
                case NativeMethods.VK_MBUTTON: return "MiddleClick";
                case NativeMethods.VK_XBUTTON1: return "Mouse4";
                case NativeMethods.VK_XBUTTON2: return "Mouse5";
                case 0x70: return "F1"; case 0x71: return "F2"; case 0x72: return "F3"; case 0x73: return "F4";
                case 0x74: return "F5"; case 0x75: return "F6"; case 0x76: return "F7"; case 0x77: return "F8";
                case 0x78: return "F9"; case 0x79: return "F10"; case 0x7A: return "F11"; case 0x7B: return "F12";
                case 0x7C: return "F13"; case 0x7D: return "F14"; case 0x7E: return "F15"; case 0x7F: return "F16";
                case 0x91: return "ScrollLock";
                case 0x13: return "Pause";
                case 0x2D: return "Insert";
                case 0x09: return "Tab";
                default:
                    if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString();
                    if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();
                    return ((Keys)vk).ToString();
            }
        }

        // ---- Foreground Window ----
        private static readonly HashSet<string> TerminalExes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "windowsterminal.exe", "wt.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
            "conhost.exe", "mintty.exe", "alacritty.exe", "wezterm-gui.exe",
            "kitty.exe", "hyper.exe", "tabby.exe"
        };

        private static Dictionary<string, object> GetForegroundInfo()
        {
            IntPtr hwnd = NativeMethods.GetForegroundWindow();
            string procName = "";
            string title = "";
            if (hwnd != IntPtr.Zero)
            {
                var sb = new StringBuilder(512);
                NativeMethods.GetWindowTextW(hwnd, sb, sb.Capacity);
                title = sb.ToString();

                uint pid;
                NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
                if (pid != 0)
                {
                    try
                    {
                        using (var p = Process.GetProcessById((int)pid))
                        {
                            procName = (p.ProcessName + ".exe").ToLowerInvariant();
                        }
                    }
                    catch { }
                }
            }
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "processName", procName },
                { "title", title },
                { "isTerminal", TerminalExes.Contains(procName) }
            };
        }

        // ---- Clipboard & Auto-Paste ----
        private static void DoPasteText(string text, bool restoreClipboard, bool isTerminal, string terminalMode, int restoreDelayMs)
        {
            if (_restoreTimer != null)
            {
                _restoreTimer.Stop();
                _restoreTimer.Dispose();
                _restoreTimer = null;
            }

            if (restoreClipboard)
            {
                _savedClipboard = ClipboardSnapshot.Capture();
            }
            else
            {
                _savedClipboard = null;
            }

            SetClipboardTextWithExclusions(text);
            _pendingRestoreSeq = NativeMethods.GetClipboardSequenceNumber();

            ReleaseAnyHeldModifiers();
            Thread.Sleep(15);

            if (isTerminal && string.Equals(terminalMode, "shift-insert", StringComparison.OrdinalIgnoreCase))
            {
                SendKeyChord(new ushort[] { NativeMethods.VK_SHIFT }, (ushort)NativeMethods.VK_INSERT);
            }
            else if (isTerminal)
            {
                SendKeyChord(new ushort[] { NativeMethods.VK_CONTROL, NativeMethods.VK_SHIFT }, 0x56 /* V */);
            }
            else
            {
                SendKeyChord(new ushort[] { NativeMethods.VK_CONTROL }, 0x56 /* V */);
            }

            if (restoreClipboard && _savedClipboard != null)
            {
                _restoreTimer = new System.Windows.Forms.Timer { Interval = Math.Max(120, restoreDelayMs) };
                _restoreTimer.Tick += (s, e) =>
                {
                    _restoreTimer.Stop();
                    _restoreTimer.Dispose();
                    _restoreTimer = null;
                    try
                    {
                        if (NativeMethods.GetClipboardSequenceNumber() == _pendingRestoreSeq)
                        {
                            _savedClipboard.Restore();
                        }
                    }
                    catch { }
                    _savedClipboard = null;
                };
                _restoreTimer.Start();
            }
        }

        private static void SetClipboardTextWithExclusions(string text)
        {
            for (int attempt = 0; attempt < 8; attempt++)
            {
                try
                {
                    var data = new DataObject();
                    data.SetData(DataFormats.UnicodeText, true, text);
                    // Exclude from Windows Clipboard History (Win+V), Cloud sync, and clipboard monitors
                    data.SetData("CanIncludeInClipboardHistory", new MemoryStream(BitConverter.GetBytes(0)));
                    data.SetData("CanUploadToCloudClipboard", new MemoryStream(BitConverter.GetBytes(0)));
                    data.SetData("ExcludeClipboardContentFromMonitorProcessing", new MemoryStream(BitConverter.GetBytes(1)));
                    data.SetData("Clipboard Viewer Ignore", new MemoryStream(BitConverter.GetBytes(1)));
                    Clipboard.SetDataObject(data, true, 5, 15);
                    return;
                }
                catch (ExternalException)
                {
                    Thread.Sleep(15);
                }
            }
            throw new InvalidOperationException("Failed to acquire Windows clipboard");
        }

        private static void ReleaseAnyHeldModifiers()
        {
            ushort[] mods =
            {
                NativeMethods.VK_LWIN, NativeMethods.VK_RWIN,
                NativeMethods.VK_LCONTROL, NativeMethods.VK_RCONTROL, NativeMethods.VK_CONTROL,
                NativeMethods.VK_LMENU, NativeMethods.VK_RMENU, NativeMethods.VK_MENU,
                NativeMethods.VK_LSHIFT, NativeMethods.VK_RSHIFT, NativeMethods.VK_SHIFT
            };
            var inputs = new List<NativeMethods.INPUT>();
            foreach (var vk in mods)
            {
                if ((NativeMethods.GetAsyncKeyState(vk) & 0x8000) != 0)
                {
                    inputs.Add(MakeKeyInput(vk, true));
                }
            }
            if (inputs.Count > 0)
            {
                NativeMethods.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<NativeMethods.INPUT>());
            }
        }

        private static void SendKeyChord(ushort[] modifiers, ushort key)
        {
            var inputs = new List<NativeMethods.INPUT>();
            foreach (var m in modifiers) inputs.Add(MakeKeyInput(m, false));
            inputs.Add(MakeKeyInput(key, false));
            inputs.Add(MakeKeyInput(key, true));
            for (int i = modifiers.Length - 1; i >= 0; i--) inputs.Add(MakeKeyInput(modifiers[i], true));
            NativeMethods.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<NativeMethods.INPUT>());
        }

        private static NativeMethods.INPUT MakeKeyInput(ushort vk, bool keyUp)
        {
            uint flags = keyUp ? NativeMethods.KEYEVENTF_KEYUP : 0u;
            if (vk == NativeMethods.VK_INSERT || vk == NativeMethods.VK_LWIN || vk == NativeMethods.VK_RWIN)
            {
                flags |= NativeMethods.KEYEVENTF_EXTENDEDKEY;
            }
            return new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_KEYBOARD,
                u = new NativeMethods.InputUnion
                {
                    ki = new NativeMethods.KEYBDINPUT
                    {
                        wVk = vk,
                        wScan = (ushort)NativeMethods.MapVirtualKey(vk, 0),
                        dwFlags = flags,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };
        }

        private sealed class HelperWindow : NativeWindow, IDisposable
        {
            public HelperWindow()
            {
                CreateHandle(new CreateParams { Caption = "WisperWinHelperHidden" });
            }

            public void BeginInvoke(Action action)
            {
                if (action == null) return;
                var ctx = SynchronizationContext.Current;
                // Marshals via PostMessage to our STA message pump
                NativeMethods.PostMessage(this.Handle, NativeMethods.WM_APP + 42, IntPtr.Zero, GCHandle.ToIntPtr(GCHandle.Alloc(action)));
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == NativeMethods.WM_APP + 42 && m.LParam != IntPtr.Zero)
                {
                    var handle = GCHandle.FromIntPtr(m.LParam);
                    var action = (Action)handle.Target;
                    handle.Free();
                    try { action(); } catch { }
                    return;
                }
                base.WndProc(ref m);
            }

            public void Dispose()
            {
                DestroyHandle();
            }
        }
    }

    internal sealed class ClipboardSnapshot
    {
        private readonly Dictionary<string, object> _items = new Dictionary<string, object>();

        public static ClipboardSnapshot Capture()
        {
            var snap = new ClipboardSnapshot();
            try
            {
                var obj = Clipboard.GetDataObject();
                if (obj == null) return null;
                string[] formats = { DataFormats.UnicodeText, DataFormats.Html, DataFormats.Rtf, DataFormats.FileDrop, DataFormats.Bitmap };
                foreach (var fmt in formats)
                {
                    try
                    {
                        if (obj.GetDataPresent(fmt, false))
                        {
                            var val = obj.GetData(fmt, false);
                            if (val != null) snap._items[fmt] = val;
                        }
                    }
                    catch { }
                }
            }
            catch { return null; }
            return snap;
        }

        public void Restore()
        {
            if (_items.Count == 0)
            {
                try { Clipboard.Clear(); } catch { }
                return;
            }
            var data = new DataObject();
            foreach (var kv in _items)
            {
                data.SetData(kv.Key, false, kv.Value);
            }
            data.SetData("ExcludeClipboardContentFromMonitorProcessing", new MemoryStream(BitConverter.GetBytes(1)));
            data.SetData("CanIncludeInClipboardHistory", new MemoryStream(BitConverter.GetBytes(0)));
            Clipboard.SetDataObject(data, true, 4, 15);
        }
    }

    internal sealed class ParsedShortcut
    {
        public bool NeedCtrl;
        public bool NeedWin;
        public bool NeedAlt;
        public bool NeedShift;
        public readonly HashSet<int> MainVks = new HashSet<int>();
        public bool IsStandaloneCapsLock
        {
            get { return !NeedCtrl && !NeedWin && !NeedAlt && !NeedShift && MainVks.Count == 1 && MainVks.Contains(NativeMethods.VK_CAPITAL); }
        }

        public static ParsedShortcut Parse(string raw)
        {
            var s = new ParsedShortcut();
            if (string.IsNullOrWhiteSpace(raw)) return s;
            foreach (var tokenRaw in raw.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string t = tokenRaw.Trim().ToLowerInvariant();
                if (t == "ctrl" || t == "control" || t == "lctrl" || t == "rctrl") s.NeedCtrl = true;
                else if (t == "win" || t == "meta" || t == "super" || t == "lwin" || t == "rwin") s.NeedWin = true;
                else if (t == "alt" || t == "lalt" || t == "ralt" || t == "rightalt") s.NeedAlt = true;
                else if (t == "shift") s.NeedShift = true;
                else
                {
                    int vk = NameToVk(t);
                    if (vk != 0) s.MainVks.Add(vk);
                }
            }
            return s;
        }

        private static int NameToVk(string t)
        {
            switch (t)
            {
                case "space": return NativeMethods.VK_SPACE;
                case "esc":
                case "escape": return NativeMethods.VK_ESCAPE;
                case "capslock":
                case "caps": return NativeMethods.VK_CAPITAL;
                case "middleclick": return NativeMethods.VK_MBUTTON;
                case "mouse4": return NativeMethods.VK_XBUTTON1;
                case "mouse5": return NativeMethods.VK_XBUTTON2;
                case "scrolllock": return 0x91;
                case "pause": return 0x13;
                case "insert": return 0x2D;
                case "tab": return 0x09;
            }
            int fNum;
            if (t.StartsWith("f") && int.TryParse(t.Substring(1), out fNum) && fNum >= 1 && fNum <= 24)
            {
                return 0x70 + (fNum - 1);
            }
            if (t.Length == 1)
            {
                char c = char.ToUpperInvariant(t[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (int)c;
            }
            return 0;
        }

        public bool ContainsVk(int vk)
        {
            if (NeedCtrl && (vk == NativeMethods.VK_LCONTROL || vk == NativeMethods.VK_RCONTROL || vk == NativeMethods.VK_CONTROL)) return true;
            if (NeedWin && (vk == NativeMethods.VK_LWIN || vk == NativeMethods.VK_RWIN)) return true;
            if (NeedAlt && (vk == NativeMethods.VK_LMENU || vk == NativeMethods.VK_RMENU || vk == NativeMethods.VK_MENU)) return true;
            if (NeedShift && (vk == NativeMethods.VK_LSHIFT || vk == NativeMethods.VK_RSHIFT || vk == NativeMethods.VK_SHIFT)) return true;
            return MainVks.Contains(vk);
        }

        public bool MatchesActive(HashSet<int> pressed)
        {
            if (!NeedCtrl && !NeedWin && !NeedAlt && !NeedShift && MainVks.Count == 0) return false;
            if (NeedCtrl && !HasCtrl(pressed)) return false;
            if (NeedWin && !HasWin(pressed)) return false;
            if (NeedAlt && !HasAlt(pressed)) return false;
            if (NeedShift && !HasShift(pressed)) return false;
            foreach (var vk in MainVks)
            {
                if (!pressed.Contains(vk)) return false;
            }
            return true;
        }

        public bool MatchesExact(HashSet<int> pressed)
        {
            if (!MatchesActive(pressed)) return false;
            foreach (var vk in pressed)
            {
                if (!ContainsVk(vk)) return false;
            }
            return true;
        }

        private static bool HasCtrl(HashSet<int> p) { return p.Contains(NativeMethods.VK_LCONTROL) || p.Contains(NativeMethods.VK_RCONTROL) || p.Contains(NativeMethods.VK_CONTROL); }
        private static bool HasWin(HashSet<int> p) { return p.Contains(NativeMethods.VK_LWIN) || p.Contains(NativeMethods.VK_RWIN); }
        private static bool HasAlt(HashSet<int> p) { return p.Contains(NativeMethods.VK_LMENU) || p.Contains(NativeMethods.VK_RMENU) || p.Contains(NativeMethods.VK_MENU); }
        private static bool HasShift(HashSet<int> p) { return p.Contains(NativeMethods.VK_LSHIFT) || p.Contains(NativeMethods.VK_RSHIFT) || p.Contains(NativeMethods.VK_SHIFT); }
    }

    // ---- Windows Core Audio (WASAPI) per-session muter ----
    internal sealed class WasapiMuter
    {
        private static readonly string CrashStatePath = Path.Combine(Path.GetTempPath(), "wisper-flow-muted-sessions.json");
        private readonly List<string> _mutedSessionIds = new List<string>();
        private readonly object _lock = new object();

        public void RecoverFromCrashFile()
        {
            lock (_lock)
            {
                if (!File.Exists(CrashStatePath)) return;
                try
                {
                    var raw = File.ReadAllText(CrashStatePath);
                    var ids = new JavaScriptSerializer().Deserialize<List<string>>(raw);
                    if (ids != null && ids.Count > 0)
                    {
                        var toRestore = new HashSet<string>(ids);
                        ForEachSession((ctrl2, vol, pid, sessionId) =>
                        {
                            if (toRestore.Contains(sessionId))
                            {
                                Guid ctx = Guid.Empty;
                                vol.SetMute(false, ref ctx);
                            }
                        });
                    }
                }
                catch { }
                try { File.Delete(CrashStatePath); } catch { }
            }
        }

        private void SaveCrashFile()
        {
            try
            {
                if (_mutedSessionIds.Count == 0)
                {
                    if (File.Exists(CrashStatePath)) File.Delete(CrashStatePath);
                }
                else
                {
                    File.WriteAllText(CrashStatePath, new JavaScriptSerializer().Serialize(_mutedSessionIds));
                }
            }
            catch { }
        }

        public bool HasActiveOtherSession(HashSet<int> excludePids)
        {
            bool found = false;
            ForEachSession((ctrl2, vol, pid, sessionId) =>
            {
                if (found || pid == 0 || excludePids.Contains((int)pid)) return;
                int state;
                if (ctrl2.GetState(out state) == 0 && state == 1 /* AudioSessionStateActive */)
                {
                    bool muted;
                    vol.GetMute(out muted);
                    if (!muted) found = true;
                }
            });
            return found;
        }

        public int MuteOthers(HashSet<int> excludePids)
        {
            lock (_lock)
            {
                int newlyMuted = 0;
                ForEachSession((ctrl2, vol, pid, sessionId) =>
                {
                    if (pid == 0 || excludePids.Contains((int)pid)) return;
                    bool alreadyMuted;
                    vol.GetMute(out alreadyMuted);
                    if (!alreadyMuted)
                    {
                        Guid ctx = Guid.Empty;
                        vol.SetMute(true, ref ctx);
                        _mutedSessionIds.Add(sessionId);
                        newlyMuted++;
                    }
                });
                SaveCrashFile();
                return newlyMuted;
            }
        }

        public int UnmuteAll()
        {
            lock (_lock)
            {
                if (_mutedSessionIds.Count == 0)
                {
                    try { if (File.Exists(CrashStatePath)) File.Delete(CrashStatePath); } catch { }
                    return 0;
                }
                var toRestore = new HashSet<string>(_mutedSessionIds);
                _mutedSessionIds.Clear();
                int restored = 0;
                ForEachSession((ctrl2, vol, pid, sessionId) =>
                {
                    if (toRestore.Contains(sessionId))
                    {
                        Guid ctx = Guid.Empty;
                        vol.SetMute(false, ref ctx);
                        restored++;
                    }
                });
                SaveCrashFile();
                return restored;
            }
        }

        private delegate void SessionVisitor(IAudioSessionControl2 ctrl2, ISimpleAudioVolume vol, uint pid, string sessionId);

        private static void ForEachSession(SessionVisitor visitor)
        {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IAudioSessionManager2 mgr = null;
            IAudioSessionEnumerator sessionEnum = null;
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                if (enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 1 /* eMultimedia */, out device) != 0 || device == null)
                {
                    return;
                }
                Guid iidMgr = typeof(IAudioSessionManager2).GUID;
                object mgrObj;
                if (device.Activate(ref iidMgr, 23 /* CLSCTX_ALL */, IntPtr.Zero, out mgrObj) != 0 || mgrObj == null)
                {
                    return;
                }
                mgr = (IAudioSessionManager2)mgrObj;
                if (mgr.GetSessionEnumerator(out sessionEnum) != 0 || sessionEnum == null)
                {
                    return;
                }
                int count;
                sessionEnum.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl ctrl = null;
                    try
                    {
                        sessionEnum.GetSession(i, out ctrl);
                        if (ctrl == null) continue;
                        var ctrl2 = ctrl as IAudioSessionControl2;
                        var vol = ctrl as ISimpleAudioVolume;
                        if (ctrl2 == null || vol == null) continue;
                        uint pid;
                        ctrl2.GetProcessId(out pid);
                        string id;
                        ctrl2.GetSessionInstanceIdentifier(out id);
                        if (!string.IsNullOrEmpty(id))
                        {
                            visitor(ctrl2, vol, pid, id);
                        }
                    }
                    catch { }
                    finally
                    {
                        if (ctrl != null) Marshal.ReleaseComObject(ctrl);
                    }
                }
            }
            catch { }
            finally
            {
                if (sessionEnum != null) Marshal.ReleaseComObject(sessionEnum);
                if (mgr != null) Marshal.ReleaseComObject(mgr);
                if (device != null) Marshal.ReleaseComObject(device);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
        }

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        private class MMDeviceEnumeratorComObject { }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator
        {
            int NotImpl1();
            [PreserveSig]
            int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice
        {
            [PreserveSig]
            int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        }

        [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionManager2
        {
            int NotImpl1();
            int NotImpl2();
            [PreserveSig]
            int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
        }

        [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionEnumerator
        {
            [PreserveSig]
            int GetCount(out int SessionCount);
            [PreserveSig]
            int GetSession(int SessionCount, out IAudioSessionControl Session);
        }

        [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionControl
        {
            int NotImpl0();
        }

        [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionControl2
        {
            // IAudioSessionControl base methods (9 slots)
            [PreserveSig] int GetState(out int pRetVal);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
            [PreserveSig] int GetGroupingParam(out Guid pRetVal);
            [PreserveSig] int SetGroupingParam(ref Guid Override, ref Guid EventContext);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr NewNotifications);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr NewNotifications);
            // IAudioSessionControl2 methods
            [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            [PreserveSig] int GetProcessId(out uint pRetVal);
            [PreserveSig] int IsSystemSoundsSession();
            [PreserveSig] int SetDuckingPreference(bool optOut);
        }

        [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ISimpleAudioVolume
        {
            [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
            [PreserveSig] int GetMasterVolume(out float pfLevel);
            [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
            [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
        }
    }

    internal static class NativeMethods
    {
        public const int WH_KEYBOARD_LL = 13;
        public const int WH_MOUSE_LL = 14;
        public const int WM_KEYDOWN = 0x0100;
        public const int WM_KEYUP = 0x0101;
        public const int WM_SYSKEYDOWN = 0x0104;
        public const int WM_SYSKEYUP = 0x0105;
        public const int WM_MBUTTONDOWN = 0x0207;
        public const int WM_MBUTTONUP = 0x0208;
        public const int WM_XBUTTONDOWN = 0x020B;
        public const int WM_XBUTTONUP = 0x020C;
        public const int WM_APP = 0x8000;
        public const uint LLKHF_INJECTED = 0x00000010;

        public const int VK_MBUTTON = 0x04;
        public const int VK_XBUTTON1 = 0x05;
        public const int VK_XBUTTON2 = 0x06;
        public const int VK_SHIFT = 0x10;
        public const int VK_CONTROL = 0x11;
        public const int VK_MENU = 0x12;
        public const int VK_CAPITAL = 0x14;
        public const int VK_ESCAPE = 0x1B;
        public const int VK_SPACE = 0x20;
        public const int VK_INSERT = 0x2D;
        public const int VK_LWIN = 0x5B;
        public const int VK_RWIN = 0x5C;
        public const int VK_LSHIFT = 0xA0;
        public const int VK_RSHIFT = 0xA1;
        public const int VK_LCONTROL = 0xA2;
        public const int VK_RCONTROL = 0xA3;
        public const int VK_LMENU = 0xA4;
        public const int VK_RMENU = 0xA5;
        public const ushort VK_MEDIA_PLAY_PAUSE = 0xB3;

        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;

        public delegate IntPtr LowLevelHookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion u;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT
        {
            public uint uMsg; public ushort wParamL; public ushort wParamH;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelHookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        public static extern uint GetClipboardSequenceNumber();

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
    }
}
